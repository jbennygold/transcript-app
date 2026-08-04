import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findKevSegment,
  renderTranscriptForPrompt,
  parseKevResponse,
  parseTildaResponse,
  isSpeakerMapped,
  extractTildaPicks,
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

test('findKevSegment stops before a stray Kev label after a long gap', () => {
  // A speaker-mapping slip can label one unrelated turn "Kev" far later in
  // the episode. Without a gap cutoff, the segment would run from the real
  // voicemail all the way to that stray label — potentially the whole
  // episode (episode_268: 1,221 of 1,234 turns before this fix).
  const filler = Array.from({ length: 25 }, (_, i) => turn('Jason', `filler ${i}`));
  const dialogues = [
    turn('Jason', 'before'),
    turn('Kev', 'first cluster question'),
    turn('Haitch', 'answer'),
    turn('Jason', 'more chat'),
    ...filler,
    turn('Kev', 'stray second cluster'),
    turn('Haitch', 'reaction'),
  ];
  const seg = findKevSegment(dialogues);
  assert.ok(seg.some(t => t.text === 'first cluster question'));
  assert.ok(!seg.some(t => t.text === 'stray second cluster'), 'a separated later cluster must be excluded');
});

test('findKevSegment captures a contiguous multi-turn Kev block in full', () => {
  const dialogues = [
    turn('Jason', 'intro'),
    turn('Kev', 'part one of the question'),
    turn('Kev', 'part two, still talking'),
    turn('Kev', 'part three'),
    turn('Haitch', 'wow ok'),
    turn('Jason', 'love it'),
  ];
  const seg = findKevSegment(dialogues);
  assert.equal(seg.filter(t => t.name === 'Kev').length, 3, 'all three Kev turns of the block must survive');
  assert.ok(seg.some(t => t.text.includes('part three')));
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

test('renderTranscriptForPrompt does not truncate a realistically long episode', () => {
  // The real corpus tops out near 200,000 rendered chars; the default budget
  // must clear that with margin, or the Tilda wrap-up segment gets cut off.
  const turns = Array.from({ length: 4000 }, (_, i) => ({
    name: i % 2 === 0 ? 'Jason' : 'Haitch',
    timestamp: '00:00',
    text: 'x'.repeat(45),
  }));
  const out = renderTranscriptForPrompt(turns);
  assert.equal(out.split('\n').length, 4000, 'every turn must survive');
  assert.ok(out.length > 200_000, 'sanity: this fixture exceeds the old 120k budget');
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

test('isSpeakerMapped is false for single-letter diarization labels', () => {
  const d = [
    { name: 'A', timestamp: '00:00', text: 'one' },
    { name: 'B', timestamp: '00:01', text: 'two' },
    { name: 'C', timestamp: '00:02', text: 'three' },
  ];
  assert.equal(isSpeakerMapped(d), false);
});

test('isSpeakerMapped is false for "Speaker N" labels', () => {
  const d = [
    { name: 'Speaker 0', timestamp: '00:00', text: 'one' },
    { name: 'Speaker 1', timestamp: '00:01', text: 'two' },
  ];
  assert.equal(isSpeakerMapped(d), false);
});

test('isSpeakerMapped is true for real names', () => {
  const d = [
    { name: 'Jason', timestamp: '00:00', text: 'one' },
    { name: 'Haitch', timestamp: '00:01', text: 'two' },
  ];
  assert.equal(isSpeakerMapped(d), true);
});

test('isSpeakerMapped is true when a named cast has one stray label', () => {
  // Partial mapping still carries usable attribution; only a wholly
  // placeholder cast is unusable.
  const d = [
    { name: 'Jason', timestamp: '00:00', text: 'one' },
    { name: 'Haitch', timestamp: '00:01', text: 'two' },
    { name: 'C', timestamp: '00:02', text: 'three' },
  ];
  assert.equal(isSpeakerMapped(d), true);
});

test('isSpeakerMapped is false for an empty transcript', () => {
  assert.equal(isSpeakerMapped([]), false);
});

test('extractTildaPicks returns all nulls for an unmapped transcript without calling the model', async () => {
  const transcript = {
    episode_number: 317,
    episode_name: 'Test',
    dialogues: [
      { name: 'A', timestamp: '00:00', text: 'I would say Geisler' },
      { name: 'B', timestamp: '00:01', text: 'Good pick' },
    ],
  };
  // No ANTHROPIC_API_KEY needed: the guard must short-circuit before any call.
  const r = await extractTildaPicks(transcript);
  assert.deepEqual(r, { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null });
});
