# Agent Search Latency — Design

**Date:** 2026-07-08
**Status:** Approved (pending spec review)

## Goal

Reduce `agent_search` latency (currently ~24–50s wall-clock) by attacking the
two things the profiling identified, without degrading answer quality:

1. **Real latency** — shrink the tool-result context that balloons LLM input
   tokens (2k → 58k across iterations) and makes every Sonnet call slower,
   especially the final synthesis.
2. **Perceived latency** — stream the final answer to the UI instead of showing
   a blank spinner for the whole 9–31s final call.

## Profiling evidence (why these two levers)

Per-iteration profile against real Blob + Sonnet (`claude-sonnet-4-6`):

| Query | Total | Iters | LLM share | Final-call in_tok → ms |
|---|---|---|---|---|
| "how many times has birria called in" | 24.5s | 5 | 23.1s (94%) | 18,741 → 9.1s |
| "what are all the recurring segments" | 50.3s | 5 | 50.2s (99.7%) | 57,938 → 31.2s |

- Transcript load ≈1.4s (one-time), grep ≈single-digit ms — **neither is the
  bottleneck**.
- LLM latency scales with accumulated input tokens. Both queries ran the same 5
  iterations; the slow one was slow purely because its context grew to 58k
  tokens (13 greps, each result truncated at 15,000 chars and appended to the
  message history forever).

## Decisions (from brainstorming)

- **Keep Sonnet throughout.** No model split to Haiku — answer-quality risk not
  taken. #1 alone shrinks the context that drives Sonnet latency.
- **Compact match format** for #1 (not a blunt lower truncation cap).
- **Net-positive eval gate** — adjudicate per case; a small regression is
  acceptable if the latency win is large.

## Scope

Package = **#1 (compact grep payloads)** + **#4 (stream final answer)**.
Confined to two files. No classifier/routing/frontend/model changes.
Dropped from the earlier menu: #2 (Haiku for tool-selection), #3 (context
pruning), #5 (iteration cap) — out of scope for this pass.

---

## Component 1 — Compact grep result format

**Where:** `src/lib/agent-search.ts` — `grepTranscripts()` and the
`grep_transcripts` branch of `executeToolCall()` (the code that formats matches
into the tool-result string and the 15,000-char truncation at ~line 461).

**Current behavior:** `grepTranscripts` stops scanning at `max_results` (default
50, cap 200). `executeToolCall` formats each match with full `text` +
`contextBefore` + `contextAfter`, joins them, and the result string is truncated
at 15,000 chars per tool result.

**New behavior:**

1. **Decouple counting from display.** Scan and collect *all* matches up to a
   safety cap of **1000** (not `max_results`). Compute a complete per-episode
   count from the full match set. This makes counting/frequency answers reflect
   the true total instead of stopping at 50 — an accuracy improvement.
2. **Compact result string:**

   ```
   Found <N> matches across <M> episodes for /<pattern>/[ (speaker: <filter>)].
   Per-episode counts: Ep137×2, Ep139×1, Ep140×3, … (all M episodes)
   Sample matches (first <K>):
   - [Ep<n> "<film>" · <speaker> @ <ts>] <matched line, ≤200 chars>
     ↳ <prev speaker @ ts>: <≤120 chars> / <next speaker @ ts>: <≤120 chars>
   (+<N-K> more matches; see per-episode counts above)
   ```

   - `K` (sample matches shown) default **25**.
   - Matched line truncated to **200** chars; each context line to **120** chars.
   - Keep ±1 context lines (B8 "in what context was X mentioned" and quote-finder
     queries depend on surrounding context).
   - Total result string capped at **6,000** chars (down from 15,000). If the
     per-episode-counts line alone would exceed the cap (very high-cardinality
     patterns), truncate the counts list with a "…(+X more episodes)" suffix but
     always keep the total `N` and `M`.
3. All caps/limits are module constants near the other agent constants so they
   are eval-tunable without hunting through logic.

**Constants (new, in `agent-search.ts` or `routing-policy.ts` alongside agent
constants):**
- `GREP_SCAN_CAP = 1000` — max matches scanned/counted per grep.
- `GREP_SAMPLE_COUNT = 25` — matches shown with snippets.
- `GREP_SNIPPET_CHARS = 200`, `GREP_CONTEXT_CHARS = 120`.
- `GREP_RESULT_CHAR_CAP = 6000` — replaces the hardcoded 15000.

**`max_results` param:** the existing `grep_transcripts` `max_results` input now
controls the **sample display count** `K` (how many snippet lines to show),
defaulting to `GREP_SAMPLE_COUNT = 25`, clamped to a small max (e.g. 50).
Scanning/counting is independent and always covers up to `GREP_SCAN_CAP`
regardless of `max_results`, so a low `max_results` never undercounts. The tool
`description` is updated to say so.

**Unchanged:** `read_episode_transcript`, `search_episodes`, `list_episodes`
tool outputs. Only `grep_transcripts` formatting changes. `grep_transcripts`
tool `description`/`input_schema` updated to tell the model that results are
compacted and that per-episode counts are authoritative for counting (so it
does not re-grep to "see all" matches).

**Quality guard:** because counting now covers all matches (not first 50) and
context is preserved (just truncated), counting/frequency and context queries
should hold or improve. The risk is a query that needed the *full text* of many
matches at once — mitigated because the model can still `read_episode_transcript`
for full context on specific episodes.

---

## Component 2 — Stream the final answer

**Where:** `src/lib/agent-search.ts` (`runAgentSearch` loop) and
`src/app/api/search/stream/route.ts` (the `agent_search` branch at ~line 444).

**Existing infrastructure (reused, not rebuilt):** the stream route already
emits a `chunk` SSE event carrying incremental text (`send('chunk', {text})`,
used by the tilda path at route.ts:300). The frontend (`src/app/page.tsx:131`)
already handles `chunk` by appending to `streamingText`, rendered live in
`<SearchProgress streamingText=…>` (page.tsx:1240). The final structured answer
replaces `streamingText` on the `complete` event.

**Change:**

1. Add an optional callback to `runAgentSearch`:
   `onAnswerDelta?: (text: string) => void`.
2. Convert the loop's model call from `client.messages.create(...)` to
   `client.messages.stream(...)` (same params: model, max_tokens, system, tools,
   messages). Forward `content_block_delta` / `text_delta` events to
   `onAnswerDelta`. Obtain the completed message via `await stream.finalMessage()`
   for the existing `stop_reason` / `tool_use` branching — the rest of the loop
   logic is unchanged.
3. In the stream route's agent branch, pass
   `onAnswerDelta = (text) => send('chunk', { text })`. The `onProgress`
   callback (spinner messages) is unchanged.
4. The JSON `/api/search` route passes **no** `onAnswerDelta`; `runAgentSearch`
   still returns the full accumulated `answer`, so that endpoint is unaffected.

**Interim-text handling:** every iteration streams, so a tool-selection
iteration could emit a little preamble text before its `tool_use` blocks. This is
acceptable: the anti-CoT instruction in `AGENT_SYSTEM_PROMPT` already suppresses
"let me search…" preamble, and any transient text shown in `streamingText` is
replaced by the final structured answer on `complete`. We explicitly do **not**
build a "only stream the final call" buffering scheme — it would defeat live
streaming and add complexity for a transient, already-suppressed artifact.

**Signature (final):**
```ts
export async function runAgentSearch(
  query: string,
  onProgress?: AgentProgressCallback,
  onAnswerDelta?: (text: string) => void,
): Promise<AgentSearchResult>
```

---

## Error handling

- Streaming errors: a thrown error from `messages.stream()` / `finalMessage()`
  is caught by the loop's existing try/catch (sets `fallbackReason`, breaks) and
  the outer catch. No new failure modes; behavior on model error is unchanged
  (returns gracefully, never throws to the route).
- The grep compaction cannot throw on empty/large match sets — an empty match
  set returns the existing "No matches found." string; the counts list is built
  from whatever matches exist.

## Testing & eval gate

- **Unit-level (local, deterministic):** a small test for the grep formatter —
  given a synthetic match set, assert the compact output contains the correct
  total `N`, episode count `M`, per-episode counts, exactly `K` sample lines, and
  respects the char caps. (Formatting is pure once matches are gathered; extract
  the formatter so it is unit-testable without Blob/LLM.)
- **Eval gate (net-positive):**
  `npx tsx scripts/eval-search.ts --tag agent --url <prod>` before and after.
  Every currently-passing agent case adjudicated; ship if overall pass-rate
  holds or improves. A single regression is acceptable if the latency win is
  large (decision made at the gate with the case in hand).
- **Latency measurement:** re-profile "how many times has birria called in" and
  "what are all the recurring segments"; report per-iteration input tokens and
  wall-clock before/after. Target: worst-case final-synthesis call ~31s → ~10s,
  and the perceived wait replaced by streaming.

## Files touched

- `src/lib/agent-search.ts` — compact grep formatter + constants (#1);
  `messages.stream` + `onAnswerDelta` (#4).
- `src/app/api/search/stream/route.ts` — pass `onAnswerDelta → send('chunk')`.
- New: a unit test for the grep formatter (per repo convention: `node:test` via
  `node --import tsx`, e.g. `scripts/agent-grep-format.test.ts`).

## Non-goals (YAGNI)

- No model change (Haiku split) — deferred.
- No context-pruning between iterations (#3) — deferred.
- No iteration-cap change or grep-batching prompt (#5) — deferred.
- No frontend changes — streaming infra already exists.
- No changes to `/api/search` (JSON) response shape.
