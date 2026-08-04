import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise } from './calibrate-counters';

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
