import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPair } from './fixtures/load';
import { classifyLabels } from './speaker-proposal';

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
