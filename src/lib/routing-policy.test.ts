import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClassificationResult } from '@/types/episode-metadata';
import { shouldUseFastInterpretiveTuning } from './routing-policy';

const interpretive: ClassificationResult = { type: 'interpretive', confidence: 0.9, filters: {}, requiresTranscriptDepth: true };

test('quick interpretive queries use fast tuning', () => {
  assert.equal(shouldUseFastInterpretiveTuning('what did they think about Alien', 'quick', interpretive), true);
});

test('mention searches skip fast tuning', () => {
  assert.equal(shouldUseFastInterpretiveTuning('Look for mentions of “digger” an unreleased movie', 'quick', interpretive), false);
});

test('deep and non-interpretive queries skip fast tuning', () => {
  assert.equal(shouldUseFastInterpretiveTuning('what did they think about Alien', 'deep', interpretive), false);
  assert.equal(shouldUseFastInterpretiveTuning('Tim Burton movies', 'quick', { ...interpretive, type: 'factual' }), false);
});
