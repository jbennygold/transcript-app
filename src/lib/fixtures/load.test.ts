import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPair } from './load';

test('loadPair returns raw and mapped transcripts of equal length', () => {
  const { raw, mapped } = loadPair(317);
  assert.equal(raw.length, 903);
  assert.equal(mapped.length, 903);
});

test('loadPair pairs are index-aligned by timestamp', () => {
  for (const ep of [317, 315, 303]) {
    const { raw, mapped } = loadPair(ep);
    assert.equal(raw.length, mapped.length, `ep${ep} length`);
    for (let i = 0; i < raw.length; i++) {
      assert.equal(raw[i].timestamp, mapped[i].timestamp, `ep${ep} turn ${i}`);
    }
  }
});

test('raw fixtures carry placeholder labels, mapped fixtures carry real names', () => {
  const { raw, mapped } = loadPair(317);
  const rawNames = new Set(raw.map((d) => d.name));
  const mappedNames = new Set(mapped.map((d) => d.name));
  assert.ok([...rawNames].every((n) => /^[A-Z]$/.test(n)), 'raw should be single letters');
  assert.ok(mappedNames.has('Matt Haitch'), 'mapped should contain a host');
});
