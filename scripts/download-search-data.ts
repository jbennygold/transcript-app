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

    const response = await fetch(match.url);
    if (!response.ok) {
      console.error(`  ✗ Failed to download ${fileName}: ${response.status}`);
      continue;
    }

    const data = await response.text();
    const localPath = path.join(process.cwd(), fileName);
    fs.writeFileSync(localPath, data);
    const sizeMB = (Buffer.byteLength(data, 'utf-8') / (1024 * 1024)).toFixed(2);
    console.log(`  ✓ ${fileName} (${sizeMB} MB)`);
  }

  console.log('\n✓ Download complete.');
}

downloadSearchData().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
