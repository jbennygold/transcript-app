import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { list, put } from '@vercel/blob';
import { fetchBlobJson, MUTABLE_BLOB_CACHE_MAX_AGE } from '../src/lib/blob-storage';
import type { QueryLogEntry } from '../src/lib/query-logger';

interface FeedbackEntry {
  id: string;
  timestamp: string;
  query: string;
  rating: 'good' | 'bad';
  comment?: string;
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  // 1. Load all feedback entries
  console.log('Loading feedback entries...');
  const feedbackBlobs: { url: string }[] = [];
  let cursor: string | undefined;
  do {
    const result = await list({ prefix: 'feedback-log/', cursor, token: process.env.BLOB_READ_WRITE_TOKEN });
    for (const blob of result.blobs) feedbackBlobs.push({ url: blob.url });
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  const feedbackEntries: FeedbackEntry[] = [];
  for (const blob of feedbackBlobs) {
    try {
      const res = await fetch(blob.url);
      feedbackEntries.push((await res.json()) as FeedbackEntry);
    } catch { /* skip */ }
  }
  console.log(`Found ${feedbackEntries.length} feedback entries.`);

  // 2. Load all query log entries (need to scan all months that have feedback)
  const months = new Set(feedbackEntries.map((f) => f.timestamp.slice(0, 7)));
  console.log(`Scanning query-log months: ${[...months].join(', ')}`);

  const queryLogs: { entry: QueryLogEntry; pathname: string }[] = [];
  for (const month of months) {
    const prefix = `query-log/${month}/`;
    let cur: string | undefined;
    do {
      const result = await list({ prefix, cursor: cur, token: process.env.BLOB_READ_WRITE_TOKEN });
      const batch = await Promise.all(
        result.blobs.map(async (blob) => {
          try {
            // Size-verified: these entries are read, modified and written back,
            // so a stale copy would drop fields added since (e.g. useCaseLLM).
            const loaded = await fetchBlobJson<QueryLogEntry>(blob.url, blob.size, 'fast');
            if (!loaded) return null;
            return { entry: loaded.data, pathname: blob.pathname };
          } catch {
            return null;
          }
        })
      );
      for (const item of batch) {
        if (item) queryLogs.push(item);
      }
      cur = result.hasMore ? result.cursor : undefined;
    } while (cur);
  }
  console.log(`Loaded ${queryLogs.length} query log entries.\n`);

  // 3. Match feedback to query logs by exact query text + timestamp within 5 min
  let linked = 0;
  let alreadyRated = 0;
  let noMatch = 0;

  for (const fb of feedbackEntries) {
    const fbTs = new Date(fb.timestamp).getTime();
    const fbQuery = fb.query.toLowerCase().trim();

    // Find query logs with matching text, within 5 minutes before the feedback
    const candidates = queryLogs.filter((ql) => {
      const qlTs = new Date(ql.entry.timestamp).getTime();
      const diff = fbTs - qlTs;
      return diff >= 0 && diff < 5 * 60 * 1000 && ql.entry.query.toLowerCase().trim() === fbQuery;
    });

    if (candidates.length === 0) {
      // Try wider window (30 min) and substring match
      const wider = queryLogs.filter((ql) => {
        const qlTs = new Date(ql.entry.timestamp).getTime();
        const diff = fbTs - qlTs;
        return diff >= 0 && diff < 30 * 60 * 1000 && ql.entry.query.toLowerCase().trim() === fbQuery;
      });
      if (wider.length === 0) {
        console.log(`  NO MATCH: "${fb.query.slice(0, 60)}" (${fb.timestamp})`);
        noMatch++;
        continue;
      }
      candidates.push(...wider);
    }

    // Pick the closest match
    const best = candidates.sort((a, b) => {
      const aD = Math.abs(fbTs - new Date(a.entry.timestamp).getTime());
      const bD = Math.abs(fbTs - new Date(b.entry.timestamp).getTime());
      return aD - bD;
    })[0];

    if (best.entry.rating) {
      alreadyRated++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  MATCH: "${fb.query.slice(0, 60)}" → ${best.entry.id} (${fb.rating})`);
    } else {
      best.entry.rating = fb.rating;
      if (fb.comment) best.entry.comment = fb.comment;
      try {
        await put(best.pathname, JSON.stringify(best.entry), {
          access: 'public',
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        console.log(`  LINKED: "${fb.query.slice(0, 60)}" → ${best.entry.id} (${fb.rating})`);
      } catch (err) {
        console.warn(`  FAILED: ${best.entry.id}: ${err}`);
      }
    }
    linked++;
  }

  console.log(`\nDone${DRY_RUN ? ' (dry run)' : ''}. Linked: ${linked}, Already rated: ${alreadyRated}, No match: ${noMatch}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
