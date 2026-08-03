import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle,
  isVideoOrUncut,
  scoreMatch,
  formatDuration,
  formatDurationMinutes,
  letterboxdSlug,
  buildTmdbDetails,
} from './episode-sources';

test('normalizeTitle strips year, punctuation, and collapses whitespace', () => {
  assert.equal(normalizeTitle('Sorcerer (1977)'), 'sorcerer');
  assert.equal(normalizeTitle("What's  Up,  Doc?"), 'whats up doc');
});

test('isVideoOrUncut flags video and uncut variants', () => {
  assert.equal(isVideoOrUncut('Sorcerer VIDEO'), true);
  assert.equal(isVideoOrUncut('Sorcerer — Uncut'), true);
  assert.equal(isVideoOrUncut('Sorcerer'), false);
});

test('scoreMatch returns 1.0 for an exact normalized match', () => {
  assert.equal(scoreMatch('Sorcerer (1977)', 'Sorcerer'), 1.0);
});

test('scoreMatch returns 0.8 when one title contains the other', () => {
  assert.equal(scoreMatch('Sorcerer', 'Escape Hatch: Sorcerer'), 0.8);
});

test('scoreMatch falls back to word overlap', () => {
  assert.equal(scoreMatch('The French Connection', 'French Connection II Redux'), 2 / 3);
});

test('scoreMatch returns 0 when nothing overlaps', () => {
  assert.equal(scoreMatch('Sorcerer', 'Jaws'), 0);
});

test('formatDuration renders H:MM:SS with zero padding', () => {
  assert.equal(formatDuration(6130000), '1:42:10');
  assert.equal(formatDuration(605000), '0:10:05');
});

test('formatDurationMinutes rounds to the nearest minute', () => {
  assert.equal(formatDurationMinutes(6130000), '102');
  assert.equal(formatDurationMinutes(29000), '0');
});

test('letterboxdSlug lowercases and hyphenates', () => {
  assert.equal(letterboxdSlug('The French Connection'), 'the-french-connection');
  assert.equal(letterboxdSlug("What's Up, Doc?"), 'whats-up-doc');
});

test('buildTmdbDetails composes imdb and letterboxd links', () => {
  const details = buildTmdbDetails({
    id: 11423,
    title: 'Sorcerer',
    release_date: '1977-06-24',
    imdb_id: 'tt0076740',
  });
  assert.equal(details.tmdbId, 11423);
  assert.equal(details.year, '1977');
  assert.equal(details.imdbLink, 'https://www.imdb.com/title/tt0076740/');
  assert.equal(details.letterboxdLink, 'https://letterboxd.com/film/sorcerer/');
});

test('buildTmdbDetails leaves imdbLink blank when there is no imdb id', () => {
  const details = buildTmdbDetails({ id: 1, title: 'Sorcerer', release_date: '', imdb_id: null });
  assert.equal(details.imdbLink, '');
  assert.equal(details.year, null);
});
