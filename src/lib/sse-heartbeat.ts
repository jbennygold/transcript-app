/**
 * Keepalive pings for long-running SSE responses.
 *
 * Agent search runs a sequential LLM loop that can go ~25s between progress
 * events (measured: a 24.3s silent window on "what has Jason said about Mark
 * Zuckerberg"). An HTTP connection idle that long gets reaped by mobile carrier
 * NAT and proxy intermediaries, which surfaces in WebKit — Safari and Chrome on
 * iOS alike — as a bare `TypeError: Load failed` mid-stream. The server side
 * completes normally, so nothing shows up in logs.
 *
 * Writing a periodic SSE comment keeps the connection warm without touching the
 * event protocol: comments are ignored by the EventSource spec and fall through
 * the `event: ` / `data: ` prefix checks in our own client parser.
 */

/** SSE comment frame. Leading ':' marks it a comment; the blank line flushes it. */
export const SSE_HEARTBEAT_PAYLOAD = ': keepalive\n\n';

/**
 * Ping cadence. The heartbeat only fires when the stream has been idle this
 * long, so the worst-case idle gap is just under 2x this value — 10s here,
 * comfortably inside the ~30s idle timeouts intermediaries typically enforce.
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 5_000;

export interface SseHeartbeatOptions {
  /** Writes a raw payload to the stream. Throws once the controller is closed. */
  write: (payload: string) => void;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  now?: () => number;
}

export interface SseHeartbeat {
  /** Call after writing a real event so the heartbeat skips its next tick. */
  markActivity: () => void;
  /** Idempotent. Always call from a `finally` so the timer cannot outlive the stream. */
  stop: () => void;
}

export function startSseHeartbeat(options: SseHeartbeatOptions): SseHeartbeat {
  const {
    write,
    intervalMs = SSE_HEARTBEAT_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    now = Date.now,
  } = options;

  let lastActivity = now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  };

  timer = setIntervalFn(() => {
    if (now() - lastActivity < intervalMs) return;
    try {
      write(SSE_HEARTBEAT_PAYLOAD);
      lastActivity = now();
    } catch {
      // Controller already closed — disarm rather than throw on every tick.
      stop();
    }
  }, intervalMs);

  // Node keeps the process alive for pending timers; a keepalive should never
  // be the reason a serverless invocation lingers.
  (timer as { unref?: () => void })?.unref?.();

  return {
    markActivity: () => {
      lastActivity = now();
    },
    stop,
  };
}
