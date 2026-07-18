import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReportAnchor } from './resolve-report-anchor.ts';
import type { Transcript } from '@/types/transcript';

function tx(dialogues: { name: string; timestamp: string; text: string }[]): Transcript {
  return { episode_number: 119, episode_name: 'Galaxy Quest', dialogues };
}

const sampleReport = {
  anchor: { startTs: '01:12:04', speaker: 'Jason Goldman', originalText: 'jumped to lightspeed' },
  correction: { type: 'sample' as const, field: 'name' as const, newValue: 'Movie Sample' },
};

test('exact single text match → match with that index', () => {
  const t = tx([
    { name: 'Matt Haitch', timestamp: '01:11:00', text: 'here comes the clip' },
    { name: 'Jason Goldman', timestamp: '01:12:04', text: 'jumped to lightspeed' },
  ]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'match', index: 1 });
});

test('whitespace/case differences still match', () => {
  const t = tx([{ name: 'Jason Goldman', timestamp: '01:12:04', text: '  Jumped   to LIGHTSPEED ' }]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'match', index: 0 });
});

test('already fixed (name already Movie Sample) → already_fixed', () => {
  const t = tx([{ name: 'Movie Sample', timestamp: '01:12:04', text: 'totally different words now' }]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'already_fixed' });
});

test('text not present anywhere → not_found', () => {
  const t = tx([{ name: 'Jason Goldman', timestamp: '00:01:00', text: 'welcome to escape hatch' }]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'not_found' });
});

test('duplicate text at different timestamps → ambiguous (both indexes)', () => {
  const t = tx([
    { name: 'Jason Goldman', timestamp: '00:05:00', text: 'jumped to lightspeed' },
    { name: 'Jason Goldman', timestamp: '01:30:00', text: 'jumped to lightspeed' },
  ]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'ambiguous', indexes: [0, 1] });
});

test('duplicate text but startTs disambiguates → match', () => {
  const t = tx([
    { name: 'Jason Goldman', timestamp: '00:05:00', text: 'jumped to lightspeed' },
    { name: 'Jason Goldman', timestamp: '01:12:04', text: 'jumped to lightspeed' },
  ]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'match', index: 1 });
});

test('field=text already fixed (turn text equals newValue) → already_fixed', () => {
  const textReport = {
    anchor: { startTs: '00:10:00', speaker: 'Jason Goldman', originalText: 'jo esther house wrote it' },
    correction: { type: 'spelling' as const, field: 'text' as const, newValue: 'Joe Eszterhas wrote it' },
  };
  const t = tx([{ name: 'Jason Goldman', timestamp: '00:10:00', text: 'Joe Eszterhas wrote it' }]);
  assert.deepEqual(resolveReportAnchor(t, textReport), { status: 'already_fixed' });
});
