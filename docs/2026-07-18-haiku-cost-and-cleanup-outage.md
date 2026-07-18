# Haiku cost investigation + Clean Up outage — 2026-07-18

## TL;DR

- **"Cleanup analysis failed" on `/review/episode_315` was the Anthropic account being out of API credits.** Every LLM-backed feature on prod was degraded; Clean Up and Detect Samples surfaced it most visibly because they had no fallback.
- **Fixed the error masking**, the **cause of the high Haiku bills** (non-persistent ingest caches → cold re-ingests re-paying full cost), added **token cost logging**, and **removed the aipolicy chatbot** to isolate its (separate) cost.
- **Credits refilled; prod verified healthy** (interpretive search + Clean Up both work again).

## Incident

Clean Up on `/review/episode_315` returned "cleanup analysis failed". Reproduced on prod against ep 315, 314, 300, 250 — failed on **batch 1** (the first Haiku call) every time, so not content-specific.

**Root cause (confirmed in prod runtime logs):**
```
Error 400 {"type":"invalid_request_error",
"message":"Your credit balance is too low to access the Anthropic API..."}
```
Not a code bug — the Anthropic account funding the prod `ANTHROPIC_API_KEY` was out of credits. Regular search partly survived because the query classifier falls back to heuristics on LLM failure; Clean Up / Detect Samples throw and had no fallback, so they were where it showed.

## What we shipped (commits on `master`)

1. **`47b4024` — surface the real Anthropic error.** New `src/lib/llm-error.ts` (`describeLLMError`) extracts the clean provider message + status from an `Anthropic.APIError`. Wired into `cleanup-transcript` and `detect-samples`; the UI already renders it, so the real cause now shows instead of a generic string.

2. **`d1fc62a` — persist the Haiku extraction caches (the cost fix).**
   - `topic-cache.json` (per-chunk topic summaries) and `playlist-cache.json` (per-episode song extraction) are content-hash caches that were **local-only**: never uploaded to Blob, never restored before ingest, and `topic-cache.json` was deleted after every build.
   - So every CI ingest and every deploy that re-ingested started **cold** and re-paid full Haiku cost (~$20/full pass) for content already summarized — the cause of the $30-42/day spikes.
   - Fix: `upload-search-data.ts` uploads both caches; `download-search-data.ts` restores them (`--caches-only` mode for the build path, which must not pull the large index files); `build-orchestrator.ts` restores caches best-effort before ingest (song extraction is gated by `--skip-playlist`, **not** `--skip-topics`, so it runs on every build). Self-seeding: first run cold, warm after.

3. **`6bade14` — token cost logging.** New `CostTracker` in `src/lib/llm-cost.ts` accumulates `response.usage` and reports dollars at Haiku 4.5 rates ($1/M in, $5/M out).
   - `ingest.ts`: per-pass summary lines (`[cost] song extraction: ... → $13.x`, `[cost] topic extraction: ... → $6.x`).
   - `cleanup-transcript`: per-run summary in Vercel logs + a `cost` field (`{usd, calls, inputTokens, outputTokens}`) on the `result` event.

## Haiku cost model (measured on ep 315, 778 turns, via `count_tokens`)

Haiku 4.5 = **$1/M input, $5/M output**.

| Call | Input tokens | Cost/call |
|---|---|---|
| Song extraction (1 episode, whole transcript) | 37,490 | ~$0.040 |
| Topic summary (1 chunk) | 597 | ~$0.0013 |
| Cleanup batch (100 turns + rubric) | ~5,300 | ~$0.010 |

**What each operation *should* cost:**

| Operation | Expected Haiku cost |
|---|---|
| Add 1 new episode (ingest, warm cache) | **~$0.10** |
| Clean Up 1 episode | **~$0.10** (⌈turns÷95⌉ batches) |
| Full cold re-ingest (should be rare) | **~$20** (~$13 song over ~315 episodes + ~$6 topic over ~4,800 chunks) |

Normal days should be **cents**. Any **$20+** Haiku day means a full cold re-ingest ran — after the cache fix that should only happen when chunking/prompts change, not routinely.

## Parallel-project check: aipolicy

- Swept all 15 Vercel projects in `goldtoe-gmailcom's projects`: **only `transcript-app` has an `ANTHROPIC_API_KEY`.** So it's the only project on the Anthropic account / Anthropic Console bill.
- `aipolicy.tech` (`ai-policy-landscape`) has a chat box, but `app/api/chat/route.ts` used **Vercel AI Gateway** (`gateway("anthropic/claude-sonnet-4.6")`) — **Sonnet, not Haiku**, authenticated by OIDC (no key), billed to the **Vercel invoice**, not the Anthropic Console. So it was never a contributor to the Haiku bill.
- Per request, **removed the aipolicy chatbot** (`chore` commit on `jbennygold/ai-policy-landscape@main`, remote switched to SSH to push): deleted `components/chat-drawer.tsx`, `app/api/chat/route.ts`, and the `<ChatDrawer />` mount. Reversible via `git revert`. This cuts aipolicy's AI Gateway spend only.

## Monitoring going forward

- **transcript-app Haiku** → Anthropic Console → Usage. Watch ingest cost lines in CI output; a `$13`/`$6` line = a full cold pass ran.
- **aipolicy AI** → Vercel → AI Gateway usage (should be ~zero now that the chatbot is removed).
- For per-project attribution long-term: give each project its own Anthropic key or Workspace.

## Open follow-ups (not done)

- Detect Samples could get the same cost logging (same pattern).
- aipolicy `/api/chat` was 500-ing before removal (likely an AI Gateway config/credit issue) — moot now, but that's why it failed if the chatbot is ever restored.
- The review UI could display the new cleanup `cost` field (data is there; no UI wired).
