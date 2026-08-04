import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNoteId, validateNoteInput, buildNote } from './episode-notes';

test('newNoteId is stable for the same inputs and sortable by time', () => {
  const a = newNoteId(1000, 'abc');
  const b = newNoteId(2000, 'abc');
  assert.equal(a, newNoteId(1000, 'abc'));
  assert.ok(a < b, 'later timestamps must sort after earlier ones');
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
