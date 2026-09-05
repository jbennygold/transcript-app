import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscriptList, type TranscriptListDeps } from './transcript-list';
import type { BlobTranscriptInfo } from './blob-storage';
import type { Transcript } from '@/types/transcript';

function blob(episodeNumber: number | string, size = 100): BlobTranscriptInfo {
  return {
    url: `https://blob.test/transcripts/episode_${episodeNumber}.json`,
    pathname: `transcripts/episode_${episodeNumber}.json`,
    episodeNumber,
    uploadedAt: new Date('2026-01-01'),
    size,
  };
}

function transcript(episodeNumber: number | string, lines: number): Transcript {
  return {
    episode_number: Number(episodeNumber),
    episode_name: `Episode ${episodeNumber}`,
    dialogues: Array.from({ length: lines }, (_, i) => ({ name: 'Jason', text: `line ${i}`, timestamp: `0:${i}` })),
  };
}

function deps(
  blobs: BlobTranscriptInfo[],
  bodies: Record<string, Transcript | null>,
  audio: Set<string>
): TranscriptListDeps & { calls: string[]; inFlight: number; maxInFlight: number } {
  const state = {
    calls: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
  };
  return {
    listTranscripts: async () => {
      state.calls.push('listTranscripts');
      return blobs;
    },
    fetchTranscript: async (url: string) => {
      state.calls.push(`fetch:${url}`);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      // Yield so concurrent callers can overlap before this one resolves.
      await new Promise(r => setTimeout(r, 5));
      state.inFlight--;
      return bodies[url] ?? null;
    },
    listAudioEpisodes: async () => {
      state.calls.push('listAudio');
      return audio;
    },
    get maxInFlight() {
      return state.maxInFlight;
    },
    get inFlight() {
      return state.inFlight;
    },
    get calls() {
      return state.calls;
    },
  };
}

test('buildTranscriptList fetches every transcript body concurrently, not one at a time', async () => {
  const blobs = [blob(1), blob(2), blob(3), blob(4)];
  const bodies = Object.fromEntries(blobs.map(b => [b.url, transcript(b.episodeNumber, 3)]));
  const d = deps(blobs, bodies, new Set());

  await buildTranscriptList(d);

  assert.equal(d.maxInFlight, 4, 'all fetches should be in flight at once');
});

test('buildTranscriptList resolves audio presence with one listing, not a call per episode', async () => {
  const blobs = [blob(1), blob(2), blob(3)];
  const bodies = Object.fromEntries(blobs.map(b => [b.url, transcript(b.episodeNumber, 1)]));
  const d = deps(blobs, bodies, new Set(['2']));

  const result = await buildTranscriptList(d);

  assert.equal(d.calls.filter(c => c === 'listAudio').length, 1);
  assert.deepEqual(
    result.map(t => [t.episode_number, t.hasAudio]),
    [
      [1, false],
      [2, true],
      [3, false],
    ]
  );
});

test('buildTranscriptList reports name and dialogue count and sorts bonus ids after their base episode', async () => {
  const blobs = [blob('49b1'), blob(50), blob(49)];
  const bodies = {
    [blobs[0].url]: transcript('49b1', 7),
    [blobs[1].url]: transcript(50, 2),
    [blobs[2].url]: transcript(49, 5),
  };
  const d = deps(blobs, bodies, new Set(['49b1']));

  const result = await buildTranscriptList(d);

  assert.deepEqual(result, [
    { filename: 'episode_49', episode_number: 49, episode_name: 'Episode 49', dialogueCount: 5, hasAudio: false },
    { filename: 'episode_49b1', episode_number: '49b1', episode_name: 'Episode 49b1', dialogueCount: 7, hasAudio: true },
    { filename: 'episode_50', episode_number: 50, episode_name: 'Episode 50', dialogueCount: 2, hasAudio: false },
  ]);
});

test('buildTranscriptList skips a transcript whose body cannot be loaded', async () => {
  const blobs = [blob(1), blob(2)];
  const bodies = { [blobs[0].url]: transcript(1, 1), [blobs[1].url]: null };
  const d = deps(blobs, bodies, new Set());

  const result = await buildTranscriptList(d);

  assert.deepEqual(
    result.map(t => t.episode_number),
    [1]
  );
});
