/**
 * Download search index files from Vercel Blob to local disk.
 * Used in CI before running incremental ingest (--episode).
 *
 * Usage:
 *   npx tsx scripts/download-search-data.ts               # index files + Haiku caches
 *   npx tsx scripts/download-search-data.ts --caches-only # only the Haiku caches
 *
 * The `--caches-only` mode restores just the LLM-extraction caches
 * (topic-cache.json, playlist-cache.json). It's used in the Vercel build path,
 * which must NOT pull the large index files (they'd get traced into serverless
 * functions and blow the 250MB limit) but still wants warm caches so ingest
 * doesn't re-run Haiku over the whole corpus. See also upload-search-data.ts.
 *
 * Every download is size-checked against the blob's current metadata, and a
 * mismatch is fatal. This is a read-modify-write cycle: ingest loads the index,
 * splices in one episode, and uploads the whole thing back. Starting from a
 * stale copy therefore does not just mis-ingest the current episode — it
 * REVERTS every other episode's chunks to whatever that stale copy held, and
 * reports success.
 *
 * That is not hypothetical. A 2026-08-05 ep 317 ingest downloaded an index a day
 * out of date (it saw 34 chunks for the episode when the previous run had left
 * 17). Vercel Blob serves overwritten objects from a CDN edge that keeps the old
 * body until its TTL expires; `fetch()` cannot opt out, and a query-string
 * cache-buster does not work either (the CDN does not vary on the query). The
 * metadata from `list()` is NOT CDN-cached, so its `size` is a trustworthy
 * oracle for whether the bytes we got are current.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { list } from '@vercel/blob';

dotenv.config({ path: '.env.local' });

const SEARCH_DATA_PREFIX = 'search-data/';

const INDEX_FILES = [
  'vector-store.json',
  'bm25-index.json',
  'topic-vectors.json',
];

// LLM-extraction caches (content-hash keyed). Restoring these before ingest is
// what keeps a re-ingest from re-paying full Haiku cost for content already
// summarized — a cold cache costs ~$20/full pass in Haiku calls.
const CACHE_FILES = [
  'topic-cache.json',
  'playlist-cache.json',
];

// Long enough to outlast the 5-minute cache-control we now write these with,
// so a genuinely-propagating edge gets a chance to catch up before we fail.
const STALE_ATTEMPTS = 40;
const STALE_DELAY_MS = 10_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Download one blob, retrying while the CDN serves bytes that disagree with the
 * size reported by list(). Returns null if it never converges.
 *
 * Buffers rather than decoding to a string: these files reach ~250MB, and
 * `response.text()` would add a second full-size copy for no reason. The Buffer
 * goes straight to disk.
 */
async function downloadVerified(
  url: string,
  expectedSize: number,
  fileName: string
): Promise<Buffer | null> {
  for (let attempt = 0; attempt < STALE_ATTEMPTS; attempt++) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      console.error(`  ✗ Failed to download ${fileName}: ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === expectedSize) return buffer;

    console.warn(
      `  ⚠ ${fileName}: CDN served ${buffer.byteLength}B, expected ${expectedSize}B — stale edge copy, retrying`
    );
    if (attempt < STALE_ATTEMPTS - 1) await sleep(STALE_DELAY_MS);
  }
  return null;
}

async function downloadSearchData() {
  const cachesOnly = process.argv.includes('--caches-only');
  const files = cachesOnly ? CACHE_FILES : [...INDEX_FILES, ...CACHE_FILES];
  console.log(
    `Downloading ${cachesOnly ? 'Haiku caches' : 'search data'} from Vercel Blob...\n`,
  );

  const blobs = await list({ prefix: SEARCH_DATA_PREFIX });

  for (const fileName of files) {
    const blobPath = `${SEARCH_DATA_PREFIX}${fileName}`;
    const match = blobs.blobs.find(b => b.pathname === blobPath);

    if (!match) {
      console.log(`  ⚠ ${fileName} not found in Blob — skipping`);
      continue;
    }

    const data = await downloadVerified(match.url, match.size, fileName);
    if (!data) {
      // Fatal, not skippable: ingest would rebuild from a stale index and
      // upload it back, silently reverting every other episode.
      console.error(
        `\n✗ Could not obtain a current copy of ${fileName} — the Blob CDN kept serving a stale body.\n` +
          `  Refusing to continue, since ingesting from a stale index would revert other episodes.\n` +
          `  Re-run in a few minutes.`
      );
      process.exit(1);
    }

    const localPath = path.join(process.cwd(), fileName);
    fs.writeFileSync(localPath, data);
    console.log(`  ✓ ${fileName} (${(data.byteLength / (1024 * 1024)).toFixed(2)} MB)`);
  }

  console.log('\n✓ Download complete.');
}

downloadSearchData().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
