import type { Transcript, TranscriptMetadata } from '@/types/transcript';
import type { BlobTranscriptInfo } from './blob-storage';
import { episodeSortKey } from './episode-format';

/**
 * Blob accessors for buildTranscriptList(). Injected so the list-building
 * logic can be tested without the Blob SDK, and so the route can't quietly
 * regress into per-episode metadata calls: the only way to load a body is by
 * the URL the listing already resolved, and audio presence is a single set.
 */
export interface TranscriptListDeps {
  listTranscripts: () => Promise<BlobTranscriptInfo[]>;
  fetchTranscript: (url: string, expectedSize?: number) => Promise<Transcript | null>;
  /** Episode ids (as strings, e.g. "321" or "49b1") that have an audio file. */
  listAudioEpisodes: () => Promise<Set<string>>;
}

/**
 * Build the /api/transcripts listing: one transcript listing, one audio
 * listing, and a parallel fan-out for the bodies. Previously this was three
 * sequential Blob calls per episode (~990 round-trips for 329 episodes), which
 * took 30-40s and 504'd past the 120s function limit when Blob was slow.
 */
export async function buildTranscriptList(deps: TranscriptListDeps): Promise<TranscriptMetadata[]> {
  const [blobs, audioEpisodes] = await Promise.all([deps.listTranscripts(), deps.listAudioEpisodes()]);

  const entries = await Promise.all(
    blobs.map(async (blob): Promise<TranscriptMetadata | null> => {
      const transcript = await deps.fetchTranscript(blob.url, blob.size);
      if (!transcript) return null;
      return {
        filename: `episode_${blob.episodeNumber}`,
        episode_number: blob.episodeNumber,
        episode_name: transcript.episode_name,
        dialogueCount: transcript.dialogues?.length || 0,
        hasAudio: audioEpisodes.has(String(blob.episodeNumber)),
      };
    })
  );

  return entries
    .filter((entry): entry is TranscriptMetadata => entry !== null)
    .sort((a, b) => episodeSortKey(a.episode_number) - episodeSortKey(b.episode_number));
}
