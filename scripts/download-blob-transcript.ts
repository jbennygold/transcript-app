/**
 * Download a transcript from Vercel Blob to the local transcripts/ directory.
 * Used in CI to fetch the latest speaker-mapped version before ingest.
 *
 * Usage: npx tsx scripts/download-blob-transcript.ts <episode_number>
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { loadTranscriptChecked } from '../src/lib/blob-storage';

dotenv.config({ path: '.env.local' });

const raw = (process.argv[2] || '').replace(/^episode_/, '');
const episodeNum = parseInt(raw, 10);
if (!episodeNum || isNaN(episodeNum)) {
  console.error('Usage: npx tsx scripts/download-blob-transcript.ts <episode_number>');
  process.exit(1);
}

async function main() {
  // 'patient': this file feeds the search index, so a stale copy silently
  // indexes the pre-speaker-mapping transcript (which is exactly what happened
  // to ep 317). Better to wait out the CDN TTL, and better still to fail loudly
  // than to write a copy we can't confirm is current.
  const result = await loadTranscriptChecked(episodeNum, 'patient');
  if (!result) {
    console.error(`Transcript for episode ${episodeNum} not found in Blob`);
    process.exit(1);
  }

  if (!result.fresh) {
    console.error(
      `Blob CDN kept serving a stale copy of episode ${episodeNum}; refusing to ingest it. Re-run in a few minutes.`
    );
    process.exit(1);
  }

  const transcript = result.data;
  const dir = path.join(process.cwd(), 'transcripts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const outPath = path.join(dir, `episode_${episodeNum}.json`);
  fs.writeFileSync(outPath, JSON.stringify(transcript, null, 2));
  console.log(`Downloaded episode ${episodeNum} transcript from Blob to ${outPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
