import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNotesOpenMessage, webhookForEvent, resolveNotesOpenFilm, AMBER } from './notify-discord.ts';

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
