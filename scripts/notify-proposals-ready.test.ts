import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProposalsReadyMessage, AMBER } from './notify-discord.ts';

test('proposals-ready: singular content and a /podreview link', () => {
  const p = buildProposalsReadyMessage('317', 'Barton Fink (1991)', 1, 'https://search.escapehatchpod.com');
  assert.equal(p.content, '📝 1 metadata proposal ready to review');
  assert.equal(p.embeds[0].title, 'Ep 317 · Barton Fink (1991)');
  assert.equal(p.embeds[0].url, 'https://search.escapehatchpod.com/podreview');
  assert.equal(p.embeds[0].color, AMBER);
});

test('proposals-ready: plural content', () => {
  const p = buildProposalsReadyMessage('317', 'Barton Fink (1991)', 4, 'https://x.test');
  assert.equal(p.content, '📝 4 metadata proposals ready to review');
});

test('proposals-ready: says nothing is written until the human acts', () => {
  const p = buildProposalsReadyMessage('317', 'F', 2, 'https://x.test');
  assert.match(p.embeds[0].description ?? '', /nothing is written to the sheet until you do/);
});
