/**
 * Batch Transcription Script
 *
 * Processes MP3 files from ./mp3s/ directory for episodes that are missing transcripts.
 * Uploads to Vercel Blob, transcribes via AssemblyAI, and saves transcripts to Blob storage.
 *
 * Usage:
 *   npm run batch-transcribe              # Process all missing episodes
 *   npm run batch-transcribe -- --dry-run # Preview what would be processed
 *   npm run batch-transcribe -- --status  # Show current progress
 *   npm run batch-transcribe -- --limit=5 # Process only first 5 episodes
 *   npm run batch-transcribe -- --episodes 230,239,241 # Process specific episodes
 */

import * as fs from 'fs';
import * as path from 'path';
import { AssemblyAI } from 'assemblyai';
import { put, head } from '@vercel/blob';
import * as dotenv from 'dotenv';
import { EpisodeId, episodeSortKey } from '../src/lib/episode-format';

dotenv.config({ path: '.env.local' });

// Import lexicon for keyterms prompt
import { getKeytermsPrompt } from '../src/lib/lexicon';
import {
  SPEECH_MODELS,
  MIN_SPEAKERS_EXPECTED,
  MAX_SPEAKERS_EXPECTED,
} from '../src/lib/transcription-config';

const MP3_DIR = './mp3s';
const PROGRESS_FILE = './batch-transcribe-progress.json';
const AUDIO_PREFIX = 'audio/';
const TRANSCRIPT_PREFIX = 'transcripts/';
const MAX_CONCURRENT_JOBS = 1; // Reduced from 3 to avoid memory issues with large MP3s
const POLL_INTERVAL_MS = 10000; // 10 seconds

// CLI args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const showStatus = args.includes('--status');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : undefined;
const episodesArg = args.find(a => a.startsWith('--episodes'));
const explicitEpisodes = episodesArg
  ? episodesArg
      .split('=', 2)[1]
      ?.split(',')
      .map(s => s.trim())
      .filter(Boolean)
  : undefined;
const minSpeakersArg = args.find(a => a.startsWith('--min-speakers='));
const maxSpeakersArg = args.find(a => a.startsWith('--max-speakers='));
const minSpeakers = minSpeakersArg
  ? parseInt(minSpeakersArg.split('=')[1], 10)
  : MIN_SPEAKERS_EXPECTED;
const maxSpeakers = maxSpeakersArg
  ? parseInt(maxSpeakersArg.split('=')[1], 10)
  : MAX_SPEAKERS_EXPECTED;

interface ProgressEntry {
  episodeNumber: EpisodeId;
  status: 'pending' | 'uploading' | 'transcribing' | 'completed' | 'failed';
  jobId?: string;
  audioUrl?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface ProgressFile {
  startedAt: string;
  lastUpdated: string;
  entries: Record<string, ProgressEntry>;
}

interface CoverageEpisode {
  episode: EpisodeId;
  film: string;
  hasTranscript: boolean;
  needsReview: boolean;
}

interface CoverageResponse {
  episodes: CoverageEpisode[];
}

interface DialogueEntry {
  name: string;
  timestamp: string;
  text: string;
}

interface Transcript {
  episode_number: EpisodeId;
  episode_name: string;
  dialogues: DialogueEntry[];
}

const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY || '',
});

function normalizeEpisodeId(id: EpisodeId): string {
  return String(id).trim().toLowerCase();
}

function loadProgress(): ProgressFile {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    entries: {},
  };
}

function saveProgress(progress: ProgressFile): void {
  progress.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

async function fetchCoverage(): Promise<CoverageResponse> {
  // Read coverage data by directly calling the file-based data
  // We can't easily call our own API from a script, so we'll use metadata + blob listing
  const { loadEpisodeMetadata } = await import('../src/lib/metadata-store');

  const metadata = loadEpisodeMetadata();

  // Check filesystem transcripts
  const transcriptsDir = path.join(process.cwd(), 'transcripts');
  const fsTranscriptIds = new Set<string>();

  if (fs.existsSync(transcriptsDir)) {
    const files = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.json'));
    for (const filename of files) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(transcriptsDir, filename), 'utf-8'));
        if (content.episode_number !== undefined && content.episode_number !== null) {
          fsTranscriptIds.add(normalizeEpisodeId(content.episode_number));
        }
      } catch {
        // Skip
      }
    }
  }

  // Try to fetch blob transcripts (may fail in dry-run without API token)
  const blobIds = new Set<string>();
  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { listBlobTranscripts } = await import('../src/lib/blob-storage');
      const blobTranscripts = await listBlobTranscripts();
      for (const b of blobTranscripts) {
        const match = b.pathname.match(/episode_(.+)\.json$/);
        if (match) blobIds.add(match[1].trim().toLowerCase());
      }
    }
  } catch (err) {
    if (!isDryRun) {
      throw err; // Re-throw if not in dry-run mode
    }
    console.log('  (Skipping blob transcript check - no BLOB_READ_WRITE_TOKEN)');
  }

  const episodes: CoverageEpisode[] = metadata.map((ep: { episode: EpisodeId; film: string }) => ({
    episode: ep.episode,
    film: ep.film,
    hasTranscript: fsTranscriptIds.has(normalizeEpisodeId(ep.episode)) || blobIds.has(normalizeEpisodeId(ep.episode)),
    needsReview: false, // We don't need this for batch processing
  }));

  return { episodes };
}

function filterCoverageByEpisodes(coverage: CoverageResponse, episodes: EpisodeId[]): CoverageResponse {
  const episodeSet = new Set(episodes.map(normalizeEpisodeId));
  const filtered = coverage.episodes.filter(ep => episodeSet.has(normalizeEpisodeId(ep.episode)));

  const found = new Set(filtered.map(ep => normalizeEpisodeId(ep.episode)));
  const missing = episodes.filter(n => !found.has(normalizeEpisodeId(n)));
  if (missing.length > 0) {
    console.warn(`Warning: ${missing.length} episode(s) not found in metadata: ${missing.map(String).join(', ')}`);
  }

  return { episodes: filtered };
}

function findAvailableMp3s(): Map<string, string> {
  const mp3Map = new Map<string, string>();

  if (!fs.existsSync(MP3_DIR)) {
    return mp3Map;
  }

  const files = fs.readdirSync(MP3_DIR).filter(f => f.toLowerCase().endsWith('.mp3'));

  for (const filename of files) {
    const episodeId = filename.replace(/\.mp3$/i, '').trim().toLowerCase();
    if (episodeId) mp3Map.set(episodeId, path.join(MP3_DIR, filename));
  }

  return mp3Map;
}

async function uploadAudioToBlob(filePath: string, episodeNumber: EpisodeId): Promise<string> {
  const pathname = `${AUDIO_PREFIX}episode_${episodeNumber}.mp3`;

  // Check if already uploaded
  try {
    const existing = await head(pathname);
    if (existing) {
      console.log(`    Audio already uploaded, using existing: ${existing.url}`);
      return existing.url;
    }
  } catch {
    // Doesn't exist, proceed to upload
  }

  const fileBuffer = fs.readFileSync(filePath);

  console.log(`    Uploading ${path.basename(filePath)} to Blob storage...`);
  const blob = await put(pathname, fileBuffer, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return blob.url;
}

async function startTranscription(audioUrl: string, episodeNumber: EpisodeId, episodeName: string): Promise<string> {
  const keytermsPrompt = getKeytermsPrompt();

  console.log(`    Speaker range: ${minSpeakers}–${maxSpeakers}`);
  console.log(`    Keyterms prompt: ${keytermsPrompt.length} terms`);
  const transcriptResponse = await client.transcripts.submit({
    audio_url: audioUrl,
    speech_models: [...SPEECH_MODELS],
    speaker_labels: true,
    speaker_options: {
      min_speakers_expected: minSpeakers,
      max_speakers_expected: maxSpeakers,
    },
    keyterms_prompt: keytermsPrompt,
  } as Record<string, unknown> as Parameters<typeof client.transcripts.submit>[0]);

  return transcriptResponse.id;
}

async function pollTranscription(jobId: string): Promise<{ status: string; transcript?: Transcript; error?: string }> {
  const result = await client.transcripts.get(jobId);

  if (result.status === 'error') {
    return { status: 'failed', error: result.error || 'Transcription failed' };
  }

  if (result.status === 'completed') {
    const utterances = result.utterances || [];

    const dialogues: DialogueEntry[] = utterances.map((utterance) => ({
      name: utterance.speaker,
      timestamp: formatTimestamp(utterance.start),
      text: utterance.text,
    }));

    return {
      status: 'completed',
      transcript: {
        episode_number: 0, // Will be set by caller
        episode_name: '',
        dialogues,
      },
    };
  }

  return { status: 'processing' };
}

async function saveTranscriptToBlob(transcript: Transcript): Promise<void> {
  const { saveTranscript, saveRawTranscript } = await import('../src/lib/blob-storage');
  await saveRawTranscript(transcript);
  await saveTranscript(transcript);
}

async function processEpisode(
  episodeNumber: EpisodeId,
  mp3Path: string,
  episodeName: string,
  progress: ProgressFile
): Promise<void> {
  const entryKey = String(episodeNumber);
  const entry = progress.entries[entryKey] || {
    episodeNumber,
    status: 'pending' as const,
    startedAt: new Date().toISOString(),
  };

  progress.entries[entryKey] = entry;

  try {
    // Step 1: Upload audio if needed
    if (entry.status === 'pending' || !entry.audioUrl) {
      console.log(`  [${episodeNumber}] Uploading audio...`);
      entry.status = 'uploading';
      saveProgress(progress);

      entry.audioUrl = await uploadAudioToBlob(mp3Path, episodeNumber);
      saveProgress(progress);
    }

    // Step 2: Start transcription if needed
    if ((entry.status === 'pending' || entry.status === 'uploading') && !entry.jobId) {
      console.log(`  [${episodeNumber}] Starting transcription...`);
      entry.status = 'transcribing';
      saveProgress(progress);

      entry.jobId = await startTranscription(entry.audioUrl!, episodeNumber, episodeName);
      saveProgress(progress);
    }

    // Step 3: Poll for completion
    if (entry.status === 'transcribing' && entry.jobId) {
      let pollCount = 0;
      const maxPolls = 360; // 60 minutes max at 10s intervals

      while (pollCount < maxPolls) {
        const result = await pollTranscription(entry.jobId);

        if (result.status === 'completed' && result.transcript) {
          result.transcript.episode_number = episodeNumber;
          result.transcript.episode_name = episodeName;

          console.log(`  [${episodeNumber}] Saving transcript...`);
          await saveTranscriptToBlob(result.transcript);

          entry.status = 'completed';
          entry.completedAt = new Date().toISOString();
          saveProgress(progress);

          console.log(`  [${episodeNumber}] Done!`);
          return;
        }

        if (result.status === 'failed') {
          entry.status = 'failed';
          entry.error = result.error;
          saveProgress(progress);
          console.log(`  [${episodeNumber}] Failed: ${result.error}`);
          return;
        }

        pollCount++;
        if (pollCount % 6 === 0) {
          console.log(`  [${episodeNumber}] Still processing... (${Math.round(pollCount * POLL_INTERVAL_MS / 60000)}m)`);
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      // Timed out
      entry.status = 'failed';
      entry.error = 'Transcription timed out after 60 minutes';
      saveProgress(progress);
    }
  } catch (error) {
    entry.status = 'failed';
    entry.error = error instanceof Error ? error.message : 'Unknown error';
    saveProgress(progress);
    console.error(`  [${episodeNumber}] Error: ${entry.error}`);
  }
}

async function showCurrentStatus(): Promise<void> {
  const progress = loadProgress();

  console.log('=== Batch Transcription Status ===\n');
  console.log(`Started: ${progress.startedAt}`);
  console.log(`Last updated: ${progress.lastUpdated}\n`);

  const entries = Object.values(progress.entries).sort(
    (a, b) => episodeSortKey(a.episodeNumber) - episodeSortKey(b.episodeNumber)
  );

  const completed = entries.filter(e => e.status === 'completed');
  const failed = entries.filter(e => e.status === 'failed');
  const inProgress = entries.filter(e => e.status === 'transcribing' || e.status === 'uploading');
  const pending = entries.filter(e => e.status === 'pending');

  console.log(`Completed: ${completed.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`In Progress: ${inProgress.length}`);
  console.log(`Pending: ${pending.length}`);
  console.log(`Total: ${entries.length}\n`);

  if (failed.length > 0) {
    console.log('Failed episodes:');
    for (const e of failed) {
      console.log(`  - Episode ${e.episodeNumber}: ${e.error}`);
    }
    console.log('');
  }

  if (inProgress.length > 0) {
    console.log('In progress:');
    for (const e of inProgress) {
      console.log(`  - Episode ${e.episodeNumber} (${e.status})`);
    }
    console.log('');
  }
}

async function main(): Promise<void> {
  console.log('=== Batch Transcription Tool ===\n');

  // Show status mode
  if (showStatus) {
    await showCurrentStatus();
    return;
  }

  // Find available MP3s (do this before API key check so dry-run works without keys)
  const mp3Map = findAvailableMp3s();
  if (mp3Map.size === 0) {
    console.log(`No MP3 files found in ${MP3_DIR}/`);
    console.log('Expected format: {episodeNumber}.mp3 (e.g., 234.mp3)');
    process.exit(0);
  }

  console.log(`Found ${mp3Map.size} MP3 file(s) in ${MP3_DIR}/\n`);

  // Fetch coverage to find episodes needing transcription
  console.log('Fetching coverage data...');
  let coverage = await fetchCoverage();
  if (explicitEpisodes && explicitEpisodes.length > 0) {
    coverage = filterCoverageByEpisodes(coverage, explicitEpisodes);
  }

  // Find episodes that need transcription and have MP3s available
  const episodesToProcess: Array<{ episodeNumber: EpisodeId; mp3Path: string; film: string }> = [];

  for (const ep of coverage.episodes) {
    const episodeId = normalizeEpisodeId(ep.episode);
    const hasMp3 = mp3Map.has(episodeId);
    const shouldProcess = explicitEpisodes ? true : !ep.hasTranscript;
    if (shouldProcess && hasMp3) {
      episodesToProcess.push({
        episodeNumber: ep.episode,
        mp3Path: mp3Map.get(episodeId)!,
        film: ep.film,
      });
    }
  }

  // Sort by episode number
  episodesToProcess.sort((a, b) => episodeSortKey(a.episodeNumber) - episodeSortKey(b.episodeNumber));

  // Apply limit if specified
  const toProcess = limit ? episodesToProcess.slice(0, limit) : episodesToProcess;

  if (toProcess.length === 0) {
    console.log('\nNo episodes to process. Either:');
    if (explicitEpisodes) {
      console.log('  - None of the specified episodes have MP3s in ./mp3s');
    } else {
      console.log('  - All episodes with MP3s already have transcripts');
    }
    console.log('  - No MP3s match episodes in the metadata');
    return;
  }

  const modeNote = explicitEpisodes ? ' (explicit list)' : '';
  console.log(`\n${toProcess.length} episode(s) to process${limit ? ` (limited to ${limit})` : ''}${modeNote}:\n`);

  for (const ep of toProcess) {
    console.log(`  - Episode ${ep.episodeNumber}: ${ep.film}`);
  }

  if (isDryRun) {
    console.log('\n[DRY RUN] No transcriptions started.');
    return;
  }

  // Check API keys only when actually processing (not for dry-run)
  if (!process.env.ASSEMBLYAI_API_KEY) {
    console.error('Error: ASSEMBLYAI_API_KEY not found in .env.local');
    process.exit(1);
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('Error: BLOB_READ_WRITE_TOKEN not found in .env.local');
    process.exit(1);
  }

  console.log('\n--- Starting Batch Processing ---\n');

  // Load or initialize progress
  const progress = loadProgress();

  // Process in batches with concurrency limit
  const processQueue = [...toProcess];
  const activeJobs: Promise<void>[] = [];

  while (processQueue.length > 0 || activeJobs.length > 0) {
    // Start new jobs up to concurrency limit
    while (activeJobs.length < MAX_CONCURRENT_JOBS && processQueue.length > 0) {
      const ep = processQueue.shift()!;

      // Skip if already completed
      if (progress.entries[String(ep.episodeNumber)]?.status === 'completed') {
        console.log(`[${ep.episodeNumber}] Already completed, skipping.`);
        continue;
      }

      console.log(`[${ep.episodeNumber}] Starting: ${ep.film}`);
      const job = processEpisode(ep.episodeNumber, ep.mp3Path, ep.film, progress)
        .finally(() => {
          const idx = activeJobs.indexOf(job);
          if (idx >= 0) activeJobs.splice(idx, 1);
        });
      activeJobs.push(job);
    }

    // Wait for at least one job to complete
    if (activeJobs.length > 0) {
      await Promise.race(activeJobs);
    }
  }

  console.log('\n=== Batch Processing Complete ===\n');

  // Print summary
  const entries = Object.values(progress.entries);
  const completed = entries.filter(e => e.status === 'completed').length;
  const failed = entries.filter(e => e.status === 'failed').length;

  console.log(`Completed: ${completed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed episodes:');
    for (const e of entries.filter(e => e.status === 'failed')) {
      console.log(`  - Episode ${e.episodeNumber}: ${e.error}`);
    }
  }

  console.log('\nTranscripts saved to Blob storage.');
  console.log('Visit /coverage to see "Review needed" episodes for speaker mapping.');
}

main().catch(console.error);
