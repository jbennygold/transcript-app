import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNotesOpenMessage,
  webhookForEvent,
  resolveNotesOpenFilm,
  notesOpenTransport,
  notesOpenFallbackUrl,
  AMBER,
} from './notify-discord.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METADATA = path.resolve(__dirname, '..', 'data', 'episode-metadata.json');

test('notes-open names the episode and film', () => {
  const p = buildNotesOpenMessage('317', 'Barton Fink (1991)');
  assert.equal(p.embeds[0].title, 'Ep 317 · Barton Fink (1991)');
  assert.equal(p.embeds[0].color, AMBER);
});

test('notes-open states that it is a call for nominations', () => {
  const p = buildNotesOpenMessage('317', 'Barton Fink (1991)');
  const text = `${p.content ?? ''} ${p.embeds[0].description ?? ''}`;
  assert.match(text, /notable moment/i);
});

test('notes-open tells people the command and shows an example', () => {
  const d = buildNotesOpenMessage('317', 'Barton Fink (1991)').embeds[0].description ?? '';
  assert.match(d, /\/pdc-note/);
  assert.match(d, /note:/);
});

test('notes-open works when the film is unknown', () => {
  const p = buildNotesOpenMessage('317', '');
  assert.equal(p.embeds[0].title, 'Episode 317');
});

test('webhookForEvent routes notes-open to the engineers webhook', () => {
  const env = { DISCORD_PDC_WEBHOOK_URL: 'https://pdc', DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' };
  assert.equal(webhookForEvent('notes-open', env), 'https://eng');
});

test('webhookForEvent routes every other event to the pdc webhook', () => {
  const env = { DISCORD_PDC_WEBHOOK_URL: 'https://pdc', DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' };
  for (const e of ['needs-mapping', 'ingested', 'no-new-episodes', 'drive-unresolved']) {
    assert.equal(webhookForEvent(e, env), 'https://pdc');
  }
});

test('webhookForEvent returns undefined when the needed webhook is unset', () => {
  assert.equal(webhookForEvent('notes-open', { DISCORD_PDC_WEBHOOK_URL: 'https://pdc' }), undefined);
});

test('resolveNotesOpenFilm resolves the film from metadata when --film is not passed', () => {
  assert.equal(resolveNotesOpenFilm('293', undefined, METADATA), 'Panic Room (2002)');
});

test('resolveNotesOpenFilm treats an explicit --film as an override, even over metadata', () => {
  assert.equal(resolveNotesOpenFilm('293', 'Custom Title', METADATA), 'Custom Title');
});

test('resolveNotesOpenFilm treats an explicit empty --film= as an override too', () => {
  assert.equal(resolveNotesOpenFilm('293', '', METADATA), '');
});

test('resolveNotesOpenFilm falls back to empty string for an unknown episode', () => {
  assert.equal(resolveNotesOpenFilm('999999', undefined, METADATA), '');
});

test('resolveNotesOpenFilm falls back to empty string for a non-numeric episode id', () => {
  assert.equal(resolveNotesOpenFilm('147B1', undefined, METADATA), '');
});

test('notesOpenTransport prefers the bot when both a token and a channel id are set', () => {
  assert.deepEqual(
    notesOpenTransport({
      DISCORD_BOT_TOKEN: 't',
      DISCORD_ENGINEERS_CHANNEL_ID: 'c',
      DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng',
    }),
    { kind: 'bot', token: 't', channelId: 'c' }
  );
});

test('notesOpenTransport falls back to the webhook when the bot is half-configured', () => {
  // A token with no channel id (or vice versa) cannot post; the webhook still
  // can, so the announcement degrades to threadless rather than vanishing.
  assert.deepEqual(
    notesOpenTransport({ DISCORD_BOT_TOKEN: 't', DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' }),
    { kind: 'webhook', url: 'https://eng' }
  );
  assert.deepEqual(
    notesOpenTransport({ DISCORD_ENGINEERS_CHANNEL_ID: 'c', DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' }),
    { kind: 'webhook', url: 'https://eng' }
  );
});

test('notesOpenTransport reports none when nothing is configured', () => {
  assert.deepEqual(notesOpenTransport({}), { kind: 'none' });
});

test('notesOpenFallbackUrl falls back to the engineers webhook when the bot post itself failed', () => {
  // announceWithThread returns null specifically when posting the message
  // failed (e.g. missing channel permissions) — distinct from a non-null
  // result with threadId: null, which means only thread creation failed.
  assert.equal(
    notesOpenFallbackUrl(null, { DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' }),
    'https://eng'
  );
});

test('notesOpenFallbackUrl has nothing to fall back to when no webhook is configured', () => {
  assert.equal(notesOpenFallbackUrl(null, {}), undefined);
});

test('notesOpenFallbackUrl does not fall back when the bot already succeeded', () => {
  assert.equal(
    notesOpenFallbackUrl(
      { messageId: 'm1', threadId: 't1' },
      { DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' }
    ),
    undefined
  );
  // Even a bot result with a null threadId (thread creation failed, but the
  // message itself posted) counts as success — no fallback needed.
  assert.equal(
    notesOpenFallbackUrl(
      { messageId: 'm1', threadId: null },
      { DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' }
    ),
    undefined
  );
});
