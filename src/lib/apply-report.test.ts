import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReportToTranscript } from './apply-report';
import type { Transcript } from '@/types/transcript';
import type { TranscriptionReport } from './transcription-report';

function tx(dialogues: { name: string; timestamp: string; text: string }[]): Transcript {
  return { episode_number: 119, episode_name: 'Galaxy Quest', dialogues };
}

function report(over: Partial<TranscriptionReport> = {}): TranscriptionReport {
  return {
    id: 'tr_1_abc',
    createdAt: '2026-07-18T00:00:00.000Z',
    source: 'explore',
    status: 'pending',
    episodeNumber: 119,
    anchor: { startTs: '01:12:04', speaker: 'Jason Goldman', originalText: 'jumped to lightspeed' },
    correction: { type: 'sample', field: 'name', newValue: 'Movie Sample' },
    ...over,
  };
}

test('match → mutates the resolved turn in place and returns applied+index', () => {
  const t = tx([
    { name: 'Matt Haitch', timestamp: '01:11:00', text: 'here comes the clip' },
    { name: 'Jason Goldman', timestamp: '01:12:04', text: 'jumped to lightspeed' },
  ]);
  const out = applyReportToTranscript(t, report());
  assert.deepEqual(out, { status: 'applied', index: 1 });
  assert.equal(t.dialogues[1].name, 'Movie Sample'); // field=name mutated
  assert.equal(t.dialogues[0].name, 'Matt Haitch');  // others untouched
});

test('non-match (not_found) → stale, transcript untouched', () => {
  const t = tx([{ name: 'Jason Goldman', timestamp: '00:01:00', text: 'welcome to escape hatch' }]);
  const before = JSON.stringify(t);
  const out = applyReportToTranscript(t, report());
  assert.deepEqual(out, { status: 'stale', reason: 'not_found' });
  assert.equal(JSON.stringify(t), before); // no mutation
});

test('already_fixed → stale, no mutation', () => {
  const t = tx([{ name: 'Movie Sample', timestamp: '01:12:04', text: 'unrelated words now' }]);
  const out = applyReportToTranscript(t, report());
  assert.deepEqual(out, { status: 'stale', reason: 'already_fixed' });
});

test('ambiguous → stale, no mutation', () => {
  const t = tx([
    { name: 'Jason Goldman', timestamp: '00:05:00', text: 'jumped to lightspeed' },
    { name: 'Jason Goldman', timestamp: '01:30:00', text: 'jumped to lightspeed' },
  ]);
  const out = applyReportToTranscript(t, report());
  assert.deepEqual(out, { status: 'stale', reason: 'ambiguous' });
});

test('field=text match uses overrideNewValue when provided (inline edit)', () => {
  const r = report({
    anchor: { startTs: '00:10:00', speaker: 'Jason Goldman', originalText: 'jo esther house wrote it' },
    correction: { type: 'spelling', field: 'text', newValue: 'Joe Eszterhas wrote it' },
  });
  const t = tx([{ name: 'Jason Goldman', timestamp: '00:10:00', text: 'jo esther house wrote it' }]);
  const out = applyReportToTranscript(t, r, 'Joe Eszterhas (screenwriter) wrote it');
  assert.deepEqual(out, { status: 'applied', index: 0 });
  assert.equal(t.dialogues[0].text, 'Joe Eszterhas (screenwriter) wrote it');
});
