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
  });

  return blob.url;
}

/**
 * Load a transcript from Vercel Blob storage
 */
export async function loadTranscript(
  episodeNumber: number | string
): Promise<Transcript | null> {
  const pathname = `${TRANSCRIPT_PREFIX}episode_${episodeNumber}.json`;

  try {
    const blobs = await list({ prefix: pathname });
    const match = blobs.blobs.find(b => b.pathname === pathname);

    if (!match) {
      return null;
    }

    // Use no-store to bypass CDN cache and get fresh data
    const response = await fetch(match.url, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Load a transcript directly from its blob URL (as returned by
 * listBlobTranscripts), skipping the per-episode `list()` lookup that
 * loadTranscript() does. Caches with an hourly revalidate so bulk loaders
 * (e.g. agent search, which pulls all ~300 transcripts on a cold start) hit
 * the Next data cache instead of re-downloading the full corpus every time.
 *
 * Transcript blob URLs are stable (addRandomSuffix: false), so an edit
 * overwrites in place — cached readers may be up to the revalidate window
 * stale. Acceptable for search/grep; do NOT use where you need the freshest
 * copy (use loadTranscript() with no-store for that).
 */
export async function loadTranscriptByUrl(
  url: string
): Promise<Transcript | null> {
  try {
    const response = await fetch(url, { next: { revalidate: 3600 } });
    if (!response.ok) {
      return null;
    }
    return await response.json();
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

    const response = await fetch(match.url, { cache: 'no-store' });
    if (!response.ok) return null;

    return await response.json();
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

    // Use no-store to bypass CDN cache
    const response = await fetch(match.url, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}
