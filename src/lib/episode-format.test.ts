import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisodeId } from './episode-format';

test('parseEpisodeId parses a plain numeric id as a number', () => {
  assert.equal(parseEpisodeId('316'), 316);
  assert.equal(typeof parseEpisodeId('316'), 'number');
});

test('parseEpisodeId keeps a bonus id as a string', () => {
  assert.equal(parseEpisodeId('147b1'), '147b1');
  assert.equal(typeof parseEpisodeId('147b1'), 'string');
});

test('parseEpisodeId trims surrounding whitespace before parsing', () => {
  assert.equal(parseEpisodeId('  316  '), 316);
  assert.equal(parseEpisodeId(' 147b1 '), '147b1');
});

test('parseEpisodeId handles zero-padded and large numeric ids', () => {
  assert.equal(parseEpisodeId('007'), 7);
  assert.equal(parseEpisodeId('123456'), 123456);
});
