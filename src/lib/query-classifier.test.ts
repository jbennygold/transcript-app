import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuerySync, isMentionSearchQuery } from './query-classifier';

test('isMentionSearchQuery matches mention-search phrasing', () => {
  for (const q of [
    'Look for mentions of “digger” an unreleased movie',
    'has anyone mentioned Heat',
    'did they ever bring up Kubrick',
    'episodes that reference the Zardoz outfit',
    'search for the word Kestrel',
  ]) {
    assert.equal(isMentionSearchQuery(q), true, q);
  }
});

test('isMentionSearchQuery ignores plain metadata queries', () => {
  for (const q of ['Tim Burton movies', 'Proto episodes', '80s movies with Jason']) {
    assert.equal(isMentionSearchQuery(q), false, q);
  }
});

test('classifyQuerySync forces transcript depth for mention searches with filters', () => {
  assert.equal(classifyQuerySync('mentions of 80s movies').requiresTranscriptDepth, true);
});
