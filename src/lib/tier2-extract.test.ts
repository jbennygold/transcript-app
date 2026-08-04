import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findKevSegment,
  renderTranscriptForPrompt,
  parseKevResponse,
  parseTildaResponse,
} from './tier2-extract';

const turn = (name: string, text: string, timestamp = '00:00') => ({ name, timestamp, text });

test('findKevSegment returns the Kev turns plus following context', () => {
  const dialogues = [
    turn('Jason', 'Before'),
    turn('Kev', 'Hey fellas, my question this week'),
    turn('Haitch', 'Good question Kev'),
    turn('Jason', 'I would say Walken'),
  ];
  const seg = findKevSegment(dialogues);
  assert.ok(seg.length >= 2);
  assert.equal(seg[0].name, 'Kev');
  assert.ok(seg.some(t => t.text.includes('Walken')));
});

test('findKevSegment matches the mapped voicemail speaker label', () => {
  const seg = findKevSegment([turn('kev voicemail', 'My question is')]);
  assert.equal(seg.length, 1);
});

test('findKevSegment is case insensitive on the speaker name', () => {
  assert.equal(findKevSegment([turn('KEV', 'question')]).length, 1);
});

test('findKevSegment returns empty when Kev never speaks', () => {
  assert.deepEqual(findKevSegment([turn('Jason', 'no kev here')]), []);
});

test('findKevSegment does not match a host who merely says the word kev', () => {
  assert.deepEqual(findKevSegment([turn('Jason', 'Kev asked us something')]), []);
});

test('renderTranscriptForPrompt labels each turn with speaker and timestamp', () => {
  const out = renderTranscriptForPrompt([turn('Jason', 'Hello', '12:45')]);
  assert.match(out, /\[12:45\] Jason: Hello/);
});

test('renderTranscriptForPrompt truncates at a turn boundary, not mid-turn', () => {
  const dialogues = [turn('A', 'x'.repeat(50)), turn('B', 'y'.repeat(50))];
  const out = renderTranscriptForPrompt(dialogues, 60);
  assert.ok(out.includes('x'.repeat(50)));
  assert.ok(!out.includes('y'.repeat(50)));
});

test('parseKevResponse reads a well-formed JSON object', () => {
  const r = parseKevResponse('{"question":"What is your favourite?","evidence":"Kev at 12:45"}');
  assert.equal(r.question, 'What is your favourite?');
  assert.equal(r.evidence, 'Kev at 12:45');
});

test('parseKevResponse tolerates a fenced code block', () => {
  const r = parseKevResponse('```json\n{"question":"Q","evidence":null}\n```');
  assert.equal(r.question, 'Q');
  assert.equal(r.evidence, null);
});

test('parseKevResponse returns nulls on unparseable output rather than throwing', () => {
  const r = parseKevResponse('I could not find a question.');
  assert.equal(r.question, null);
  assert.equal(r.evidence, null);
});

test('parseKevResponse treats an empty or N/A question as null', () => {
  assert.equal(parseKevResponse('{"question":"","evidence":null}').question, null);
  assert.equal(parseKevResponse('{"question":"N/A","evidence":null}').question, null);
});

test('parseTildaResponse maps all four roles', () => {
  const r = parseTildaResponse('{"tildaH":"Audrey","tildaJason":"Barton","tildaGuest":null,"tildaCorey":null}');
  assert.equal(r.tildaH, 'Audrey');
  assert.equal(r.tildaJason, 'Barton');
  assert.equal(r.tildaGuest, null);
  assert.equal(r.tildaCorey, null);
});

test('parseTildaResponse treats missing keys as null rather than undefined', () => {
  const r = parseTildaResponse('{"tildaH":"Audrey"}');
  assert.equal(r.tildaJason, null);
  assert.equal(r.tildaGuest, null);
  assert.equal(r.tildaCorey, null);
});

test('parseTildaResponse returns all nulls on unparseable output', () => {
  const r = parseTildaResponse('no json here');
  assert.deepEqual(r, { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null });
});
