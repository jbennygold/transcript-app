# Design: "No new episodes" Discord notification

**Date:** 2026-07-23
**Status:** Approved, pending implementation
**Repo:** `transcript-app` (workflow + notify script live here)

## Goal

When the "Check New Episodes" workflow is triggered manually (via the
`/pdc-check-episodes` Discord command → `workflow_dispatch`) and finds nothing to
transcribe, post a "no new episodes" message to `#pod-data-central`. Today the run
only announces when episodes *are* found, so a manual trigger that finds nothing is
silent — the user can't tell success-with-nothing-new from a failure.

## Context

- `scripts/check-new-episodes.ts` writes `transcribed-episodes.txt` **only** when
  `transcribedEpisodes.length > 0` (line ~363). So "no new episodes" is exactly the
  condition `hashFiles('transcribed-episodes.txt') == ''`.
- The workflow already detects a manual run via `github.event_name == 'workflow_dispatch'`
  (used at `.github/workflows/new-episodes.yml:39`).
- `scripts/notify-discord.ts` is the existing CI-safe webhook poster. It switches on
  `--event=` (`needs-mapping`, `ingested`), reads `DISCORD_PDC_WEBHOOK_URL`, and never
  fails CI (warns and returns on any error or missing secret).

## Scope decision (confirmed with user)

- **Manual triggers only.** The scheduled daily cron stays silent when it finds
  nothing (no daily "nothing new" ping). Gate: `github.event_name == 'workflow_dispatch'`.

## Design

### 1. `scripts/notify-discord.ts`

Add a pure builder and a new event case:

```ts
export function buildNoNewEpisodesMessage(): WebhookPayload {
  return {
    content: '✅ Checked the feed — no new episodes. Everything is up to date.',
    embeds: [],
  };
}
```

In `main()`, add an `else if` branch before the unknown-event fallback:

```ts
} else if (event === 'no-new-episodes') {
  payload = buildNoNewEpisodesMessage();
}
```

Update the unknown-event warning string to mention the new event name.

`WebhookPayload.embeds` is required; an empty array is valid because `content` is set
(Discord requires at least one of content/embeds).

### 2. `.github/workflows/new-episodes.yml`

Add a step immediately after the existing "Notify Discord — episodes need speaker
mapping" step:

```yaml
      # On a manual trigger that transcribed nothing, confirm "no new episodes"
      # so the person who ran /pdc-check-episodes gets a result instead of silence.
      # Scheduled cron runs stay silent to avoid a daily "nothing new" ping.
      - name: Notify Discord — no new episodes (manual trigger only)
        if: github.event_name == 'workflow_dispatch' && hashFiles('transcribed-episodes.txt') == ''
        continue-on-error: true
        env:
          DISCORD_PDC_WEBHOOK_URL: ${{ secrets.DISCORD_PDC_WEBHOOK_URL }}
        run: node --import tsx ./scripts/notify-discord.ts --event=no-new-episodes
```

## Where it posts

`#pod-data-central` (the webhook's channel), the same place completion news already
goes. It cannot reply in the channel the command was invoked from, because the
workflow finishes minutes later — long after the Discord interaction token expired.
This is an accepted constraint, consistent with the existing "needs mapping" flow.

## Error handling

`notify-discord.ts` already warns-and-returns on a missing webhook secret or a failed
POST, and the workflow step is `continue-on-error: true`. A notification problem never
fails the run.

## Out of scope

- Reporting on scheduled cron runs.
- Replying in the invoking channel / DMing the invoker.
- Any bot-side change (`transcript-bot` is untouched).
- Distinguishing "nothing in feed" from "found but transcription failed" — both
  legitimately mean "nothing was transcribed"; the message wording stays accurate for
  both.

## Testing

- **Unit:** `buildNoNewEpisodesMessage()` returns the expected content and an embeds
  array (the pure, testable unit).
- **Manual:** run `node --import tsx ./scripts/notify-discord.ts --event=no-new-episodes`
  locally with `DISCORD_PDC_WEBHOOK_URL` set → message appears in `#pod-data-central`.
- **End-to-end:** trigger `/pdc-check-episodes` on a day with no new episodes → the
  message posts; confirm a scheduled cron run with nothing new does **not** post.
