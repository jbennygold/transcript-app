import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReportInput,
  buildReport,
  newReportId,
  isTranscriptionReport,
  type ReportInput,
  type TranscriptionReport,
} from './transcription-report';

const goodBody = {
  episode: 119,
  anchor: {
    startTs: '01:12:04',
    endTs: '01:12:31',
    speaker: 'Jason Goldman',
    originalText: 'and then the ship jumped to lightspeed',
  },
  correction: { type: 'sample', field: 'name', newValue: 'Movie Sample' },
  note: 'Galaxy Quest clip',
  reporterName: 'matt-explore',
};

test('validateReportInput: accepts a well-formed body', () => {
  const r = validateReportInput(goodBody);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.episodeNumber, 119);
    assert.equal(r.value.correction.type, 'sample');
    assert.equal(r.value.anchor.speaker, 'Jason Goldman');
  }
});

test('validateReportInput: rejects missing episode', () => {
  const r = validateReportInput({ ...goodBody, episode: undefined });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects non-integer episode', () => {
  const r = validateReportInput({ ...goodBody, episode: 3.5 });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects bad correction type', () => {
  const r = validateReportInput({
    ...goodBody,
    correction: { type: 'bogus', field: 'name', newValue: 'x' },
  });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects empty originalText', () => {
  const r = validateReportInput({
    ...goodBody,
    anchor: { ...goodBody.anchor, originalText: '   ' },
  });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects newValue equal to speaker for field=name', () => {
  const r = validateReportInput({
    ...goodBody,
    correction: { type: 'sample', field: 'name', newValue: 'Jason Goldman' },
  });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects newValue equal to originalText for field=text', () => {
  const r = validateReportInput({
    ...goodBody,
    correction: {
      type: 'spelling',
      field: 'text',
      newValue: goodBody.anchor.originalText,
    },
  });
  assert.equal(r.ok, false);
});

test('buildReport: composes a pending report from input + meta', () => {
  const input = validateReportInput(goodBody);
  assert.equal(input.ok, true);
  if (!input.ok) return;
  const report = buildReport(input.value, {
    id: 'tr_1_abc',
    createdAt: '2026-07-18T00:00:00.000Z',
    source: 'explore',
  });
  assert.equal(report.status, 'pending');
  assert.equal(report.source, 'explore');
  assert.equal(report.id, 'tr_1_abc');
  assert.equal(report.episodeNumber, 119);
  assert.equal(report.resolvedTurnIndex, undefined);
});

test('newReportId: is deterministic given now + rand', () => {
  assert.equal(newReportId(1000, 'abcd'), 'tr_1000_abcd');
});

const goodReport: TranscriptionReport = {
  id: 'tr_1_abc',
  episodeNumber: 119,
  createdAt: '2026-07-18T00:00:00.000Z',
  source: 'explore',
  status: 'pending',
  anchor: {
    startTs: '01:12:04',
    endTs: '01:12:31',
    speaker: 'Jason Goldman',
    originalText: 'and then the ship jumped to lightspeed',
  },
  correction: { type: 'sample', field: 'name', newValue: 'Movie Sample' },
  note: 'Galaxy Quest clip',
  reporterName: 'matt-explore',
};

test('isTranscriptionReport: accepts a well-formed report', () => {
  assert.equal(isTranscriptionReport(goodReport), true);
});

test('isTranscriptionReport: accepts a report built via buildReport', () => {
  const input = validateReportInput(goodBody);
  assert.equal(input.ok, true);
  if (!input.ok) return;
  const report = buildReport(input.value, {
    id: 'tr_1_abc',
    createdAt: '2026-07-18T00:00:00.000Z',
    source: 'explore',
  });
  assert.equal(isTranscriptionReport(report), true);
});

test('isTranscriptionReport: rejects a document missing createdAt', () => {
  const { createdAt: _createdAt, ...rest } = goodReport;
  assert.equal(isTranscriptionReport(rest), false);
});

test('isTranscriptionReport: rejects a document missing status', () => {
  const { status: _status, ...rest } = goodReport;
  assert.equal(isTranscriptionReport(rest), false);
});

test('isTranscriptionReport: rejects a document missing anchor', () => {
  const { anchor: _anchor, ...rest } = goodReport;
  assert.equal(isTranscriptionReport(rest), false);
});

test('isTranscriptionReport: rejects a document with a malformed anchor', () => {
  assert.equal(
    isTranscriptionReport({ ...goodReport, anchor: { startTs: '01:12:04' } }),
    false
  );
});

test('isTranscriptionReport: rejects a document missing correction', () => {
  const { correction: _correction, ...rest } = goodReport;
  assert.equal(isTranscriptionReport(rest), false);
});

test('isTranscriptionReport: rejects a document with a malformed correction', () => {
  assert.equal(
    isTranscriptionReport({ ...goodReport, correction: { type: 'sample' } }),
    false
  );
});

test('isTranscriptionReport: rejects null and non-objects', () => {
  assert.equal(isTranscriptionReport(null), false);
  assert.equal(isTranscriptionReport('report'), false);
  assert.equal(isTranscriptionReport(42), false);
});
