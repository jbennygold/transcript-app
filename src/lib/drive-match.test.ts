import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFolderName,
  extractYear,
  scoreFolderAgainstFilm,
  nameSimilarity,
  suggestFolders,
} from './drive-match';

test('normalizeFolderName strips articles, punctuation, year, and boilerplate', () => {
  assert.equal(normalizeFolderName('The Sorcerer (1977)'), 'sorcerer');
  assert.equal(normalizeFolderName('Episode 42: Jaws'), 'jaws');
  assert.equal(normalizeFolderName('BONUS Civil War'), 'civil war');
});

test('extractYear reads a parenthesised or bare year', () => {
  assert.equal(extractYear('Sorcerer (1977)'), 1977);
  assert.equal(extractYear('Sorcerer 1977'), 1977);
  assert.equal(extractYear('Sorcerer'), null);
});

test('scoreFolderAgainstFilm gives an exact normalized match the top score', () => {
  assert.equal(scoreFolderAgainstFilm('Sorcerer', 'Sorcerer (1977)'), 100);
});

test('scoreFolderAgainstFilm adds a bonus when both years agree', () => {
  assert.equal(scoreFolderAgainstFilm('Sorcerer (1977)', 'Sorcerer (1977)'), 110);
});

test('scoreFolderAgainstFilm zeroes out when the years disagree', () => {
  assert.equal(scoreFolderAgainstFilm('Sorcerer (1977)', 'Sorcerer (1985)'), 0);
});

test('scoreFolderAgainstFilm rejects a short substring collision', () => {
  assert.equal(scoreFolderAgainstFilm('Her', 'The Godfather'), 0);
});

test('scoreFolderAgainstFilm scores substantial word overlap between 50 and 80', () => {
  const score = scoreFolderAgainstFilm('French Connection II', 'The French Connection');
  assert.ok(score >= 50 && score <= 80, `expected 50..80, got ${score}`);
});

test('nameSimilarity scores a one-character typo close to 1', () => {
  assert.ok(nameSimilarity('sorceror', 'sorcerer') > 0.8);
});

test('nameSimilarity scores unrelated names near 0', () => {
  assert.ok(nameSimilarity('jaws', 'sorcerer') < 0.3);
});

test('suggestFolders surfaces a misspelled folder that word overlap cannot see', () => {
  // The motivating case: word-overlap scoring rates these 0, because
  // "sorceror" and "sorcerer" share no whole word.
  assert.equal(scoreFolderAgainstFilm('Sorceror', 'Sorcerer (1977)'), 0);

  const folders = ['Jaws', 'Sorceror', 'The Thing', 'Alien'];
  const suggestions = suggestFolders('Sorcerer (1977)', folders, 3);
  assert.equal(suggestions[0], 'Sorceror');
  assert.ok(!suggestions.includes('Alien'));
});

test('suggestFolders returns an empty list when nothing is close', () => {
  assert.deepEqual(suggestFolders('Sorcerer (1977)', ['Alien', 'Jaws']), []);
});

test('suggestFolders honours the limit', () => {
  const folders = ['Sorceror', 'Sorcerer', 'Sorcerers', 'Sorcerar'];
  assert.equal(suggestFolders('Sorcerer (1977)', folders, 2).length, 2);
});
