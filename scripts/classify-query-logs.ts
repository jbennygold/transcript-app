import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { list, put } from '@vercel/blob';
import { fetchBlobJson, MUTABLE_BLOB_CACHE_MAX_AGE } from '../src/lib/blob-storage';
import Anthropic from '@anthropic-ai/sdk';
import { UC_LABELS } from '../src/lib/use-case-classifier';
import type { QueryLogEntry } from '../src/lib/query-logger';

const QUERY_LOG_PREFIX = 'query-log/';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const RATE_LIMIT_MS = 50;

// ── Helpers ──────────────────────────────────────────────────────────

function parseArgs(): { month?: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let month: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--month' && args[i + 1]) {
      month = args[i + 1];
      i++;
    }
    if (args[i] === '--dry-run') dryRun = true;
  }
  return { month, dryRun };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const UC_CODES = Object.keys(UC_LABELS);

const UC_DESCRIPTIONS: Record<string, string> = {
  'UC-1': 'Looking up a specific episode by film title, number, or date',
  'UC-2': 'Listing or filtering episodes by metadata (director, year, genre, etc.)',
  'UC-3': 'Asking about the hosts\' opinion on a specific film',
  'UC-4': 'Attributing a statement or opinion to a specific host (no film scope)',
  'UC-5': 'Cross-episode thematic question (recurring themes, comparisons, patterns)',
  'UC-6': 'Cross-episode entity tracking or exhaustive listing',
  'UC-7': 'Personal or lifestyle question about hosts (food, hobbies, appearance)',
  'UC-8': 'About voicemails, letters, or recurring listener segments',
  'UC-9': 'Counting or frequency question (how many times, how often)',
  'UC-10': 'Catchphrases, verbal tics, or recurring phrases',
  'UC-11': 'Looking up a specific quote or phrase from the podcast',
  'UC-12': 'Factual question with specific filters (not interpretive)',
  'UC-13': 'Question scoped to a guest appearance',
  'UC-14': 'Meta-question about the podcast itself (format, history, catalog)',
};

function buildPrompt(entry: QueryLogEntry): string {
  const ucList = UC_CODES.map(
    (code) => `${code}: ${UC_LABELS[code]} — ${UC_DESCRIPTIONS[code]}`
  ).join('\n');

  const signals: string[] = [];
  if (entry.classification?.type) signals.push(`classification_type: ${entry.classification.type}`);
  if (entry.classification?.filters && Object.keys(entry.classification.filters).length > 0) {
    signals.push(`filters: ${JSON.stringify(entry.classification.filters)}`);
  }
  if (entry.intent?.type) signals.push(`intent: ${entry.intent.type}`);
  if (entry.routingPath) signals.push(`routing_path: ${entry.routingPath}`);
  if (entry.searchStrategy) signals.push(`search_strategy: ${entry.searchStrategy}`);

  return `Classify this podcast search query into exactly one use case.

Use cases:
${ucList}

Query: "${entry.query}"
${signals.length > 0 ? `Signals:\n${signals.join('\n')}` : ''}

Respond with ONLY the use case code, e.g. UC-3`;
}

function extractUCCode(text: string): string | null {
  const match = text.match(/UC-\d+/);
  if (!match) return null;
  return UC_CODES.includes(match[0]) ? match[0] : null;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { month, dryRun } = parseArgs();
  const prefix = month ? `${QUERY_LOG_PREFIX}${month}/` : QUERY_LOG_PREFIX;

  console.log(`Listing blobs under "${prefix}"${dryRun ? ' (dry run)' : ''}…`);

  // Collect all blob references
  const blobs: { url: string; pathname: string }[] = [];
  let cursor: string | undefined;
  do {
    const result = await list({
      prefix,
      cursor,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    for (const blob of result.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname });
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  console.log(`Found ${blobs.length} log entries.`);
  if (blobs.length === 0) return;

  const anthropic = new Anthropic();
  let classified = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i];

    // Fetch entry. Size-verified: this is a read-modify-write, and a stale copy
    // would be written back with useCaseLLM set but any rating added since
    // dropped.
    let entry: QueryLogEntry;
    try {
      const loaded = await fetchBlobJson<QueryLogEntry>(blob.url, blob.size, 'fast');
      if (!loaded) throw new Error('could not read a current copy');
      entry = loaded.data;
    } catch (err) {
      console.warn(`  ⚠ Failed to fetch ${blob.pathname}: ${err}`);
      errors++;
      continue;
    }

    // Skip if already classified
    if (entry.useCaseLLM) {
      skipped++;
      if ((skipped + classified) % 10 === 0) {
        console.log(`Classified ${classified}/${blobs.length} (${skipped} skipped)`);
      }
      continue;
    }

    // Call Haiku
    const prompt = buildPrompt(entry);
    let ucCode: string | null = null;
    try {
      const response = await anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: prompt }],
      });
      const text =
        response.content[0]?.type === 'text' ? response.content[0].text : '';
      ucCode = extractUCCode(text.trim());
    } catch (err) {
      console.warn(`  ⚠ Haiku call failed for ${entry.id}: ${err}`);
      errors++;
      continue;
    }

    if (!ucCode) {
      console.warn(`  ⚠ Unparseable response for "${entry.query}" (${entry.id}), skipping`);
      errors++;
      continue;
    }

    if (dryRun) {
      console.log(`  ${ucCode} ← "${entry.query}"`);
    } else {
      // Merge and re-upload
      entry.useCaseLLM = ucCode;
      try {
        await put(blob.pathname, JSON.stringify(entry), {
          access: 'public',
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
      } catch (err) {
        console.warn(`  ⚠ Failed to upload ${blob.pathname}: ${err}`);
        errors++;
        continue;
      }
    }

    classified++;
    if ((skipped + classified) % 10 === 0) {
      console.log(`Classified ${classified}/${blobs.length} (${skipped} skipped)`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(
    `\nDone. Classified: ${classified}, Skipped (already tagged): ${skipped}, Errors: ${errors}`
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
