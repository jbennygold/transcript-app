import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  startSseHeartbeat,
  SSE_HEARTBEAT_PAYLOAD,
  SSE_HEARTBEAT_INTERVAL_MS,
} from './sse-heartbeat';

/**
 * Deterministic stand-in for setInterval/clearInterval/Date.now so heartbeat
 * timing can be asserted without real waiting.
 */
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers: { id: number; fn: () => void; interval: number; next: number }[] = [];

  return {
    now: () => now,
    setIntervalFn: ((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, fn, interval: ms, next: now + ms });
      return id;
    }) as unknown as typeof setInterval,
    clearIntervalFn: ((id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    }) as unknown as typeof clearInterval,
    activeTimers: () => timers.length,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.next <= target)
          .sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next = now + due.interval;
        due.fn();
      }
      now = target;
    },
  };
}

function harness(intervalMs = SSE_HEARTBEAT_INTERVAL_MS) {
  const clock = makeClock();
  const writes: { at: number; payload: string }[] = [];
  const beat = startSseHeartbeat({
    write: (payload) => writes.push({ at: clock.now(), payload }),
    intervalMs,
    setIntervalFn: clock.setIntervalFn,
    clearIntervalFn: clock.clearIntervalFn,
    now: clock.now,
  });
  return { clock, writes, beat };
}

describe('sse-heartbeat', () => {
  test('payload is an SSE comment so clients ignore it', () => {
    assert.ok(
      SSE_HEARTBEAT_PAYLOAD.startsWith(':'),
      'must start with ":" to be a spec-ignored SSE comment'
    );
    assert.ok(
      SSE_HEARTBEAT_PAYLOAD.endsWith('\n\n'),
      'must terminate with a blank line to flush as a complete SSE frame'
    );
    // Our client parser in page.tsx keys off these two prefixes only.
    assert.ok(!SSE_HEARTBEAT_PAYLOAD.startsWith('event: '));
    assert.ok(!SSE_HEARTBEAT_PAYLOAD.startsWith('data: '));
  });

  test('writes a keepalive once the stream goes idle', () => {
    const { clock, writes, beat } = harness(5_000);
    clock.advance(5_000);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].payload, SSE_HEARTBEAT_PAYLOAD);
    beat.stop();
  });

  test('stays silent while real events are flowing', () => {
    const { clock, writes, beat } = harness(5_000);
    // Simulate steady chunk output: activity every 1s for 20s.
    for (let i = 0; i < 20; i++) {
      clock.advance(1_000);
      beat.markActivity();
    }
    assert.equal(writes.length, 0, 'no keepalives needed while actively streaming');
    beat.stop();
  });

  test('bounds the idle gap across a 24s silent agent-search window', () => {
    // This is the real regression: agent_search ran ~24.3s with zero bytes
    // written, and the phone dropped the connection.
    const { clock, writes, beat } = harness(5_000);
    clock.advance(24_300);
    beat.stop();

    assert.ok(writes.length >= 4, `expected repeated keepalives, got ${writes.length}`);

    // No gap between writes may approach the window that killed the connection.
    const stamps = [0, ...writes.map((w) => w.at), 24_300];
    const maxGap = Math.max(...stamps.slice(1).map((t, i) => t - stamps[i]));
    assert.ok(maxGap <= 10_000, `max idle gap ${maxGap}ms exceeds 10s budget`);
  });

  test('stop() clears the timer and halts further writes', () => {
    const { clock, writes, beat } = harness(5_000);
    clock.advance(5_000);
    const afterFirst = writes.length;
    beat.stop();
    clock.advance(60_000);
    assert.equal(writes.length, afterFirst, 'no writes after stop()');
    assert.equal(clock.activeTimers(), 0, 'interval must be cleared');
  });

  test('stops itself when the stream controller is already closed', () => {
    const clock = makeClock();
    let calls = 0;
    const beat = startSseHeartbeat({
      write: () => {
        calls++;
        throw new TypeError('Controller is already closed');
      },
      intervalMs: 5_000,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      now: clock.now,
    });
    clock.advance(60_000);
    beat.stop();
    assert.equal(calls, 1, 'a throwing write must disarm the heartbeat, not repeat');
    assert.equal(clock.activeTimers(), 0);
  });

  test('default interval leaves margin under mobile idle reaping', () => {
    assert.ok(
      SSE_HEARTBEAT_INTERVAL_MS <= 10_000,
      'interval must stay well under the ~30s idle timeouts mobile proxies enforce'
    );
  });
});
