import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTier1Row, pickTmdbMatch } from './populate-tier1';
import type { TmdbSearchResult } from '../src/lib/episode-sources';

const SPOTIFY = {
  title: 'Sorcerer',
  duration: '1:42:10',
  durationMinutes: '102',
  releaseDate: '2026-08-01',
  artworkUrl: 'https://i.scdn.co/image/abc',
  spotifyUrl: 'https://open.spotify.com/episode/abc',
};

const PATREON = {
  title: 'Sorcerer',
  publishedAt: '2026-08-01T12:00:00.000Z',
  showLink: 'https://www.patreon.com/posts/sorcerer-123',
};

const TMDB = {
  tmdbId: 11423,
  title: 'Sorcerer',
  year: '1977',
  imdbId: 'tt0076740',
  imdbLink: 'https://www.imdb.com/title/tt0076740/',
  letterboxdLink: 'https://letterboxd.com/film/sorcerer/',
};

test('buildTier1Row maps all six deterministic columns', () => {
  const row = buildTier1Row('317', SPOTIFY, PATREON, TMDB);
  assert.deepEqual(row, {
    Ep: '317',
    Length: '1:42:10',
    Length_minutes: '102',
    Artwork_Link: 'https://i.scdn.co/image/abc',
    Show_Link: 'https://www.patreon.com/posts/sorcerer-123',
    IMDB_Link: 'https://www.imdb.com/title/tt0076740/',
    Letterboxd_Link: 'https://letterboxd.com/film/sorcerer/',
  });
});

test('buildTier1Row omits keys whose source returned nothing', () => {
  const row = buildTier1Row('317', null, null, null);
  assert.deepEqual(row, { Ep: '317' });
});

test('buildTier1Row omits blank artwork rather than writing an empty string', () => {
  const row = buildTier1Row('317', { ...SPOTIFY, artworkUrl: '' }, null, null);
  assert.equal('Artwork_Link' in row, false);
  assert.equal(row.Length, '1:42:10');
});

test('buildTier1Row never emits Release_Date, Film, or Reviewer', () => {
  const row = buildTier1Row('317', SPOTIFY, PATREON, TMDB);
  assert.equal('Release_Date' in row, false, 'Release_Date is Matt’s to enter');
  assert.equal('Film' in row, false);
  assert.equal('Reviewer' in row, false);
});

test('buildTier1Row omits a blank IMDB link', () => {
  const row = buildTier1Row('317', null, null, { ...TMDB, imdbId: null, imdbLink: '' });
  assert.equal('IMDB_Link' in row, false);
  assert.equal(row.Letterboxd_Link, 'https://letterboxd.com/film/sorcerer/');
});

// ── pickTmdbMatch ──

const dune1984: TmdbSearchResult = {
  id: 1,
  title: 'Dune',
  releaseDate: '1984-12-14',
  year: '1984',
  posterPath: null,
};

const dune2021: TmdbSearchResult = {
  id: 2,
  title: 'Dune',
  releaseDate: '2021-10-22',
  year: '2021',
  posterPath: null,
};

const duneMinisode2000: TmdbSearchResult = {
  id: 3,
  title: 'Dune',
  releaseDate: '2000-12-03',
  year: '2000',
  posterPath: null,
};

test('pickTmdbMatch finds the result matching a known release year among several', () => {
  // Popularity-ranked results put 2021 first, as TMDB actually returns for "Dune".
  const results = [dune2021, dune1984, duneMinisode2000];
  const match = pickTmdbMatch(results, 1984);
  assert.equal(match?.id, 1);
});

test('pickTmdbMatch finds the year match even when it is not first in the list', () => {
  const results = [dune2021, duneMinisode2000, dune1984];
  const match = pickTmdbMatch(results, 1984);
  assert.equal(match?.id, 1);
});

test('pickTmdbMatch returns null when no result matches the known year', () => {
  const results = [dune2021, duneMinisode2000];
  const match = pickTmdbMatch(results, 1984);
  assert.equal(match, null);
});

test('pickTmdbMatch falls back to the top hit when filmYear is null', () => {
  const results = [dune2021, dune1984];
  const match = pickTmdbMatch(results, null);
  assert.equal(match?.id, 2);
});

test('pickTmdbMatch returns null for an empty results list regardless of filmYear', () => {
  assert.equal(pickTmdbMatch([], 1984), null);
  assert.equal(pickTmdbMatch([], null), null);
});
