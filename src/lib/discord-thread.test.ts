import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadNameFor, announceWithThread } from './discord-thread';

test('threadNameFor names the episode and film', () => {
  assert.equal(threadNameFor('317', 'Barton Fink (1991)'), 'Ep 317 · Barton Fink (1991)');
});

test('threadNameFor falls back when the film is unknown', () => {
  assert.equal(threadNameFor('317', ''), 'Episode 317');
});

test('threadNameFor truncates to the 100-character Discord limit', () => {
  const name = threadNameFor('317', 'A'.repeat(200));
  assert.equal(name.length, 100);
});

test('announceWithThread returns the message id and the thread id', async () => {
  const calls: string[] = [];
  let threadInit: { method?: string; body?: string } | undefined;
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(String(url));
    if (String(url).endsWith('/threads')) {
      threadInit = init;
      return { ok: true, json: async () => ({ id: 'thread-1' }) };
    }
    return { ok: true, json: async () => ({ id: 'msg-1' }) };
  }) as unknown as typeof fetch;

  const r = await announceWithThread({
    token: 't',
    channelId: 'c1',
    payload: { embeds: [] },
    threadName: 'Ep 317',
    fetchImpl,
  });

  assert.deepEqual(r, { messageId: 'msg-1', threadId: 'thread-1' });
  assert.equal(calls[0], 'https://discord.com/api/v10/channels/c1/messages');
  assert.equal(calls[1], 'https://discord.com/api/v10/channels/c1/messages/msg-1/threads');

  assert.equal(threadInit?.method, 'POST');
  const threadBody = JSON.parse(threadInit?.body ?? '{}');
  assert.equal(threadBody.name, 'Ep 317');
  assert.equal(threadBody.auto_archive_duration, 10080);
});

test('announceWithThread returns a null threadId when only thread creation fails', async () => {
  // The announcement still posted, so this is a degraded success, not a failure:
  // /pdc-note keeps working, only /pdc-sync-notes has nothing to read.
  const fetchImpl = (async (url: string) => {
    if (String(url).endsWith('/threads')) {
      return { ok: false, status: 403, text: async () => 'Missing Permissions' };
    }
    return { ok: true, json: async () => ({ id: 'msg-1' }) };
  }) as unknown as typeof fetch;

  const r = await announceWithThread({
    token: 't',
    channelId: 'c1',
    payload: {},
    threadName: 'Ep 317',
    fetchImpl,
  });

  assert.deepEqual(r, { messageId: 'msg-1', threadId: null });
});

test('announceWithThread returns null when the message post fails', async () => {
  const fetchImpl = (async () => ({
    ok: false,
    status: 401,
    text: async () => 'Unauthorized',
  })) as unknown as typeof fetch;

  const r = await announceWithThread({
    token: 't',
    channelId: 'c1',
    payload: {},
    threadName: 'Ep 317',
    fetchImpl,
  });

  assert.equal(r, null);
});

test('announceWithThread returns null when fetch throws', async () => {
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;

  const r = await announceWithThread({
    token: 't',
    channelId: 'c1',
    payload: {},
    threadName: 'Ep 317',
    fetchImpl,
  });

  assert.equal(r, null);
});

test('announceWithThread sends the bot token as an Authorization header', async () => {
  let seen: Record<string, string> = {};
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
    seen = init.headers;
    return { ok: true, json: async () => ({ id: 'msg-1' }) };
  }) as unknown as typeof fetch;

  await announceWithThread({ token: 'abc', channelId: 'c1', payload: {}, threadName: 'x', fetchImpl });
  assert.equal(seen.Authorization, 'Bot abc');
});
