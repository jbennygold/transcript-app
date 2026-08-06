import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPair } from './fixtures/load';
import { classifyLabels, isolateCallerRun, nameCaller, namePrincipals, countWords, LONG_TURN_WORDS } from './speaker-proposal';

test('classifyLabels finds 3 principals, 5 callers and 1 fragment on ep 317', () => {
  const { raw } = loadPair(317);
  const labels = classifyLabels(raw);
  const count = (k: string) => labels.filter((l) => l.kind === k).length;
  assert.equal(count('principal'), 3);
  assert.equal(count('caller'), 5);
  assert.equal(count('fragment'), 1);
});

test('classifyLabels never marks a real voicemailer as a principal', () => {
  // Ground truth: every principal label must map to a host or the episode guest,
  // never to a roster caller or a category.
  const ROSTER = ['Corey', 'kev voicemail', 'birria', 'Mr Java', 'Lizzen', 'Animal Mother', 'Ethan'];
  const CATEGORIES = ['Sounder/FX', 'Movie Sample', 'Voicemail (Unknown)', 'Overtalk/Interjection'];

  for (const ep of [317, 315, 303]) {
    const { raw, mapped } = loadPair(ep);
    for (const label of classifyLabels(raw).filter((l) => l.kind === 'principal')) {
      // dominant mapped name for this label, weighted by words
      const byName = new Map<string, number>();
      for (const i of label.indices) {
        const words = raw[i].text.trim().split(/\s+/).length;
        byName.set(mapped[i].name, (byName.get(mapped[i].name) ?? 0) + words);
      }
      const truth = [...byName.entries()].sort((a, b) => b[1] - a[1])[0][0];
      assert.ok(!ROSTER.includes(truth), `ep${ep} ${label.label} is really caller "${truth}"`);
      assert.ok(!CATEGORIES.includes(truth), `ep${ep} ${label.label} is really category "${truth}"`);
    }
  }
});

test('classifyLabels uses long-turn share, so it works on short and long episodes', () => {
  // ep 303 (628 turns) and ep 317 (903 turns) must both resolve 3 principals.
  assert.equal(classifyLabels(loadPair(303).raw).filter((l) => l.kind === 'principal').length, 3);
  assert.equal(classifyLabels(loadPair(317).raw).filter((l) => l.kind === 'principal').length, 3);
});

test('classifyLabels returns an empty array for an empty transcript', () => {
  assert.deepEqual(classifyLabels([]), []);
});

test('isolateCallerRun keeps every genuine voicemail turn on ep 317', () => {
  // No long turn may ever be stripped — that would delete the actual voicemail.
  const { raw } = loadPair(317);
  for (const label of classifyLabels(raw).filter((l) => l.kind === 'caller')) {
    const run = new Set(isolateCallerRun(raw, label.indices));
    for (const i of label.indices) {
      if (countWords(raw[i].text) >= LONG_TURN_WORDS) {
        assert.ok(run.has(i), `${label.label} long turn ${i} was stripped`);
      }
    }
  }
});

test('isolateCallerRun drops the backchannel tail', () => {
  const { raw } = loadPair(317);
  const callers = classifyLabels(raw).filter((l) => l.kind === 'caller');
  // Every ep 317 caller label shrinks: measured 37->3, 21->2, 19->1, 14->1, 9->2.
  for (const label of callers) {
    const run = isolateCallerRun(raw, label.indices);
    assert.ok(run.length < label.turnCount, `${label.label} did not shrink`);
    assert.ok(run.length > 0, `${label.label} lost its whole run`);
  }
});

test('isolateCallerRun removes contamination that sits inside the voicemail block', () => {
  // ep 317 turn 775 ("What did your dad do?") is host backchannel on caller
  // label I, at 96:11 — inside the block, so a positional rule would miss it.
  const { raw } = loadPair(317);
  const labelI = classifyLabels(raw).find((l) => l.label === 'I');
  assert.ok(labelI, 'label I should exist');
  assert.ok(!isolateCallerRun(raw, labelI!.indices).includes(775));
});

test('isolateCallerRun returns empty when the label has no long turn', () => {
  const dialogues = [
    { name: 'X', timestamp: '1:00', text: 'Yeah.' },
    { name: 'X', timestamp: '50:00', text: 'Right.' },
  ];
  assert.deepEqual(isolateCallerRun(dialogues, [0, 1]), []);
});

test('isolateCallerRun keeps every long turn even when they land in separate time-gap groups', () => {
  // Two long turns 250s apart (> RUN_GAP_SECONDS = 240s) form two separate
  // groups. Both are genuine speech and must survive; a short turn far from
  // both (1800s away) is still contamination and must be dropped.
  const longText = Array(45).fill('word').join(' ');
  const dialogues = [
    { name: 'X', timestamp: '10:00', text: longText }, // long, 600s
    { name: 'X', timestamp: '30:00', text: 'nope' }, // short, 1800s — far from both groups
    { name: 'X', timestamp: '14:10', text: longText }, // long, 850s — 250s after the first
  ];
  assert.deepEqual(isolateCallerRun(dialogues, [0, 1, 2]), [0, 2]);
});

test('nameCaller resolves all five ep 317 callers', () => {
  const { raw, mapped } = loadPair(317);
  const results = classifyLabels(raw)
    .filter((l) => l.kind === 'caller')
    .map((l) => {
      const run = isolateCallerRun(raw, l.indices);
      // ground truth: mapped name of the longest turn in the run
      const longest = run.reduce((a, b) => (countWords(raw[a].text) > countWords(raw[b].text) ? a : b));
      return { proposed: nameCaller(raw, run), truth: mapped[longest].name };
    });
  assert.equal(results.length, 5);
  for (const r of results) assert.equal(r.proposed, r.truth);
});

test('nameCaller declines rather than guessing for off-roster callers', () => {
  // ep 315 has Griffin and Rusty Surfer, neither in the roster. They must come
  // back null — a wrong name silently corrupts segment chunks, a null just
  // asks the human.
  const { raw, mapped } = loadPair(315);
  const ROSTER = ['Corey', 'kev voicemail', 'birria', 'Mr Java', 'Lizzen', 'Animal Mother', 'Ethan'];
  for (const l of classifyLabels(raw).filter((c) => c.kind === 'caller')) {
    const run = isolateCallerRun(raw, l.indices);
    if (run.length === 0) continue;
    const longest = run.reduce((a, b) => (countWords(raw[a].text) > countWords(raw[b].text) ? a : b));
    const truth = mapped[longest].name;
    const proposed = nameCaller(raw, run);
    if (!ROSTER.includes(truth)) {
      assert.equal(proposed, null, `off-roster "${truth}" should decline, got "${proposed}"`);
    }
  }
});

test('nameCaller refuses to name on a tie', () => {
  const dialogues = [
    { name: 'B', timestamp: '10:00', text: 'Here is Corey, and also here is Kev.' },
    { name: 'E', timestamp: '10:10', text: 'x '.repeat(60) },
  ];
  assert.equal(nameCaller(dialogues, [1]), null);
});

test('nameCaller returns null for an empty run', () => {
  assert.equal(nameCaller([], []), null);
});

test('namePrincipals identifies Haitch from the cold open and binds the guest', () => {
  const { raw } = loadPair(317);
  const principals = classifyLabels(raw).filter((l) => l.kind === 'principal');
  const names = namePrincipals(raw, principals, 'Dave Mandel');
  const assigned = [...names.values()];
  assert.ok(assigned.includes('Matt Haitch'), 'Haitch self-names in the cold open');
  assert.ok(assigned.includes('Dave Mandel'), 'guest name is bound');
  assert.ok(assigned.includes('Jason Goldman'), 'remaining principal is Jason');
});

test('namePrincipals names only Haitch when no guest name is available', () => {
  // With 3 principals and no guestName there is no way to tell Jason from the
  // guest, so neither is guessed — only the label that self-names is assigned.
  const { raw } = loadPair(317);
  const principals = classifyLabels(raw).filter((l) => l.kind === 'principal');
  const names = namePrincipals(raw, principals, null);
  assert.equal(names.size, 1);
  assert.deepEqual([...names.values()], ['Matt Haitch']);
});
