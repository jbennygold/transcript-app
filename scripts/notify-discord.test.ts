import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNeedsMappingMessage,
  buildIngestedMessage,
  AMBER,
  GREEN,
} from './notify-discord.ts';

test('needs-mapping: single episode → amber embed with review link + reviewer field', () => {
  const payload = buildNeedsMappingMessage(
    [{ episode: 312, film: 'The Thing (1982)', reviewer: 'Jason' }],
    'https://x.test'
  );
  assert.equal(payload.content, '🎙️ 1 new episode needs speaker mapping');
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, 'Ep 312 · The Thing (1982)');
  assert.equal(payload.embeds[0].url, 'https://x.test/review/312');
  assert.equal(payload.embeds[0].color, AMBER);
  assert.deepEqual(payload.embeds[0].fields, [
    { name: 'Reviewer', value: 'Jason', inline: true },
  ]);
});

test('needs-mapping: plural content for multiple episodes', () => {
  const payload = buildNeedsMappingMessage(
    [
      { episode: 312, film: 'The Thing (1982)', reviewer: 'Jason' },
      { episode: 313, film: 'Alien (1979)', reviewer: 'Haitch' },
    ],
    'https://x.test'
  );
  assert.equal(payload.content, '🎙️ 2 new episodes need speaker mapping');
  assert.equal(payload.embeds.length, 2);
});

test('needs-mapping: missing film → "Episode N" title, reviewer field omitted', () => {
  const payload = buildNeedsMappingMessage(
    [{ episode: 999, film: null, reviewer: null }],
    'https://x.test'
  );
  assert.equal(payload.embeds[0].title, 'Episode 999');
  assert.equal(payload.embeds[0].fields, undefined);
});

test('needs-mapping: >10 episodes → 10 embeds + overflow summary line', () => {
  const episodes = Array.from({ length: 13 }, (_, i) => ({
    episode: 300 + i,
    film: `Film ${i}`,
    reviewer: null,
  }));
  const payload = buildNeedsMappingMessage(episodes, 'https://x.test');
  assert.equal(payload.embeds.length, 10);
  assert.match(payload.content ?? '', /\+3 more: 310, 311, 312/);
});

test('ingested: single green embed with searchable copy + homepage link', () => {
  const payload = buildIngestedMessage(
    { episode: 312, film: 'The Thing (1982)', reviewer: 'Jason' },
    'https://x.test'
  );
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, '✅ Ingested into search corpus');
  assert.equal(payload.embeds[0].color, GREEN);
  assert.match(payload.embeds[0].description ?? '', /Ep 312 · The Thing \(1982\)/);
  assert.match(payload.embeds[0].description ?? '', /now searchable/);
  assert.equal(payload.embeds[0].url, 'https://x.test');
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEpisodes } from './notify-discord.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METADATA = path.resolve(__dirname, '..', 'data', 'episode-metadata.json');

test('resolveEpisodes: resolves film + reviewer from real metadata (ep 293)', () => {
  const [info] = resolveEpisodes([293], METADATA);
  assert.equal(info.episode, 293);
  assert.equal(info.film, 'Panic Room (2002)');
  assert.equal(info.reviewer, 'birria');
});

test('resolveEpisodes: unknown episode → null film/reviewer', () => {
  const [info] = resolveEpisodes([999999], METADATA);
  assert.deepEqual(info, { episode: 999999, film: null, reviewer: null });
});

test('resolveEpisodes: unreadable metadata path → null fields, no throw', () => {
  const [info] = resolveEpisodes([293], '/no/such/file.json');
  assert.deepEqual(info, { episode: 293, film: null, reviewer: null });
});
