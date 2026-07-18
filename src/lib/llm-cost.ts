/**
 * Token-usage cost tracking for Anthropic (Haiku) calls.
 *
 * Accumulates `response.usage` across many calls and reports the dollar cost so
 * ingest passes and the cleanup endpoint can log what they actually spent —
 * turning "why was Haiku $X" into a number visible in CI output / Vercel logs.
 */

// Per-token USD rates. Haiku 4.5: $1/M input, $5/M output.
const MODEL_RATES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  'claude-haiku-4-5': { input: 1 / 1_000_000, output: 5 / 1_000_000 },
};

const DEFAULT_RATE = MODEL_RATES['claude-haiku-4-5-20251001'];

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Accumulates token usage across many calls and reports the dollar cost. */
export class CostTracker {
  private readonly model: string;
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;

  constructor(model: string) {
    this.model = model;
  }

  /** Add one response's usage. Safe to call with undefined/null (no-op). */
  add(usage: TokenUsage | undefined | null): void {
    if (!usage) return;
    this.calls++;
    this.inputTokens += usage.input_tokens ?? 0;
    this.outputTokens += usage.output_tokens ?? 0;
    this.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  }

  costUsd(): number {
    const r = MODEL_RATES[this.model] ?? DEFAULT_RATE;
    // Cache-write bills 1.25x input; cache-read 0.1x input (these calls don't
    // use prompt caching today, so those terms are normally zero).
    return (
      this.inputTokens * r.input +
      this.outputTokens * r.output +
      this.cacheWriteTokens * r.input * 1.25 +
      this.cacheReadTokens * r.input * 0.1
    );
  }

  /** One-line human summary, e.g. for console.log at the end of a pass. */
  summary(label: string): string {
    const parts = [
      `${this.calls} calls`,
      `${this.inputTokens.toLocaleString()} in`,
      `${this.outputTokens.toLocaleString()} out`,
    ];
    if (this.cacheReadTokens) {
      parts.push(`${this.cacheReadTokens.toLocaleString()} cache-read`);
    }
    return `[cost] ${label}: ${parts.join(' / ')} tok → $${this.costUsd().toFixed(4)}`;
  }
}
