import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDriveUnresolvedMessage, AMBER } from './notify-discord.ts';

test('drive-unresolved: single episode with suggestions', () => {
  const payload = buildDriveUnresolvedMessage([
    { episode: '317', film: 'Sorceror (1977)', suggestions: ['Sorcerer (1977)'] },
  ]);
  assert.equal(payload.content, '⚠️ 1 episode had no matching audio folder in Drive');
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, 'Ep 317 · Sorceror (1977)');
  assert.equal(payload.embeds[0].color, AMBER);
  assert.match(payload.embeds[0].description ?? '', /Sorcerer \(1977\)/);
});

test('drive-unresolved: plural content and no-suggestion wording', () => {
  const payload = buildDriveUnresolvedMessage([
    { episode: '317', film: 'A', suggestions: [] },
    { episode: '318', film: 'B', suggestions: [] },
  ]);
  assert.equal(payload.content, '⚠️ 2 episodes had no matching audio folder in Drive');
  assert.match(payload.embeds[0].description ?? '', /nothing in Drive came close/);
});

test('drive-unresolved: caps at 10 embeds', () => {
  const many = Array.from({ length: 13 }, (_, i) => ({
    episode: String(300 + i),
    film: `Film ${i}`,
    suggestions: [],
  }));
  assert.equal(buildDriveUnresolvedMessage(many).embeds.length, 10);
});
