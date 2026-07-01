# Discord Episode-Lifecycle Notifications — Design

**Date:** 2026-07-01
**Status:** Approved (pending spec review)

## Goal

Post to the `#pod-data-central` channel of the dunepod Discord when an episode
crosses two lifecycle milestones:

1. **Needs speaker mapping** — a new episode has been transcribed and is sitting
   in the "needs review" state.
2. **Ingested into corpus** — an episode has completed speaker mapping + cleanup
   and has been ingested into the search index (now searchable).

The posts should read as coming from the podcast's Discord bot.

## Context: where the events actually fire

Both milestones happen inside **transcript-app's GitHub Actions**, not inside the
`transcript-bot` process:

- **Event 1** fires at the end of the `new-episodes.yml` cron (daily). It runs
  `scripts/check-new-episodes.ts`, which transcribes newly-published episodes and
  writes the freshly-transcribed episode numbers to `transcribed-episodes.txt`.
  A single run can finish **several** episodes.
- **Event 2** fires from `ingest-episode.yml`, a `workflow_dispatch` workflow
  triggered by "Publish to Search" in the review UI via `POST /api/rebuild`. It
  ingests **one** episode per run.

The `transcript-bot` (`/opt/projects/transcript-bot`) is a persistent Railway
`discord.js` process with no inbound HTTP server. Because a CI job only checks
out its own repo, the notification-sending code lives in **transcript-app**.

## Delivery mechanism: Discord incoming webhook

A single **incoming webhook** created on `#pod-data-central`. Rationale (chosen
over bot-token REST and a bot HTTP endpoint):

- Least infrastructure — one HTTPS POST from CI, no persistent process to keep
  alive, no dependency on the Railway bot being up.
- Smallest blast radius — the webhook URL is channel-scoped and write-only; a
  leak cannot post elsewhere or read anything (unlike the guild-wide bot token).
- The webhook is configured with the bot's **name + avatar**, so posts read as
  the bot to channel members.

Trade-off accepted: the message author is a bot look-alike webhook identity, not
literally the bot application user. This was explicitly accepted.

**Secret:** the webhook URL is stored as a single GitHub Actions secret,
`DISCORD_PDC_WEBHOOK_URL`.

## Components

### `scripts/notify-discord.ts` (new)

A small, self-contained, dependency-light notifier with two modes. Written in
TypeScript, run via `node --import tsx`, matching repo conventions.

**Mode A — `--event=needs-mapping`**
- Reads the freshly-transcribed episode numbers from `transcribed-episodes.txt`
  (falls back to a `--episodes=312,313` flag if provided).
- Resolves each episode's `film` from `data/episode-metadata.json`.
- Posts **one message** containing **one amber embed per episode** (Discord
  allows up to 10 embeds per message). If more than 10 episodes, the first 10
  render as embeds and the remainder collapse into a summary line in the message
  content (e.g. "+3 more: 322, 323, 324").
- Each embed links to `{BASE_URL}/review/{n}`.

**Mode B — `--event=ingested --episode=N`**
- Resolves episode N's `film` from `data/episode-metadata.json`.
- Posts **one green embed** ("now searchable") linking to the live search app.

**Shared behavior:**
- Base URL from `NEXT_PUBLIC_BASE_URL`, defaulting to
  `https://search.escapehatchpod.com`.
- Title resolution: if the metadata lookup misses (brand-new episode not yet in
  the sheet), fall back to just "Episode N".
- If `DISCORD_PDC_WEBHOOK_URL` is unset, log a warning and exit 0 (no-op).
- If the webhook POST fails (network error, non-2xx, 429), log a warning and
  exit 0 — **never** fail the workflow.

### Metadata resolution

`data/episode-metadata.json` is an array of episode records keyed by the
`episode` number, each with `film` (e.g. `"The Thing (1982)"`) and `reviewer`.
The script reads this file directly (already present in the repo checkout) and
builds an episode→record map. No network/LLM calls.

## Message format

**Event 1 (amber `0xF59E0B`, one embed per episode):**

```
Author: 🎙️ Escape Hatch Bot   (webhook name+avatar)
Content: "🎙️ 2 new episodes need speaker mapping"
Embed (per episode):
  title:  "Ep 312 · The Thing (1982)"
  color:  amber
  fields: Reviewer → Jason
  url:    https://search.escapehatchpod.com/review/312   (title is the link)
```

**Event 2 (green `0x22C55E`, single embed):**

```
Embed:
  title:       "✅ Ingested into search corpus"
  description: "Ep 312 · The Thing (1982) — speaker mapping + cleanup complete, now searchable"
  color:       green
  url:         https://search.escapehatchpod.com
```

(Reviewer field is included in Event 1 when available; omitted on fallback.)

## Wiring into workflows

### `new-episodes.yml` — Event 1

Add a new step **after** the "Commit metadata and transcript changes" step,
guarded so it only runs when there is something to announce:

```yaml
- name: Notify Discord — episodes need speaker mapping
  if: hashFiles('transcribed-episodes.txt') != ''
  continue-on-error: true
  env:
    DISCORD_PDC_WEBHOOK_URL: ${{ secrets.DISCORD_PDC_WEBHOOK_URL }}
  run: node --import tsx ./scripts/notify-discord.ts --event=needs-mapping
```

`continue-on-error: true` is belt-and-suspenders; the script already exits 0 on
failure.

### `ingest-episode.yml` — Event 2

Add a new step **after** "Upload updated search index" (so it only fires on a
successful ingest), before/around the deploy trigger:

```yaml
- name: Notify Discord — episode ingested
  continue-on-error: true
  env:
    DISCORD_PDC_WEBHOOK_URL: ${{ secrets.DISCORD_PDC_WEBHOOK_URL }}
    EPISODE: ${{ inputs.episode }}
  run: node --import tsx ./scripts/notify-discord.ts --event=ingested --episode="$EPISODE"
```

## Error handling & edge cases

| Case | Behavior |
|---|---|
| `DISCORD_PDC_WEBHOOK_URL` unset | Warn, exit 0 (no-op) |
| Webhook POST fails / non-2xx / 429 | Warn, exit 0 — CI stays green |
| Metadata lookup misses for an episode | Fall back to "Episode N", no film/reviewer |
| Event 1: `transcribed-episodes.txt` absent/empty | Step skipped by `if:` guard; script also no-ops |
| Event 1: >10 episodes in one run | First 10 as embeds, remainder in a summary line |
| Duplicate pings across daily cron runs | Avoided — Event 1 keys off the per-run freshly-transcribed set, not a global "needs mapping" backlog, so each episode is announced exactly once |

## Non-goals (YAGNI)

- No interactive buttons / click handlers (webhook can't handle interactions;
  link buttons unnecessary — the embed title is the link).
- No changes to the `transcript-bot` repo.
- No message editing / threading / dedup store — fire-and-forget is sufficient.
- No new npm dependencies — uses `fetch` (Node 20) and `fs`.

## Setup checklist (operator, one-time)

1. In Discord: `#pod-data-central` → Integrations → Webhooks → New Webhook.
   Name it after the bot, set the bot's avatar, copy the URL.
2. Add `DISCORD_PDC_WEBHOOK_URL` as a GitHub Actions secret on the
   `transcript-app` repo.

## Files touched

- `scripts/notify-discord.ts` — new
- `.github/workflows/new-episodes.yml` — one new step
- `.github/workflows/ingest-episode.yml` — one new step
