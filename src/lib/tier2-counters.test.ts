import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countMmm, countThatsGreat } from './tier2-counters';

const turn = (name: string, text: string) => ({ name, timestamp: '00:00', text });

test('countMmm counts standalone mm/mmm/mmmm', () => {
  const r = countMmm([turn('Jason', 'Mmm. That shot. Mm.')]);
  assert.equal(r.total, 2);
});

test('countMmm does not match m inside a word', () => {
  const r = countMmm([turn('Jason', 'Communism and mammoth summer')]);
  assert.equal(r.total, 0);
});

test('countMmm does not match hmm or mm-hmm', () => {
  // "hmm" is a different vocalisation and "mm-hmm" is assent, not the bit.
  const r = countMmm([turn('Jason', 'Hmm, mm-hmm, hmmm')]);
  assert.equal(r.total, 0);
});

test('countMmm is case insensitive and counts repeats within one turn', () => {
  const r = countMmm([turn('Haitch', 'mmm MMM Mmmm')]);
  assert.equal(r.total, 3);
});

test('countMmm attributes per speaker', () => {
  const r = countMmm([turn('Jason', 'Mmm'), turn('Haitch', 'Mmm mmm')]);
  assert.equal(r.total, 3);
  assert.deepEqual(r.bySpeaker, { Jason: 1, Haitch: 2 });
});

test('countMmm returns zero for an empty transcript', () => {
  const r = countMmm([]);
  assert.equal(r.total, 0);
  assert.deepEqual(r.bySpeaker, {});
});

test("countThatsGreat matches straight and curly apostrophes and bare thats", () => {
  const r = countThatsGreat([
    turn('Jason', "That's great."),
    turn('Jason', 'That’s great!'),
    turn('Jason', 'Thats great'),
  ]);
  assert.equal(r.total, 3);
});

test('countThatsGreat tolerates extra whitespace between the words', () => {
  const r = countThatsGreat([turn('Jason', "that's   great")]);
  assert.equal(r.total, 1);
});

test('countThatsGreat does not match a longer word starting with great', () => {
  const r = countThatsGreat([turn('Jason', "That's greatness itself")]);
  assert.equal(r.total, 0);
});

test('countThatsGreat attributes per speaker', () => {
  const r = countThatsGreat([turn('Haitch', "That's great"), turn('Jason', "that's great, that's great")]);
  assert.equal(r.total, 3);
  assert.deepEqual(r.bySpeaker, { Haitch: 1, Jason: 2 });
});
