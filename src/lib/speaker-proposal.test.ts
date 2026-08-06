import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPair } from './fixtures/load';
import type { DialogueEntry } from '@/types/transcript';
import {
  classifyLabels, isolateCallerRun, nameCaller, namePrincipals,
  proposeSpeakerMapping, countWords, LONG_TURN_WORDS,
} from './speaker-proposal';

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

test('namePrincipals still identifies Jason positively when no guest name is available, but leaves the guest slot unassigned', () => {
  // Jason is identified by the "addressed as Jason" signal, which is
  // independent of guestName — so with 3 principals and no guestName, Haitch
  // and Jason both resolve; only the true guest (no name supplied to bind to)
  // stays unassigned. This supersedes the old turn-count-elimination
  // behavior, where neither Jason nor the guest could be told apart without
  // a guestName.
  const { raw } = loadPair(317);
  const principals = classifyLabels(raw).filter((l) => l.kind === 'principal');
  const names = namePrincipals(raw, principals, null);
  assert.equal(names.size, 2);
  assert.equal([...names.values()].includes('Matt Haitch'), true);
  assert.equal([...names.values()].includes('Jason Goldman'), true);
});

test('namePrincipals resolves ep 303 (Haitch, Jason, and the guest correctly) — one of the 8 episodes the old turn-count heuristic swapped Jason and the guest on', () => {
  const { raw, mapped } = loadPair(303);
  const principals = classifyLabels(raw).filter((l) => l.kind === 'principal');

  // Derive the expected label -> name pairs from the mapped fixture, not
  // hardcoded letters: dominant mapped name per label, weighted by words
  // (same approach as the classifyLabels roster-exclusion test above).
  const dominantName = (indices: number[]) => {
    const byName = new Map<string, number>();
    for (const i of indices) {
      byName.set(mapped[i].name, (byName.get(mapped[i].name) ?? 0) + countWords(raw[i].text));
    }
    return [...byName.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const expected = new Map(principals.map((p) => [p.label, dominantName(p.indices)]));
  assert.deepEqual(
    new Set(expected.values()),
    new Set(['Matt Haitch', 'Jason Goldman', 'Dave Itzkoff']),
    'ep 303 ground truth should be exactly these 3 principals',
  );

  const names = namePrincipals(raw, principals, 'Dave Itzkoff');
  for (const [label, truth] of expected) {
    assert.equal(names.get(label), truth, `label ${label}: expected "${truth}", got "${names.get(label)}"`);
  }
});

test('namePrincipals declines to bind the guest when two or more principals remain unidentified', () => {
  // Neither non-Haitch principal is ever addressed as "Jason", so Jason is
  // declined (score 0 for both) — that leaves 2 candidates for the guest
  // slot (mirrors episodes with two guests, e.g. 300/313), which is
  // ambiguous. Decline rather than guess which one is the supplied guestName.
  const longText = Array(45).fill('word').join(' ');
  const dialogues = [
    { name: 'A', timestamp: '0:00', text: "Hey everybody, it's Haitch, and welcome to the show." },
    { name: 'A', timestamp: '0:05', text: longText },
    { name: 'B', timestamp: '0:10', text: longText },
    { name: 'C', timestamp: '0:15', text: longText },
  ];
  const principals = classifyLabels(dialogues).filter((l) => l.kind === 'principal');
  assert.equal(principals.length, 3);
  const names = namePrincipals(dialogues, principals, 'Some Guest');
  assert.equal(names.get('A'), 'Matt Haitch');
  assert.equal(names.has('B'), false);
  assert.equal(names.has('C'), false);
});

test('namePrincipals declines every elimination-based assignment when Haitch never self-identifies', () => {
  // No self-intro anchor means no positively-identified starting point.
  // Naming anyone by "whoever is left" turn-count elimination risks
  // misnaming a host or the guest — verified "guest talks least" only on
  // n=2 episodes, no defense for when it doesn't hold.
  const longText = Array(45).fill('word').join(' ');
  const dialogues = [
    { name: 'A', timestamp: '0:00', text: longText },
    { name: 'B', timestamp: '0:05', text: longText },
    { name: 'C', timestamp: '0:10', text: longText },
  ];
  const principals = classifyLabels(dialogues).filter((l) => l.kind === 'principal');
  assert.equal(principals.length, 3);
  const names = namePrincipals(dialogues, principals, 'Some Guest');
  assert.equal(names.size, 0);
});

test('proposeSpeakerMapping produces a full ep 317 proposal', () => {
  const { raw } = loadPair(317);
  const proposal = proposeSpeakerMapping(raw, { guestName: 'Dave Mandel' });
  assert.equal(proposal.degenerate, null);
  assert.equal(proposal.labels.length, 9);
  const named = proposal.labels.filter((l) => l.proposedName !== null).map((l) => l.proposedName);
  for (const expected of ['Matt Haitch', 'Jason Goldman', 'Dave Mandel', 'Corey', 'Ethan', 'kev voicemail', 'birria', 'Animal Mother']) {
    assert.ok(named.includes(expected), `missing ${expected}`);
  }
  assert.ok(proposal.contaminants.length > 50, 'ep 317 has ~94 contaminant turns');
});

test('proposeSpeakerMapping never reports a long turn as a contaminant', () => {
  for (const ep of [317, 315, 303]) {
    const { raw } = loadPair(ep);
    const proposal = proposeSpeakerMapping(raw, { guestName: null });
    for (const c of proposal.contaminants) {
      assert.ok(countWords(raw[c.index].text) < LONG_TURN_WORDS, `ep${ep} turn ${c.index} is substantive`);
    }
  }
});

test('proposeSpeakerMapping declines both labels when two would take the same name', () => {
  // Two labels both scoring "Kev" would build Kev's segment chunks from a host
  // cluster — the Animal-Mother-349-turns failure, reintroduced automatically.
  // Neither may win.
  //
  // The host needs MANY long turns here: PRINCIPAL_LONG_SHARE is a share, so
  // with only two long turns in the transcript each one is 50% and E/F would
  // classify as principals instead of callers.
  const long = (word: string) => `${word} `.repeat(60);
  const dialogues: DialogueEntry[] = [];
  for (let i = 0; i < 12; i++) {
    dialogues.push({ name: 'B', timestamp: `${i}:00`, text: long('host') });
  }
  dialogues.push({ name: 'B', timestamp: '20:00', text: 'Here is Kev.' });
  dialogues.push({ name: 'E', timestamp: '20:05', text: long('alpha') });
  dialogues.push({ name: 'B', timestamp: '40:00', text: 'And here is Kev.' });
  dialogues.push({ name: 'F', timestamp: '40:05', text: long('beta') });

  const proposal = proposeSpeakerMapping(dialogues, { guestName: null });

  const e = proposal.labels.find((l) => l.label === 'E');
  const f = proposal.labels.find((l) => l.label === 'F');
  assert.equal(e?.kind, 'caller', 'E should classify as a caller');
  assert.equal(f?.kind, 'caller', 'F should classify as a caller');
  assert.equal(e?.proposedName, null, 'duplicate name must not be assigned');
  assert.equal(f?.proposedName, null, 'duplicate name must not be assigned');
});

test('proposeSpeakerMapping fails open on a transcript with no principals', () => {
  const dialogues: DialogueEntry[] = [
    { name: 'A', timestamp: '0:01', text: 'Yeah.' },
    { name: 'B', timestamp: '0:05', text: 'Right.' },
  ];
  const proposal = proposeSpeakerMapping(dialogues, { guestName: null });
  assert.equal(proposal.labels.length, 0);
  assert.equal(proposal.contaminants.length, 0);
  assert.ok(proposal.degenerate);
});

test('proposeSpeakerMapping flags the unresolvable fragment cluster', () => {
  const { raw } = loadPair(317);
  const proposal = proposeSpeakerMapping(raw, { guestName: 'Dave Mandel' });
  const fragment = proposal.labels.find((l) => l.kind === 'fragment');
  assert.ok(fragment, 'ep 317 has a fragment cluster');
  assert.equal(fragment!.proposedName, null, 'fragment cluster must not be named');
  assert.ok(fragment!.warnings.length > 0, 'fragment cluster should carry a warning');
});

test('proposeSpeakerMapping warns when a label holds implausibly many turns', () => {
  // A voicemailer with more turns than CALLER_TURN_WARNING is the ep 317
  // Animal-Mother-349-turns signature: a bulk mapping that swallowed a host.
  const long = (word: string) => `${word} `.repeat(60);
  const dialogues: DialogueEntry[] = [];
  for (let i = 0; i < 12; i++) {
    dialogues.push({ name: 'B', timestamp: `${i}:00`, text: long('host') });
  }
  dialogues.push({ name: 'B', timestamp: '20:00', text: 'Here is Kev.' });
  dialogues.push({ name: 'E', timestamp: '20:05', text: long('alpha') });
  for (let i = 0; i < 70; i++) {
    dialogues.push({ name: 'E', timestamp: `${30 + i}:00`, text: 'Yeah.' });
  }

  const proposal = proposeSpeakerMapping(dialogues, { guestName: null });
  const e = proposal.labels.find((l) => l.label === 'E');
  assert.ok(e, 'label E should exist');
  assert.ok(
    e!.warnings.some((w) => w.includes('holds')),
    `expected a turn-count warning, got ${JSON.stringify(e!.warnings)}`,
  );
});

test('proposeSpeakerMapping never throws on empty or malformed input', () => {
  assert.doesNotThrow(() => proposeSpeakerMapping([], {}));
  assert.doesNotThrow(() => proposeSpeakerMapping([{ name: 'A', timestamp: 'nonsense', text: '' }], {}));
});
