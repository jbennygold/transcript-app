import { put, list, del, head } from '@vercel/blob';
import type { Transcript, TranscriptMetadata } from '@/types/transcript';

const TRANSCRIPT_PREFIX = 'transcripts/';
const RAW_TRANSCRIPT_PREFIX = 'transcripts/raw/';
const AUDIO_PREFIX = 'audio/';

export interface BlobTranscriptInfo {
  url: string;
  pathname: string;
  episodeNumber: number | string;
  uploadedAt: Date;
  /** Current byte size, for stale-edge detection in loadTranscriptByUrl(). */
  size: number;
}

/**
 * Cache TTL for the mutable JSON blobs (transcripts, jobs). Blob's default is
 * one month, and 60s is the SDK's floor — anything lower is rejected.
 *
 * These objects get overwritten in place (speaker mapping, cleanup, job status)
 * and are read back almost immediately, so a long edge TTL is actively harmful.
 * Audio and the search-data files are write-once-ish and keep the default.
 */
export const MUTABLE_BLOB_CACHE_MAX_AGE = 60;

/**
 * How hard to retry a read the CDN is answering with a stale body.
 *
 * Two profiles, because the right answer differs by caller. Interactive reads
 * (review UI, synopsis) must stay responsive, and a stale transcript there is a
 * cosmetic problem that the next request fixes — so they barely wait. Batch
 * readers that feed the search index must not proceed on stale data at all, and
 * nothing is harmed by waiting out the full TTL — so they're patient.
 */
const READ_PROFILES = {
  fast: { attempts: 2, delayMs: 1_000 },
  patient: { attempts: 10, delayMs: 10_000 },
} as const;

export type BlobReadProfile = keyof typeof READ_PROFILES;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch a JSON blob, defeating a stale CDN edge copy.
 *
 * `fetch(url, { cache: 'no-store' })` does NOT do this: it only bypasses the
 * runtime's own fetch cache, while Blob serves public objects through a CDN that
 * caches by pathname. Overwriting a blob leaves the old body served at the edge
 * until its TTL expires, and a query-string cache-buster does not help — the CDN
 * does not vary its cache key on the query (verified against a live blob:
 * `?cb=<random>` still returned `x-vercel-cache: HIT` at the same `age`).
 *
 * What is reliable is the metadata API: `list()`/`head()` are not CDN-cached and
 * report the current object's `size` immediately after a write. So we compare the
 * bytes actually served against that size, and retry while they disagree. This is
 * the failure that silently indexed a pre-speaker-mapping transcript for ep 317:
 * the ingest read a body 90s after the write and got the previous one.
 *
 * Best-effort by design: if the edge never converges we return the stale body
 * rather than nothing, since for read paths (review UI, synopsis) stale beats a
 * hard failure. Callers that must not proceed on stale data should pass
 * `expectedSize` and check `fresh` on the result.
 */
export async function fetchBlobJson<T>(
  url: string,
  expectedSize?: number,
  profile: BlobReadProfile = 'fast'
): Promise<{ data: T; fresh: boolean } | null> {
  const { attempts, delayMs } = READ_PROFILES[profile];
  let lastBody: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    lastBody = new TextDecoder().decode(buffer);

    if (expectedSize === undefined || buffer.byteLength === expectedSize) {
      return { data: JSON.parse(lastBody) as T, fresh: true };
    }

    if (attempt < attempts - 1) {
      console.warn(
        `[blob] stale edge copy for ${url} (served ${buffer.byteLength}B, expected ${expectedSize}B) — retrying`
      );
      await sleep(delayMs);
    }
  }

  if (lastBody === null) return null;
  console.warn(`[blob] giving up on a fresh copy of ${url}; returning the stale body`);
  return { data: JSON.parse(lastBody) as T, fresh: false };
}

/**
 * Upload an MP3 file to Vercel Blob storage
 */
export async function uploadAudio(
  file: Blob | Buffer | ArrayBuffer,
  episodeNumber: number
): Promise<string> {
  const pathname = `${AUDIO_PREFIX}episode_${episodeNumber}.mp3`;

  const blob = await put(pathname, file, {
    access: 'public',
    addRandomSuffix: false,
  });

  return blob.url;
}

/**
 * Save a transcript to Vercel Blob storage
 */
export async function saveTranscript(
  transcript: Transcript
): Promise<string> {
  const pathname = `${TRANSCRIPT_PREFIX}episode_${transcript.episode_number}.json`;

  const blob = await put(pathname, JSON.stringify(transcript, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
  });

  return blob.url;
}

/**
 * Load a transcript from Vercel Blob storage.
 *
 * Verifies the served bytes against the blob's current size so a stale CDN edge
 * copy can't be returned silently — see fetchBlobJson().
 */
export async function loadTranscript(
  episodeNumber: number | string
): Promise<Transcript | null> {
  return (await loadTranscriptChecked(episodeNumber))?.data ?? null;
}

/**
 * Same as loadTranscript(), but also reports whether the copy is confirmed fresh.
 * Use this where acting on a stale transcript would corrupt downstream state —
 * ingest being the motivating case.
 */
export async function loadTranscriptChecked(
  episodeNumber: number | string,
  profile: BlobReadProfile = 'fast'
): Promise<{ data: Transcript; fresh: boolean } | null> {
  const pathname = `${TRANSCRIPT_PREFIX}episode_${episodeNumber}.json`;

  try {
    const blobs = await list({ prefix: pathname });
    const match = blobs.blobs.find(b => b.pathname === pathname);

    if (!match) {
      return null;
    }

    return await fetchBlobJson<Transcript>(match.url, match.size, profile);
  } catch {
    return null;
  }
}

/**
 * Load a transcript directly from its blob URL (as returned by
 * listBlobTranscripts), skipping the per-episode `list()` lookup that
 * loadTranscript() does. For bulk loaders (e.g. agent search, which pulls all
 * ~325 transcripts on a cold start) this avoids ~325 redundant list() API
 * round-trips.
 *
 * Uses no-store to match loadTranscript()'s freshness — measurement showed the
 * full-corpus load is ~1s either way, so caching bought no latency win and only
 * risked stale grep results.
 *
 * Pass `expectedSize` (available as `size` on listBlobTranscripts() results) to
 * get the same stale-edge detection loadTranscript() does. Without it the read
 * is unverified, since there's no cheap oracle for a bare URL.
 */
export async function loadTranscriptByUrl(
  url: string,
  expectedSize?: number
): Promise<Transcript | null> {
  try {
    return (await fetchBlobJson<Transcript>(url, expectedSize, 'fast'))?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Save the raw (unmapped) transcript to Blob — called once at transcription time.
 * Will not overwrite if a raw copy already exists.
 */
export async function saveRawTranscript(transcript: Transcript): Promise<string | null> {
  const pathname = `${RAW_TRANSCRIPT_PREFIX}episode_${transcript.episode_number}.json`;

  try {
    const existing = await head(pathname);
    if (existing) return null; // raw already saved, don't overwrite
  } catch {
    // doesn't exist yet — save it
  }

  const blob = await put(pathname, JSON.stringify(transcript, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
  });

  return blob.url;
}

/**
 * Load the raw (unmapped) transcript from Blob storage
 */
export async function loadRawTranscript(episodeNumber: number): Promise<Transcript | null> {
  const pathname = `${RAW_TRANSCRIPT_PREFIX}episode_${episodeNumber}.json`;

  try {
    const blobs = await list({ prefix: pathname });
    const match = blobs.blobs.find(b => b.pathname === pathname);
    if (!match) return null;

    return (await fetchBlobJson<Transcript>(match.url, match.size))?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a transcript exists in Blob storage
 */
export async function transcriptExists(episodeNumber: number): Promise<boolean> {
  const pathname = `${TRANSCRIPT_PREFIX}episode_${episodeNumber}.json`;

  try {
    const result = await head(pathname);
    return !!result;
  } catch {
    return false;
  }
}

/**
 * Check if audio exists in Blob storage
 */
export async function audioExists(episodeNumber: number | string): Promise<boolean> {
  const pathname = `${AUDIO_PREFIX}episode_${episodeNumber}.mp3`;

  try {
    const result = await head(pathname);
    return !!result;
  } catch {
    return false;
  }
}

/**
 * List every episode id that has an audio file, in one Blob call. Use this
 * instead of calling audioExists() per episode when checking the whole corpus.
 */
export async function listBlobAudioEpisodes(): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: AUDIO_PREFIX, cursor });
    for (const blob of page.blobs) {
      const match = blob.pathname.match(/episode_([\w]+)\.mp3$/);
      if (match) ids.add(match[1]);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return ids;
}

/**
 * Get audio URL from Blob storage
 */
export async function getAudioUrl(episodeNumber: number): Promise<string | null> {
  const pathname = `${AUDIO_PREFIX}episode_${episodeNumber}.mp3`;

  try {
    const result = await head(pathname);
    return result?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * List all transcripts in Blob storage
 */
export async function listBlobTranscripts(): Promise<BlobTranscriptInfo[]> {
  const blobs = await list({ prefix: TRANSCRIPT_PREFIX });

  return blobs.blobs
    .filter(blob => blob.pathname.endsWith('.json') && !blob.pathname.startsWith(RAW_TRANSCRIPT_PREFIX))
    .map(blob => {
      // Extract episode ID from pathname like "transcripts/episode_123.json" or "transcripts/episode_49b1.json"
      const match = blob.pathname.match(/episode_([\w]+)\.json$/);
      const raw = match ? match[1] : '0';
      const episodeNumber: number | string = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;

      return {
        url: blob.url,
        pathname: blob.pathname,
        episodeNumber,
        uploadedAt: new Date(blob.uploadedAt),
        size: blob.size,
      };
    })
    .sort((a, b) => {
      const aNum = typeof a.episodeNumber === 'number' ? a.episodeNumber : parseInt(String(a.episodeNumber));
      const bNum = typeof b.episodeNumber === 'number' ? b.episodeNumber : parseInt(String(b.episodeNumber));
      return aNum - bNum;
    });
}

/**
 * Delete a transcript from Blob storage
 */
export async function deleteTranscript(episodeNumber: number | string): Promise<boolean> {
  const pathname = `${TRANSCRIPT_PREFIX}episode_${episodeNumber}.json`;

  try {
    await del(pathname);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete audio from Blob storage
 */
export async function deleteAudio(episodeNumber: number): Promise<boolean> {
  const pathname = `${AUDIO_PREFIX}episode_${episodeNumber}.mp3`;

  try {
    await del(pathname);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename a transcript by changing its episode number
 * This loads the transcript, updates the episode_number, saves with new name, and deletes the old one
 */
export async function renameTranscript(
  fromEpisodeNumber: number,
  toEpisodeNumber: number
): Promise<{ success: boolean; error?: string }> {
  try {
    // Load the existing transcript
    const transcript = await loadTranscript(fromEpisodeNumber);
    if (!transcript) {
      return { success: false, error: `Transcript episode_${fromEpisodeNumber} not found` };
    }

    // Check if target already exists
    const targetExists = await transcriptExists(toEpisodeNumber);
    if (targetExists) {
      return { success: false, error: `Transcript episode_${toEpisodeNumber} already exists` };
    }

    // Update the episode number in the transcript
    transcript.episode_number = toEpisodeNumber;

    // Save with new episode number
    await saveTranscript(transcript);

    // Verify the new transcript exists before deleting old one
    const newExists = await transcriptExists(toEpisodeNumber);
    if (!newExists) {
      return { success: false, error: 'Failed to save transcript with new episode number' };
    }

    // Delete the old transcript
    await deleteTranscript(fromEpisodeNumber);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during rename'
    };
  }
}

/**
 * Store transcription job metadata in Blob storage
 * Used for tracking async transcription jobs
 */
export async function saveTranscriptionJob(
  jobId: string,
  data: {
    episodeNumber: number;
    episodeName: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    audioUrl: string;
    error?: string;
    transcript?: Transcript;
  }
): Promise<string> {
  const pathname = `jobs/${jobId}.json`;

  const blob = await put(pathname, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
  });

  return blob.url;
}

/**
 * Load transcription job metadata
 */
export async function loadTranscriptionJob(jobId: string): Promise<{
  episodeNumber: number;
  episodeName: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  audioUrl: string;
  error?: string;
  transcript?: Transcript;
} | null> {
  const pathname = `jobs/${jobId}.json`;

  try {
    const blobs = await list({ prefix: pathname });
    const match = blobs.blobs.find(b => b.pathname === pathname);

    if (!match) {
      return null;
    }

    // 'fast': job status is polled, so a stale read self-corrects on the next
    // tick and is never worth stalling the poll for.
    const result = await fetchBlobJson<{
      episodeNumber: number;
      episodeName: string;
      status: 'pending' | 'processing' | 'completed' | 'failed';
      audioUrl: string;
      error?: string;
      transcript?: Transcript;
    }>(match.url, match.size, 'fast');

    return result?.data ?? null;
  } catch {
    return null;
  }
}
