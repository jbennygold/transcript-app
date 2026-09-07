import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transcript } from '@/types/transcript';
import {
  formatTranscriptForPrompt,
  parseTriviaCandidates,
  verifyCandidate,
  pickVerifiedTrivia,
} from './trivia';

const transcript: Transcript = {
  episode_name: 'Inception',
  dialogues: [
    { name: 'Haitch', timestamp: '00:01:00', text: 'Welcome back to the show.' },
    {
      name: 'Jason',
      timestamp: '00:12:34',
      text: 'Nolan wrote the first draft of Inception back in 2001, and sat on it for almost a decade.',
    },
    { name: 'Corey', timestamp: '00:12:50', text: "That's great." },
  ],
} as Transcript;

test('formatTranscriptForPrompt numbers turns with speaker and text', () => {
  const out = formatTranscriptForPrompt(transcript);
  assert.match(out, /^\[0\] Haitch: Welcome back to the show\.$/m);
  assert.match(out, /^\[1\] Jason: Nolan wrote the first draft/m);
  assert.match(out, /^\[2\] Corey: That's great\.$/m);
});

test('formatTranscriptForPrompt truncates to the character budget on a turn boundary', () => {
  const out = formatTranscriptForPrompt(transcript, 60);
  assert.ok(out.length <= 60, `expected <= 60 chars, got ${out.length}`);
  assert.match(out, /^\[0\] Haitch/);
  assert.doesNotMatch(out, /\[1\]/);
});

test('parseTriviaCandidates reads a bare JSON array', () => {
  const raw = '[{"fact":"Nolan wrote it in 2001.","turn":1,"quote":"first draft of Inception back in 2001"}]';
  assert.deepEqual(parseTriviaCandidates(raw), [
    { fact: 'Nolan wrote it in 2001.', turn: 1, quote: 'first draft of Inception back in 2001' },
  ]);
});

test('parseTriviaCandidates tolerates a fenced code block and prose around it', () => {
  const raw = 'Here you go:\n```json\n[{"fact":"A","turn":2,"quote":"q"}]\n```\nThanks!';
  assert.deepEqual(parseTriviaCandidates(raw), [{ fact: 'A', turn: 2, quote: 'q' }]);
});

test('parseTriviaCandidates drops malformed entries and returns [] on garbage', () => {
  const raw = '[{"fact":"ok","turn":1,"quote":"x"},{"fact":"no turn","quote":"y"},{"turn":"1","quote":"z","fact":"bad type"},"str"]';
  assert.deepEqual(parseTriviaCandidates(raw), [{ fact: 'ok', turn: 1, quote: 'x' }]);
  assert.deepEqual(parseTriviaCandidates('not json at all'), []);
  assert.deepEqual(parseTriviaCandidates('{"fact":"obj not array"}'), []);
});

test('verifyCandidate resolves speaker and timestamp when the quote is in the cited turn', () => {
  const result = verifyCandidate(
    { fact: 'Nolan first drafted it in 2001.', turn: 1, quote: 'first draft of Inception back in 2001' },
    transcript
  );
  assert.deepEqual(result, {
    fact: 'Nolan first drafted it in 2001.',
    quote: 'first draft of Inception back in 2001',
    speaker: 'Jason',
    timestamp: '00:12:34',
  });
});

test('verifyCandidate ignores case and whitespace differences in the quote', () => {
  const result = verifyCandidate(
    { fact: 'f', turn: 1, quote: 'nolan  wrote the FIRST draft' },
    transcript
  );
  assert.equal(result?.speaker, 'Jason');
});

test('verifyCandidate rejects a quote that is not in the cited turn', () => {
  assert.equal(
    verifyCandidate({ fact: 'f', turn: 1, quote: 'Leonardo DiCaprio improvised the ending' }, transcript),
    null
  );
});

test('verifyCandidate rejects an out-of-range turn, an empty quote, and an empty fact', () => {
  assert.equal(verifyCandidate({ fact: 'f', turn: 99, quote: 'Welcome back' }, transcript), null);
  assert.equal(verifyCandidate({ fact: 'f', turn: -1, quote: 'Welcome back' }, transcript), null);
  assert.equal(verifyCandidate({ fact: 'f', turn: 0, quote: '   ' }, transcript), null);
  assert.equal(verifyCandidate({ fact: '  ', turn: 0, quote: 'Welcome back' }, transcript), null);
});

test('pickVerifiedTrivia picks among verified candidates using the supplied random source', () => {
  const candidates = [
    { fact: 'bogus', turn: 0, quote: 'not present anywhere' },
    { fact: 'A', turn: 0, quote: 'Welcome back' },
    { fact: 'B', turn: 1, quote: 'almost a decade' },
  ];
  assert.equal(pickVerifiedTrivia(candidates, transcript, () => 0)?.fact, 'A');
  assert.equal(pickVerifiedTrivia(candidates, transcript, () => 0.99)?.fact, 'B');
});

test('pickVerifiedTrivia returns null when nothing verifies', () => {
  assert.equal(
    pickVerifiedTrivia([{ fact: 'x', turn: 0, quote: 'nope' }], transcript, () => 0),
    null
  );
});
