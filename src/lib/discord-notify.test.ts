import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportMessage } from './discord-notify';
import type { TranscriptionReport } from './transcription-report';

const report: TranscriptionReport = {
  id: 'tr_1_abc',
  createdAt: '2026-07-18T00:00:00.000Z',
  source: 'explore',
  status: 'pending',
  episodeNumber: 119,
  anchor: { startTs: '01:12:04', speaker: 'Jason Goldman', originalText: 'jumped to lightspeed' },
  correction: { type: 'sample', field: 'name', newValue: 'Movie Sample' },
  note: 'Galaxy Quest clip',
};

test('buildReportMessage: amber embed naming episode, type, and source', () => {
  const payload = buildReportMessage(report);
  assert.equal(payload.embeds.length, 1);
  const embed = payload.embeds[0];
  assert.equal(embed.color, 0xf59e0b);
  assert.match(embed.title, /119/);
  const fieldText = JSON.stringify(embed.fields);
  assert.match(fieldText, /sample/);
  assert.match(fieldText, /Jason Goldman/);
  assert.match(fieldText, /Movie Sample/);
  assert.match(fieldText, /explore/);
});

test('buildReportMessage: content mentions a new report is waiting', () => {
  const payload = buildReportMessage(report);
  assert.match(payload.content ?? '', /report/i);
});
