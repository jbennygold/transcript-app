import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapHeaders,
  mergeRow,
  findRowIndexByEpisode,
  buildNewRow,
} from './pdc-sheet';

const HEADERS = ['Pod', 'Season', 'Ep', 'Film', 'Length', "Kev's Question", 'MMM Count'];

test('mapHeaders resolves canonical keys and aliases to column indexes', () => {
  const map = mapHeaders(HEADERS);
  assert.equal(map.get('Pod'), 0);
  assert.equal(map.get('Ep'), 2);
  assert.equal(map.get('Film'), 3);
  assert.equal(map.get('Kevs_Question'), 5);
  assert.equal(map.get('MMM_Count'), 6);
});

test('mapHeaders omits columns absent from the sheet', () => {
  const map = mapHeaders(HEADERS);
  assert.equal(map.has('TildaCorey'), false);
});

test('mapHeaders prefers the first alias that matches', () => {
  const map = mapHeaders(['Episode', 'Ep']);
  assert.equal(map.get('Ep'), 1, 'canonical "Ep" is listed first in HEADER_ALIASES');
});

test('mergeRow overwrite: writes changed values and reports them', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '', '', '0'];
  const { updatedRow, changedFields } = mergeRow(
    existing,
    { Length: '1:42:10', MMM_Count: '4' },
    map,
    'overwrite'
  );
  assert.equal(updatedRow[4], '1:42:10');
  assert.equal(updatedRow[6], '4');
  assert.deepEqual(changedFields.sort(), ['Length', 'MMM_Count']);
});

test('mergeRow overwrite: replaces an existing non-blank value', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:00:00', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'overwrite');
  assert.equal(updatedRow[4], '1:42:10');
  assert.deepEqual(changedFields, ['Length']);
});

test('mergeRow never writes a blank over an existing value', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:00:00', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '' }, map, 'overwrite');
  assert.equal(updatedRow[4], '1:00:00');
  assert.deepEqual(changedFields, []);
});

test('mergeRow reports no change when the value already matches', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:42:10', '', '0'];
  const { changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'overwrite');
  assert.deepEqual(changedFields, []);
});

test('mergeRow pads a short row out to the widest mapped column', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317'];
  const { updatedRow } = mergeRow(existing, { MMM_Count: '4' }, map, 'overwrite');
  assert.equal(updatedRow.length, 7);
  assert.equal(updatedRow[6], '4');
  assert.equal(updatedRow[4], '');
});

test('findRowIndexByEpisode matches case-insensitively and ignores surrounding space', () => {
  const rows = [HEADERS, ['EH', '9', '316', 'A'], ['EH', '9', ' 147B1 ', 'B']];
  assert.equal(findRowIndexByEpisode(rows, 2, '147b1'), 2);
  assert.equal(findRowIndexByEpisode(rows, 2, '316'), 1);
  assert.equal(findRowIndexByEpisode(rows, 2, '999'), -1);
});

test('buildNewRow places values at mapped indexes and blanks the rest', () => {
  const map = mapHeaders(HEADERS);
  const row = buildNewRow({ Pod: 'EH', Ep: '317', Film: 'Sorcerer (1977)' }, map);
  assert.deepEqual(row, ['EH', '', '317', 'Sorcerer (1977)', '', '', '']);
});

test('mergeRow fill-empty: fills a blank cell', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'fill-empty');
  assert.equal(updatedRow[4], '1:42:10');
  assert.deepEqual(changedFields, ['Length']);
});

test('mergeRow fill-empty: leaves a human-entered value alone', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:00:00', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'fill-empty');
  assert.equal(updatedRow[4], '1:00:00');
  assert.deepEqual(changedFields, []);
});

test('mergeRow fill-empty: treats a whitespace-only cell as blank', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '   ', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'fill-empty');
  assert.equal(updatedRow[4], '1:42:10');
  assert.deepEqual(changedFields, ['Length']);
});

test('mergeRow fill-empty: treats a missing trailing cell as blank', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)'];
  const { updatedRow, changedFields } = mergeRow(existing, { MMM_Count: '4' }, map, 'fill-empty');
  assert.equal(updatedRow[6], '4');
  assert.deepEqual(changedFields, ['MMM_Count']);
});

test('mergeRow fill-empty: mixed row fills only the blanks', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:00:00', '', ''];
  const { updatedRow, changedFields } = mergeRow(
    existing,
    { Length: '1:42:10', Kevs_Question: 'What is your favourite?', MMM_Count: '4' },
    map,
    'fill-empty'
  );
  assert.equal(updatedRow[4], '1:00:00', 'existing Length preserved');
  assert.equal(updatedRow[5], 'What is your favourite?');
  assert.equal(updatedRow[6], '4');
  assert.deepEqual(changedFields.sort(), ['Kevs_Question', 'MMM_Count']);
});
