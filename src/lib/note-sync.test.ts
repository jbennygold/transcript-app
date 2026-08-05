import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSyncInput, syncComments, type SyncDeps } from './note-sync';
import type { EpisodeNote } from './episode-notes';

function deps(overrides: Partial<SyncDeps> = {}): SyncDeps & { calls: string[]; saved: EpisodeNote[] } {
  const calls: string[] = [];
  const saved: EpisodeNote[] = [];
  return {
    calls,
    saved,
    listNotes: async () => [],
    appendToCell: async () => {
      calls.push('append');
      return 'appended' as const;
    },
    saveNote: async (n: EpisodeNote) => {
      calls.push('save');
      saved.push(n);
    },
    now: () => '2026-08-05T00:00:00.000Z',
    newId: (i: number) => `note_${i}`,
    ...overrides,
  };
}

test('validateSyncInput accepts a well-formed batch', () => {
  const r = validateSyncInput({
    episode: '317',
    comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.episode, '317');
    assert.equal(r.value.comments.length, 1);
  }
});

test('validateSyncInput rejects a missing episode', () => {
  const r = validateSyncInput({ comments: [] });
  assert.equal(r.ok, false);
});

test('validateSyncInput rejects a non-array comments field', () => {
  const r = validateSyncInput({ episode: '317', comments: 'nope' });
  assert.equal(r.ok, false);
});

test('validateSyncInput rejects an empty batch', () => {
  const r = validateSyncInput({ episode: '317', comments: [] });
  assert.equal(r.ok, false);
});

test('validateSyncInput drops comments with no discordMessageId', () => {
  const r = validateSyncInput({
    episode: '317',
    comments: [
      { discordMessageId: '', text: 'A great moment here', submittedBy: 'jason#0' },
      { discordMessageId: 'm2', text: 'Another great moment', submittedBy: 'jason#0' },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value.comments.map(c => c.discordMessageId), ['m2']);
});

test('syncComments appends then records, in that order', async () => {
  const d = deps();
  await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  // The invariant: a failed sheet write must leave nothing recorded, which is
  // only true if append strictly precedes save.
  assert.deepEqual(d.calls, ['append', 'save']);
});

test('syncComments records the message id and thread source on the saved note', async () => {
  const d = deps();
  await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(d.saved[0].discordMessageId, 'm1');
  assert.equal(d.saved[0].source, 'thread');
  assert.equal(d.saved[0].status, 'approved');
  assert.equal(d.saved[0].episode, '317');
});

test('syncComments skips an already-synced comment without touching the sheet', async () => {
  const d = deps({
    listNotes: async () => [
      { id: 'n1', episode: '317', note: 'x', submittedBy: 'j', createdAt: 'z', status: 'approved', discordMessageId: 'm1' },
    ] as EpisodeNote[],
  });
  const r = await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.deepEqual(d.calls, []);
  assert.equal(r.results[0].outcome, 'already_synced');
  assert.equal(r.summary.alreadySynced, 1);
});

test('syncComments still records a duplicate so it is not retried forever', async () => {
  const d = deps({
    appendToCell: async () => 'duplicate' as const,
  });
  const r = await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(r.results[0].outcome, 'duplicate');
  assert.equal(d.saved.length, 1);
  assert.equal(r.summary.duplicate, 1);
});

test('syncComments records nothing when the sheet has no row', async () => {
  const d = deps({ appendToCell: async () => 'no_row' as const });
  const r = await syncComments(
    { episode: '999', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(r.results[0].outcome, 'no_sheet_row');
  assert.equal(d.saved.length, 0);
  assert.equal(r.summary.failed, 1);
});

test('syncComments records nothing when the sheet write throws', async () => {
  const d = deps({
    appendToCell: async () => {
      throw new Error('sheets 503');
    },
  });
  const r = await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(r.results[0].outcome, 'append_failed');
  assert.equal(d.saved.length, 0);
});

test('syncComments normalises text before it reaches the sheet', async () => {
  const appended: string[] = [];
  const d = deps({
    appendToCell: async (_ep: string, _col: string, line: string) => {
      appended.push(line);
      return 'appended' as const;
    },
  });
  await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'line one\nline two', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(appended[0], 'line one line two');
});

test('syncComments rejects a comment too short to be a bullet', async () => {
  const d = deps();
  const r = await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'ok', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(r.results[0].outcome, 'invalid_note');
  assert.deepEqual(d.calls, []);
});

test('syncComments keeps going after one comment fails', async () => {
  let n = 0;
  const d = deps({
    appendToCell: async () => {
      n += 1;
      if (n === 1) throw new Error('sheets 503');
      return 'appended' as const;
    },
  });
  const r = await syncComments(
    {
      episode: '317',
      comments: [
        { discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' },
        { discordMessageId: 'm2', text: 'Another great moment', submittedBy: 'jason#0' },
      ],
    },
    d
  );
  assert.equal(r.results[0].outcome, 'append_failed');
  assert.equal(r.results[1].outcome, 'appended');
  assert.equal(r.summary.considered, 2);
  assert.equal(r.summary.appended, 1);
});
