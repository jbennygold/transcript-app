import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Like run(), but a non-zero exit is logged and tolerated rather than failing
// the build. Used for best-effort steps (cache warming) where a failure should
// only cost extra work, never break the deploy.
function runAllowFail(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    console.warn(`Build: '${command} ${args.join(' ')}' exited ${result.status} — continuing.`);
  }
}

// Skip re-ingestion when transcripts haven't changed.
// The ingest script fingerprints local + blob transcripts and compares against
// a stored manifest — only re-embeds when the hash differs.
// Override with SKIP_INGEST_IF_NO_NEW=0 to force re-ingest.
if (process.env.SKIP_INGEST_IF_NO_NEW !== '0') {
  process.env.SKIP_INGEST_IF_NO_NEW = '1';
  console.log('Build: skipping embeddings when transcripts are unchanged (override with SKIP_INGEST_IF_NO_NEW=0).');
}

// Restore the Haiku-extraction caches (topic + playlist) from Blob before
// ingest so the song-extraction pass — which is NOT gated by --skip-topics and
// runs whenever transcripts change — hits cache instead of re-calling Haiku over
// every episode transcript. Caches-only to avoid pulling the large index files
// into the working dir during `next build` (file tracing / 250MB limit).
// Best-effort: a cold or unreachable cache must not fail the deploy.
runAllowFail('node', ['--import', 'tsx', './scripts/download-search-data.ts', '--caches-only']);

run('npm', ['run', 'ingest', '--', '--skip-topics']);

// Only upload if ingest produced new data files (they're gitignored, so they
// only exist when ingest actually ran and generated embeddings)
if (existsSync('vector-store.json') || existsSync('bm25-index.json')) {
  run('npm', ['run', 'upload-search-data']);
} else {
  console.log('Build: no new search data files — skipping upload.');
}

// Delete large search data files before next build so Next.js file tracing
// doesn't bundle them into serverless functions (would exceed 250MB limit).
// These live in Vercel Blob at runtime and are downloaded on cold start.
const BIG_FILES = ['vector-store.json', 'bm25-index.json', 'topic-vectors.json', 'topic-cache.json'];
for (const f of BIG_FILES) {
  if (existsSync(f)) {
    unlinkSync(f);
    console.log(`Build: removed ${f} from working dir before next build.`);
  }
}

// Note: bundle step removed. src/lib/metadata-data.ts is maintained directly
// by sync-metadata.ts (via GitHub Action) and committed to git.
// The old bundle-data.ts would overwrite it with stale data/episode-metadata.json.
