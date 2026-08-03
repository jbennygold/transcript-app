#!/usr/bin/env node
/**
 * check-new-episodes.ts — Orchestrator for detecting and processing new episodes.
 *
 * Flow:
 *   0. Service-account key shim (for CI)
 *   1. Sync metadata from Google Sheets
 *   2. Detect new episodes (metadata vs Blob transcripts)
 *   3. Download audio from Google Drive
 *   4. Transcribe via AssemblyAI
 *   5. Report results (GitHub Actions summary + stdout)
 *
 * CLI flags:
 *   --dry-run      Run detection only, skip download/transcribe
 *   --detect-only  Same as --dry-run (alias)
 *   --verbose      Show child-process output in real time
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { episodeSortKey, type EpisodeId } from '../src/lib/episode-format';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('--detect-only');
const verbose = args.includes('--verbose');
const includeBackfill = args.includes('--include-backfill');
const lookbackDaysArg = args.find(a => a.startsWith('--lookback-days='));
const lookbackDays = lookbackDaysArg ? Math.max(0, parseInt(lookbackDaysArg.split('=')[1], 10) || 45) : 45;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[check-new-episodes] ${msg}`);
}

function run(cmd: string, label: string): boolean {
  log(`Running: ${label}`);
  try {
    execSync(cmd, {
      stdio: verbose ? 'inherit' : 'pipe',
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env },
      timeout: 60 * 60 * 1000, // 60 min (transcription can be slow)
    });
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FAILED: ${label} — ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 0: Service-account key shim (CI only)
// ---------------------------------------------------------------------------

function setupServiceAccountShim() {
  const hasJson = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  const hasFile = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  log(`Service account: KEY_JSON=${hasJson}, KEY_FILE=${hasFile}`);

  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    const tmpPath = path.join(os.tmpdir(), 'gcp-sa-key.json');
    fs.writeFileSync(tmpPath, process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON, { mode: 0o600 });
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = tmpPath;
    log(`Wrote service-account key to ${tmpPath}`);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Detect new episodes
// ---------------------------------------------------------------------------

interface NewEpisode {
  episode: EpisodeId;
  film: string;
  downloaded: boolean;
  transcribed: boolean;
  error?: string;
}

function normalizeEpisodeId(id: EpisodeId): string {
  return String(id).trim().toLowerCase();
}

function parseEpisodeId(id: string): EpisodeId {
  return /^\d+$/.test(id) ? parseInt(id, 10) : id;
}

function isRecentRelease(releaseDate: string): boolean {
  if (!releaseDate) return false;
  const date = new Date(releaseDate);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  const daysAgo = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
  return daysAgo >= 0 && daysAgo <= lookbackDays;
}

async function detectNewEpisodes(): Promise<NewEpisode[]> {
  const { loadEpisodeMetadata } = await import('../src/lib/metadata-store');
  const { listBlobTranscripts } = await import('../src/lib/blob-storage');

  const metadata = loadEpisodeMetadata();

  // Collect episode ids from BOTH sources (matching coverage API logic)
  const existingIds = new Set<string>();

  // 1. Filesystem transcripts (committed to repo, available in CI)
  const transcriptsDir = path.resolve(__dirname, '..', 'transcripts');
  try {
    if (fs.existsSync(transcriptsDir)) {
      for (const file of fs.readdirSync(transcriptsDir)) {
        const match = file.match(/^episode_(.+)\.json$/);
        if (match) existingIds.add(match[1].trim().toLowerCase());
      }
    }
  } catch {
    // Directory doesn't exist — fine in some environments
  }
  log(`Found ${existingIds.size} filesystem transcripts`);

  // 2. Blob storage transcripts
  try {
    const blobTranscripts = await listBlobTranscripts();
    for (const b of blobTranscripts) {
      const match = b.pathname.match(/episode_(.+)\.json$/);
      if (match) existingIds.add(match[1].trim().toLowerCase());
    }
    log(`Total unique transcripts (filesystem + blob): ${existingIds.size}`);
  } catch {
    log('Warning: could not list blob transcripts — checking filesystem only');
  }

  const newEpisodes = metadata
    .filter(ep => !existingIds.has(normalizeEpisodeId(ep.episode)))
    .map(ep => ({
      episode: ep.episode,
      film: ep.film,
      releaseDate: ep.releaseDate,
      downloaded: false,
      transcribed: false,
    }));

  if (includeBackfill) {
    return newEpisodes.map(({ releaseDate: _releaseDate, ...rest }) => rest);
  }

  const existingSortKeys = [...existingIds].map(id => episodeSortKey(parseEpisodeId(id)));
  const maxExistingSortKey = existingSortKeys.length > 0 ? Math.max(...existingSortKeys) : 0;

  const filtered = newEpisodes.filter(ep =>
    episodeSortKey(ep.episode) > maxExistingSortKey || isRecentRelease(ep.releaseDate)
  );

  log(
    `Filtered historical backfill: ${newEpisodes.length - filtered.length} skipped, ` +
    `${filtered.length} candidate(s) remain (lookback ${lookbackDays}d)`
  );

  return filtered.map(({ releaseDate: _releaseDate, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Step 5: Report
// ---------------------------------------------------------------------------

function generateReport(episodes: NewEpisode[], syncFailed: boolean): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`# New Episode Check — ${date}`);
  lines.push('');

  if (syncFailed) {
    lines.push('## Error');
    lines.push('Metadata sync failed. Remaining steps were skipped.');
    lines.push('Check the workflow logs for details.');
    return lines.join('\n');
  }

  if (episodes.length === 0) {
    lines.push('## Summary');
    lines.push('No new episodes detected. Everything is up to date.');
    return lines.join('\n');
  }

  const downloaded = episodes.filter(e => e.downloaded).length;
  const transcribed = episodes.filter(e => e.transcribed).length;
  const failed = episodes.filter(e => !e.transcribed && e.downloaded).length;
  const needsMapping = episodes.filter(e => e.transcribed);

  lines.push('## Summary');
  lines.push(`- **New episodes detected**: ${episodes.length}`);
  lines.push(`- **Audio downloaded**: ${downloaded}`);
  lines.push(`- **Transcribed**: ${transcribed}`);
  if (failed > 0) lines.push(`- **Failed**: ${failed}`);
  lines.push('');

  lines.push('## Episodes');
  lines.push('');
  lines.push('| Episode | Film | Downloaded | Transcribed | Notes |');
  lines.push('|---------|------|-----------|-------------|-------|');
  for (const ep of episodes) {
    const dl = ep.downloaded ? 'Yes' : 'No';
    const tr = ep.transcribed ? 'Yes' : 'No';
    let notes = '';
    if (ep.transcribed) notes = 'Needs speaker mapping';
    else if (ep.error) notes = ep.error;
    else if (ep.downloaded && !ep.transcribed) notes = 'Transcription failed';
    else if (!ep.downloaded) notes = 'Audio not found in Drive';
    lines.push(`| ${ep.episode} | ${ep.film} | ${dl} | ${tr} | ${notes} |`);
  }
  lines.push('');

  if (needsMapping.length > 0) {
    lines.push('## Action Required');
    for (const ep of needsMapping) {
      lines.push(`- Episode ${ep.episode} needs speaker mapping: [Review](/review/${ep.episode})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function writeReport(report: string) {
  // GitHub Actions job summary
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, report + '\n');
    log('Wrote GitHub Actions job summary');
  }

  // Always print to stdout
  console.log('\n' + report);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(dryRun ? 'Starting (dry-run mode)' : 'Starting');
  if (!includeBackfill) {
    log(`Backfill filter enabled (lookback ${lookbackDays} days). Use --include-backfill to disable.`);
  }

  // Step 0: Service-account shim
  setupServiceAccountShim();

  // Step 1: Sync metadata
  const syncOk = run('npm run sync-metadata', 'sync-metadata');
  if (!syncOk) {
    writeReport(generateReport([], true));
    process.exit(1);
  }

  // Step 2: Detect new episodes
  log('Detecting new episodes...');
  const episodes = await detectNewEpisodes();
  log(`Found ${episodes.length} new episode(s)`);

  // Tier 1: fill deterministic sheet columns. Runs before the no-new-episodes
  // early exit so scheduled passes keep filling rows whose Spotify/Patreon
  // entries did not exist yet at first detection. Non-fatal by design — a
  // source-API outage must never fail the run.
  if (!dryRun) {
    run('npm run populate-tier1 -- --fill-gaps', 'populate-tier1 (--fill-gaps)');
  }

  if (episodes.length === 0) {
    writeReport(generateReport(episodes, false));
    process.exit(0);
  }

  if (dryRun) {
    log('Dry-run mode — skipping download and transcription');
    for (const ep of episodes) {
      log(`  Episode ${ep.episode}: ${ep.film}`);
    }
    writeReport(generateReport(episodes, false));
    process.exit(0);
  }

  const episodeNumbers = episodes.map(e => e.episode);
  const episodeList = episodeNumbers.join(',');

  // Step 3: Download audio
  const dlOk = run(
    `npm run download-audio -- --episodes=${episodeList}`,
    `download-audio (${episodeList})`
  );

  // Check which episodes actually got an MP3 (filenames are {number}.mp3)
  const mp3Dir = path.resolve(__dirname, '..', 'mp3s');
  if (dlOk && fs.existsSync(mp3Dir)) {
    const mp3Files = new Set(fs.readdirSync(mp3Dir));
    for (const ep of episodes) {
      ep.downloaded = mp3Files.has(`${ep.episode}.mp3`);
    }
  }

  const toTranscribe = episodes.filter(e => e.downloaded);
  if (toTranscribe.length === 0) {
    log('No audio files downloaded — skipping transcription');
    writeReport(generateReport(episodes, false));
    process.exit(0);
  }

  // Step 4: Transcribe
  const transcribeList = toTranscribe.map(e => e.episode).join(',');
  const trOk = run(
    `npm run batch-transcribe -- --episodes=${transcribeList}`,
    `batch-transcribe (${transcribeList})`
  );

  // Check which episodes actually got transcribed by re-checking Blob
  if (trOk) {
    try {
      const { listBlobTranscripts } = await import('../src/lib/blob-storage');
      const afterTranscripts = await listBlobTranscripts();
      const afterSet = new Set(
        afterTranscripts
          .map(b => b.pathname.match(/episode_(.+)\.json$/)?.[1]?.trim().toLowerCase())
          .filter((id): id is string => Boolean(id))
      );
      for (const ep of toTranscribe) {
        ep.transcribed = afterSet.has(normalizeEpisodeId(ep.episode));
      }
    } catch {
      log('Warning: could not verify transcripts in Blob');
    }
  }

  // Step 4b: Download newly transcribed episodes to transcripts/ for git commit
  const transcribed = episodes.filter(e => e.transcribed);
  if (transcribed.length > 0) {
    const transcriptsDir = path.resolve(__dirname, '..', 'transcripts');
    if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true });
    try {
      const { loadTranscript } = await import('../src/lib/blob-storage');
      for (const ep of transcribed) {
        const epNum = typeof ep.episode === 'number' ? ep.episode : parseInt(String(ep.episode), 10);
        if (Number.isNaN(epNum)) continue;
        const transcript = await loadTranscript(epNum);
        if (transcript) {
          const outPath = path.join(transcriptsDir, `episode_${ep.episode}.json`);
          fs.writeFileSync(outPath, JSON.stringify(transcript, null, 2));
          log(`Saved transcript to ${outPath}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Warning: could not download transcripts from Blob: ${msg}`);
    }
  }

  // Step 5: Report
  writeReport(generateReport(episodes, false));

  // Write transcribed episode numbers to a file so CI can run incremental ingest
  const transcribedEpisodes = episodes.filter(e => e.transcribed).map(e => e.episode);
  if (transcribedEpisodes.length > 0) {
    const outPath = path.resolve(__dirname, '..', 'transcribed-episodes.txt');
    fs.writeFileSync(outPath, transcribedEpisodes.join('\n'));
    log(`Wrote ${transcribedEpisodes.length} transcribed episode(s) to transcribed-episodes.txt`);
  }

  // Deploy is triggered by the GitHub Actions workflow after committing
  // metadata + transcripts, so we don't trigger it here (avoids a stale
  // first deploy that lacks the git-committed metadata).

  // Exit 0 for partial success, 1 only for infra failure
  const anySuccess = transcribedEpisodes.length > 0;
  const allFailed = toTranscribe.length > 0 && !anySuccess;
  process.exit(allFailed ? 1 : 0);
}

main().catch(err => {
  console.error('[check-new-episodes] Fatal error:', err);
  process.exit(1);
});
