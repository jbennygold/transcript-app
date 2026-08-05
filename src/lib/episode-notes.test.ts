import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newNoteId,
  validateNoteInput,
  buildNote,
  isEpisodeNote,
  normaliseNoteText,
  isOpenEpisode,
  buildThreadNote,
  listSyncedMessageIds,
  type EpisodeNote,
} from './episode-notes';

test('newNoteId is stable for the same inputs and sortable by time', () => {
  const a = newNoteId(1000, 'abc');
  const b = newNoteId(2000, 'abc');
  assert.equal(a, newNoteId(1000, 'abc'));
  assert.ok(a < b, 'later timestamps must sort after earlier ones');
});

test('newNoteId sorts correctly across a digit-width boundary', () => {
  // Without zero-padding, 'note_999_x' > 'note_1000_x' lexicographically
  // even though 999 is earlier. This is what padStart is for.
  assert.ok(newNoteId(999, 'x') < newNoteId(1000, 'x'));
});

test('validateNoteInput accepts a well-formed note', () => {
  const r = validateNoteInput({ episode: '317', note: 'Roy Scheider tangent', submittedBy: 'matt' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.episode, '317');
});

test('validateNoteInput trims the note and the submitter', () => {
  const r = validateNoteInput({ episode: ' 317 ', note: '  a real note  ', submittedBy: ' matt ' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.episode, '317');
    assert.equal(r.value.note, 'a real note');
    assert.equal(r.value.submittedBy, 'matt');
  }
});

test('validateNoteInput rejects a missing episode', () => {
  const r = validateNoteInput({ note: 'x'.repeat(20), submittedBy: 'matt' });
  assert.equal(r.ok, false);
});

test('validateNoteInput rejects a note that is too short to be useful', () => {
  const r = validateNoteInput({ episode: '317', note: 'ok', submittedBy: 'matt' });
  assert.equal(r.ok, false);
});

test('validateNoteInput rejects a note longer than the cell should carry', () => {
  const r = validateNoteInput({ episode: '317', note: 'x'.repeat(1001), submittedBy: 'matt' });
  assert.equal(r.ok, false);
});

test('validateNoteInput rejects a missing submitter so every note is attributable', () => {
  const r = validateNoteInput({ episode: '317', note: 'a real note here' });
  assert.equal(r.ok, false);
});

test('validateNoteInput rejects a non-object', () => {
  assert.equal(validateNoteInput(null).ok, false);
  assert.equal(validateNoteInput('note').ok, false);
});

test('validateNoteInput strips newlines so one note stays one bullet', () => {
  const r = validateNoteInput({ episode: '317', note: 'line one\nline two', submittedBy: 'matt' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.note, 'line one line two');
});

test('validateNoteInput collapses a lone \\r with no \\n', () => {
  const r = validateNoteInput({ episode: '317', note: 'line one\rline two', submittedBy: 'matt' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.note, 'line one line two');
});

test('buildNote stamps status pending and carries the id and timestamp', () => {
  const n = buildNote(
    { episode: '317', note: 'a real note here', submittedBy: 'matt' },
    'note_1_abc',
    '2026-08-03T00:00:00.000Z'
  );
  assert.equal(n.status, 'pending');
  assert.equal(n.id, 'note_1_abc');
  assert.equal(n.createdAt, '2026-08-03T00:00:00.000Z');
  assert.equal(n.resolvedAt, undefined);
});

test('isEpisodeNote accepts a well-formed note', () => {
  assert.equal(
    isEpisodeNote({
      id: 'note_1_abc',
      episode: '317',
      note: 'a real note here',
      submittedBy: 'matt',
      createdAt: '2026-08-03T00:00:00.000Z',
      status: 'pending',
    }),
    true
  );
});

test('isEpisodeNote rejects a document missing createdAt', () => {
  assert.equal(
    isEpisodeNote({
      id: 'note_1_abc',
      episode: '317',
      note: 'a real note here',
      submittedBy: 'matt',
      status: 'pending',
    }),
    false
  );
});

test('isEpisodeNote rejects a document missing status', () => {
  assert.equal(
    isEpisodeNote({
      id: 'note_1_abc',
      episode: '317',
      note: 'a real note here',
      submittedBy: 'matt',
      createdAt: '2026-08-03T00:00:00.000Z',
    }),
    false
  );
});

test('isEpisodeNote rejects null and non-objects', () => {
  assert.equal(isEpisodeNote(null), false);
  assert.equal(isEpisodeNote('note'), false);
  assert.equal(isEpisodeNote(42), false);
});

// ── normaliseNoteText ──
// Shared by validateNoteInput (submit path) and the resolve route's
// admin-edit path, so an edited note is held to the same shape as a freshly
// submitted one before it ever reaches appendToCell.

test('normaliseNoteText collapses embedded newlines to spaces', () => {
  const r = normaliseNoteText('line one\nline two\nline three');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'line one line two line three');
});

test('normaliseNoteText collapses a lone \\r with no \\n', () => {
  const r = normaliseNoteText('line one\rline two');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'line one line two');
});

test('normaliseNoteText rejects text under the minimum length', () => {
  const r = normaliseNoteText('ok');
  assert.equal(r.ok, false);
});

test('normaliseNoteText rejects text over the maximum length', () => {
  const r = normaliseNoteText('x'.repeat(1001));
  assert.equal(r.ok, false);
});

test('normaliseNoteText passes a clean value through unchanged (besides trim)', () => {
  const r = normaliseNoteText('  a perfectly normal note  ');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, 'a perfectly normal note');
});

// ── isOpenEpisode / buildThreadNote / listSyncedMessageIds ──

test('isOpenEpisode accepts a document with a threadId', () => {
  assert.equal(
    isOpenEpisode({ episode: '317', film: 'Barton Fink (1991)', openedAt: '2026-08-05T00:00:00.000Z', threadId: '123' }),
    true
  );
});

test('isOpenEpisode accepts a legacy document with no threadId at all', () => {
  // Pointers written before this feature have no threadId. Rejecting them
  // would break /pdc-note for every already-open episode.
  assert.equal(
    isOpenEpisode({ episode: '317', film: 'Barton Fink (1991)', openedAt: '2026-08-05T00:00:00.000Z' }),
    true
  );
});

test('isOpenEpisode accepts an explicit null threadId', () => {
  assert.equal(
    isOpenEpisode({ episode: '317', film: '', openedAt: '2026-08-05T00:00:00.000Z', threadId: null }),
    true
  );
});

test('isOpenEpisode rejects a wrongly typed threadId', () => {
  assert.equal(
    isOpenEpisode({ episode: '317', film: '', openedAt: '2026-08-05T00:00:00.000Z', threadId: 123 }),
    false
  );
});

test('isOpenEpisode rejects documents missing required fields', () => {
  assert.equal(isOpenEpisode({}), false);
  assert.equal(isOpenEpisode(null), false);
  assert.equal(isOpenEpisode({ episode: '317', film: '' }), false);
});

test('buildThreadNote records the message id, the source, and lands approved', () => {
  const note = buildThreadNote(
    { episode: '317', note: 'The Roy Scheider tangent', submittedBy: 'jason#0', discordMessageId: 'm1' },
    'note_1',
    '2026-08-05T00:00:00.000Z'
  );
  assert.equal(note.status, 'approved');
  assert.equal(note.source, 'thread');
  assert.equal(note.discordMessageId, 'm1');
  assert.equal(note.resolvedAt, '2026-08-05T00:00:00.000Z');
});

test('buildThreadNote output passes the isEpisodeNote guard', () => {
  const note = buildThreadNote(
    { episode: '317', note: 'A moment', submittedBy: 'jason#0', discordMessageId: 'm1' },
    'note_1',
    '2026-08-05T00:00:00.000Z'
  );
  assert.equal(isEpisodeNote(note), true);
});

test('listSyncedMessageIds collects ids and ignores notes without one', () => {
  const notes = [
    { discordMessageId: 'm1' },
    { discordMessageId: 'm2' },
    {},
    { discordMessageId: '' },
  ] as EpisodeNote[];
  const ids = listSyncedMessageIds(notes);
  assert.equal(ids.has('m1'), true);
  assert.equal(ids.has('m2'), true);
  assert.equal(ids.has(''), false);
  assert.equal(ids.size, 2);
});
