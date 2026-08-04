import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarise, resolveTranscriptPath } from './calibrate-counters';

const rows = [
  { episode: '1', field: 'MMM_Count', expected: 10, actual: 10 },
  { episode: '2', field: 'MMM_Count', expected: 10, actual: 12 },
  { episode: '3', field: 'MMM_Count', expected: 10, actual: 7 },
];

test('summarise reports count, exact matches, and mean absolute error', () => {
  const s = summarise(rows);
  assert.equal(s.n, 3);
  assert.equal(s.exact, 1);
  assert.equal(s.meanAbsoluteError, (0 + 2 + 3) / 3);
});

test('summarise reports mean signed error so bias direction is visible', () => {
  // +2 and -3 cancel to -1/3: the rule undercounts slightly on average.
  assert.equal(summarise(rows).meanSignedError, (0 + 2 - 3) / 3);
});

test('summarise reports the share within a tolerance of 2', () => {
  const s = summarise(rows);
  assert.equal(s.withinTwo, 2 / 3);
});

test('summarise handles an empty set without dividing by zero', () => {
  const s = summarise([]);
  assert.equal(s.n, 0);
  assert.equal(s.meanAbsoluteError, 0);
  assert.equal(s.meanSignedError, 0);
  assert.equal(s.withinTwo, 0);
});

test('summarise treats a perfect rule as exact for every row', () => {
  const s = summarise([
    { episode: '1', field: 'MMM_Count', expected: 4, actual: 4 },
    { episode: '2', field: 'MMM_Count', expected: 9, actual: 9 },
  ]);
  assert.equal(s.exact, 2);
  assert.equal(s.meanAbsoluteError, 0);
});

test('resolveTranscriptPath', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-counters-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await t.test('prefers the zero-padded file when both exist', () => {
    fs.writeFileSync(path.join(dir, 'episode_06.json'), '{}');
    fs.writeFileSync(path.join(dir, 'episode_6.json'), '{}');
    assert.equal(resolveTranscriptPath(dir, 6), path.join(dir, 'episode_06.json'));
  });

  await t.test('falls back to the unpadded file when only that exists', () => {
    fs.writeFileSync(path.join(dir, 'episode_7.json'), '{}');
    assert.equal(resolveTranscriptPath(dir, 7), path.join(dir, 'episode_7.json'));
  });

  await t.test('resolves a zero-padded-only episode from a bare-number id', () => {
    fs.writeFileSync(path.join(dir, 'episode_08.json'), '{}');
    assert.equal(resolveTranscriptPath(dir, 8), path.join(dir, 'episode_08.json'));
  });

  await t.test('returns null when neither form exists', () => {
    assert.equal(resolveTranscriptPath(dir, 999), null);
  });

  await t.test('is unaffected by padStart(2) for three-digit episodes', () => {
    fs.writeFileSync(path.join(dir, 'episode_317.json'), '{}');
    assert.equal(resolveTranscriptPath(dir, 317), path.join(dir, 'episode_317.json'));
  });

  await t.test('non-numeric (bonus) episode ids are used as-is, no padding', () => {
    fs.writeFileSync(path.join(dir, 'episode_49b1.json'), '{}');
    assert.equal(resolveTranscriptPath(dir, '49b1'), path.join(dir, 'episode_49b1.json'));
  });
});
