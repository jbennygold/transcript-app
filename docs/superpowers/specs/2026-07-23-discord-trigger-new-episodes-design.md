# Design: `/pdc-check-episodes` — Trigger the "Check New Episodes" GitHub Action from Discord

**Date:** 2026-07-23
**Status:** Approved, pending implementation
**Repos touched:** `transcript-bot` (all code) · `transcript-app` (this spec only; the target workflow needs no change)

## Goal

Let a podcast host kick off the daily "Check New Episodes" pipeline on demand from
Discord, instead of waiting for the 2 PM UTC cron or clicking through the GitHub
Actions UI.

## Context (existing state)

- **Target workflow:** `transcript-app/.github/workflows/new-episodes.yml`. Already
  declares `workflow_dispatch` with an optional `include_backfill` boolean input, so
  it is already API-triggerable. **No change to this workflow is required.**
- **Bot:** `transcript-bot`, discord.js v14 on Railway. Runs with only the
  `GatewayIntentBits.Guilds` intent. Has an established slash-command pattern
  (`/pdc`, `/pdc-quote`, `/pdc-synopsis`, …) registered in
  `scripts/discord-register.ts` and dispatched from a central
  `isChatInputCommand()` block in `scripts/discord-bot.ts`.
- **Completion feedback already exists:** `new-episodes.yml` posts to
  `#pod-data-central` via the `DISCORD_PDC_WEBHOOK_URL` webhook when episodes finish
  transcribing and need speaker mapping. This design does **not** duplicate that.
- **Repo:** `jbennygold/transcript-app`, default branch `master`.

## Scope decisions (confirmed with user)

- **Permissions:** role-gated. Only members with the **`hosts`** Discord role may
  trigger. Configurable via env, defaulting to `hosts`.
- **UX:** simple, recent-only. No `include_backfill` option exposed — backfill
  remains a manual GitHub-UI action. Bot confirms "started" and links the workflow's
  run list. No polling for completion.

## Design

### 1. New slash command

Add `/pdc-check-episodes` (no options) to `scripts/discord-register.ts`, following
the existing `SlashCommandBuilder` pattern and appending its `.toJSON()` to the
`commands` array.

```
new SlashCommandBuilder()
  .setName('pdc-check-episodes')
  .setDescription('Check the podcast feed for new episodes and start transcription')
```

### 2. Handler in `discord-bot.ts`

Add a branch to the existing `interaction.isChatInputCommand()` block:

1. **Role gate.** Resolve the interacting member's roles from
   `interaction.member.roles.cache` and require a role whose name matches
   `EPISODE_TRIGGER_ROLE` (default `hosts`). No match →
   `interaction.reply({ content: 'You need the **hosts** role to run this.', flags: MessageFlags.Ephemeral })` and return.
   - No new intent or bot permission is needed: guild roles are cached at startup
     under the `Guilds` intent, and the interacting member's role IDs arrive in the
     interaction payload.
2. **Config check.** If `GITHUB_DISPATCH_TOKEN` is unset → ephemeral
   "Episode trigger isn't configured." and return. (Matches the bot's existing
   graceful-degradation convention for optional services.)
3. **`deferReply()`** (non-ephemeral — the confirmation is useful to the channel).
4. **Dispatch.** `POST` to the GitHub REST API:
   - URL: `https://api.github.com/repos/jbennygold/transcript-app/actions/workflows/new-episodes.yml/dispatches`
   - Headers: `Authorization: Bearer ${GITHUB_DISPATCH_TOKEN}`,
     `Accept: application/vnd.github+json`,
     `X-GitHub-Api-Version: 2022-11-28`,
     `User-Agent: transcript-bot`.
   - Body: `{ "ref": "master" }` (no inputs → workflow's `include_backfill` default of
     `false` applies).
   - Success is **HTTP 204 No Content**.
5. **Report.**
   - On 204 → `editReply` with a confirmation and a link to the run list:
     `https://github.com/jbennygold/transcript-app/actions/workflows/new-episodes.yml`.
     Note that completion will be announced in `#pod-data-central`.
   - On non-204 → `editReply` (or ephemeral follow-up) with a short error including the
     HTTP status. Never echo the token or full response body that could contain
     sensitive data.

The `workflow_dispatch` response returns no run ID, so linking the workflow's run
list (newest run at top) is the honest "simple" surface. Polling for the specific run
is explicitly out of scope.

### 3. Configuration (Railway env)

Two new environment variables:

| Var | Purpose | Notes |
|-----|---------|-------|
| `GITHUB_DISPATCH_TOKEN` | Auth for the dispatch call | **Fine-grained PAT**, scoped to only `jbennygold/transcript-app`, permission **Actions: Read and write**. Manual one-time setup: create in GitHub → add to Railway. |
| `EPISODE_TRIGGER_ROLE` | Discord role name allowed to trigger | Defaults to `hosts` if unset. |

Document both in `transcript-bot/CLAUDE.md` under Environment Variables.

## Why this approach

- **Direct REST call with a fine-grained PAT** over a GitHub App: an App adds
  installation-token machinery that is overkill for triggering one workflow. The
  scoped PAT keeps blast radius to Actions-write on a single repo.
- **Over a `repository_dispatch` relay:** the bot can call the workflow-dispatch
  endpoint directly; a relay adds a network hop and another moving part for no gain.
- **Reuse the existing completion webhook** rather than polling: the pipeline already
  announces results to `#pod-data-central`, so polling would duplicate feedback and
  hold a Discord interaction open for up to 90 minutes.

## Error handling summary

| Condition | Response |
|-----------|----------|
| Caller lacks `hosts` role | Ephemeral "need the **hosts** role", no dispatch |
| `GITHUB_DISPATCH_TOKEN` unset | Ephemeral "not configured", no dispatch |
| GitHub returns non-204 | Ephemeral/edit error with status code, no secret leakage |
| Network/exception | Caught; ephemeral generic failure message |

## Out of scope

- Exposing the `include_backfill` input.
- Polling the Actions API for run completion / status.
- Any change to `new-episodes.yml` or other workflows.
- Rate-limiting / debouncing repeated triggers (the workflow's own concurrency and the
  cost are acceptable for a host-only audience; can be added later if abused).

## Testing

- **Registration:** run `npm run register` and confirm `/pdc-check-episodes` appears.
- **Role gate (negative):** invoke as a non-`hosts` member → ephemeral denial, no run
  started.
- **Happy path:** invoke as a `hosts` member → 204, confirmation with run link, and a
  new run visible in the Actions list. Verify the run actually checks the feed.
- **Missing token:** unset `GITHUB_DISPATCH_TOKEN` locally → ephemeral "not configured".
- **Bad token:** set an invalid PAT → non-204 handled gracefully with status code.
