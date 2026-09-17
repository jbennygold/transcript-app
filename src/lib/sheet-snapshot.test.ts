import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, fromCsv, tabFileStem, buildManifest, normalizeGrid } from './sheet-snapshot';

test('toCsv quotes fields containing commas, quotes, or newlines and escapes quotes', () => {
  const rows = [
    ['Film', 'Note'],
    ['Heat (1995)', 'Says "hi", then\nleaves'],
  ];
  assert.equal(toCsv(rows), 'Film,Note\r\nHeat (1995),"Says ""hi"", then\nleaves"\r\n');
});

test('toCsv leaves plain fields and empty cells unquoted; formulas with commas get quoted', () => {
  assert.equal(toCsv([['a', '', '=G2*1440', '=G2/TIME(0,0,60)']]), 'a,,=G2*1440,"=G2/TIME(0,0,60)"\r\n');
});

test('fromCsv round-trips toCsv output including embedded newlines and ragged rows', () => {
  const rows = [
    ['Pod', 'Ep', 'Notes'],
    ['EH', '1', 'line one\nline two, with comma'],
    ['EH', '2'],
    ['', '', 'only third'],
  ];
  assert.deepEqual(fromCsv(toCsv(rows)), rows);
});

test('fromCsv returns [] for empty input', () => {
  assert.deepEqual(fromCsv(''), []);
});

test('normalizeGrid stringifies numbers and booleans and turns null/undefined into empty strings', () => {
  assert.deepEqual(normalizeGrid([[1, true, null, 'x'], [undefined, 2.5]]), [
    ['1', 'true', '', 'x'],
    ['', '2.5'],
  ]);
});

test('tabFileStem makes a stable filesystem-safe name from a tab title', () => {
  assert.equal(tabFileStem('Pod Data Detail'), 'pod-data-detail');
  assert.equal(tabFileStem("Kev's Question / test?"), 'kevs-question-test');
  assert.equal(tabFileStem('  episodes  '), 'episodes');
});

test('buildManifest records tab order, stems, sizes, and the spreadsheet id', () => {
  const manifest = buildManifest('SHEET123', [
    { title: 'Pod Data Detail', sheetId: 0, index: 0, rowCount: 334, columnCount: 33 },
    { title: 'Truthsayer', sheetId: 42, index: 1, rowCount: 190, columnCount: 22 },
  ]);
  assert.equal(manifest.spreadsheetId, 'SHEET123');
  assert.deepEqual(manifest.tabs, [
    { title: 'Pod Data Detail', sheetId: 0, index: 0, stem: 'pod-data-detail', rowCount: 334, columnCount: 33 },
    { title: 'Truthsayer', sheetId: 42, index: 1, stem: 'truthsayer', rowCount: 190, columnCount: 22 },
  ]);
});

test('buildManifest rejects two tabs that would share a file stem', () => {
  assert.throws(
    () =>
      buildManifest('S', [
        { title: 'Foo Bar', sheetId: 1, index: 0, rowCount: 1, columnCount: 1 },
        { title: 'foo-bar', sheetId: 2, index: 1, rowCount: 1, columnCount: 1 },
      ]),
    /stem/
  );
});
