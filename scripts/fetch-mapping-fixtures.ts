/**
 * Pulls paired raw/mapped transcripts from Blob for speaker-proposal validation.
 *
 * Blob is canonical for mapped transcripts. The git copies under transcripts/
 * are stale and mostly still hold placeholder labels — do NOT use them as
 * ground truth.
 *
 *   npx tsx scripts/fetch-mapping-fixtures.ts            # all pairs -> /tmp
 *   npx tsx scripts/fetch-mapping-fixtures.ts 317 315 303 --commit
 *
 * --commit writes into src/lib/fixtures/speaker-mapping/ for the unit tests.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { list } from '@vercel/blob';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const COMMIT_DIR = path.join(process.cwd(), 'src/lib/fixtures/speaker-mapping');
const SCRATCH_DIR = '/tmp/speaker-mapping-fixtures';

async function fetchJson(url: string, expectedSize: number): Promise<unknown> {
  const resp = await fetch(url, { cache: 'no-store' });
  const buf = Buffer.from(await resp.arrayBuffer());
  // Blob serves overwritten objects stale from the CDN; verify against list().
  if (Math.abs(buf.length - expectedSize) > 8) {
    throw new Error(`size mismatch: got ${buf.length}, expected ${expectedSize}`);
  }
  return JSON.parse(buf.toString());
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const wanted = args.filter((a) => /^\d+$/.test(a)).map(Number);
  const outDir = commit ? COMMIT_DIR : SCRATCH_DIR;
  mkdirSync(outDir, { recursive: true });

  const all = await list({ prefix: 'transcripts/', limit: 1000 });
  const raws = all.blobs.filter((b) => b.pathname.startsWith('transcripts/raw/'));

  for (const rawBlob of raws) {
    const file = rawBlob.pathname.split('/').pop()!;
    const ep = Number(file.match(/\d+/)?.[0]);
    if (wanted.length && !wanted.includes(ep)) continue;

    const mappedBlob = all.blobs.find((b) => b.pathname === `transcripts/${file}`);
    if (!mappedBlob) {
      console.log(`ep${ep}: no mapped counterpart, skipping`);
      continue;
    }

    const raw = (await fetchJson(rawBlob.url, rawBlob.size)) as { dialogues: unknown[] };
    const mapped = (await fetchJson(mappedBlob.url, mappedBlob.size)) as { dialogues: unknown[] };

    if (raw.dialogues.length !== mapped.dialogues.length) {
      console.log(`ep${ep}: NOT ALIGNED (${raw.dialogues.length} vs ${mapped.dialogues.length}), skipping`);
      continue;
    }

    writeFileSync(path.join(outDir, `episode_${ep}.raw.json`), JSON.stringify(raw.dialogues));
    writeFileSync(path.join(outDir, `episode_${ep}.mapped.json`), JSON.stringify(mapped.dialogues));
    console.log(`ep${ep}: ${raw.dialogues.length} turns -> ${outDir}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
