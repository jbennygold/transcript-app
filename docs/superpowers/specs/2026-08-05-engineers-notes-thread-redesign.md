# Engineers Notes — Thread-Based Redesign

## Why this changes

The shipped design collects Notable Moments through a `/pdc-note` slash command and approves them in `/review/submissions`. It works end to end — a note was submitted, approved, and appended to the sheet on 2026-08-05.

It optimises for the wrong risk. The governance features (audit trail, reject-with-reason, edit-before-approve) matter only if there is a queue to govern, and the expected volume is low. The actual failure mode is **nobody comments**, and a slash command is friction standing between a person and a thought they had while listening.

A thread is where people already are. This redesign moves collection there and shrinks approval to a reaction.

Two objections raised against this approach originally, and why they no longer hold:

- *"`MessageContent` is a privileged intent."* True, but for a bot in under 100 servers it is a toggle in the Discord Developer Portal with no approval process. The cost was overstated.
- *"Railway restarts drop listener state, so you'd need reaction polling."* Only if the bot listens. Fetching a thread's messages on demand needs no listener, no state, and no polling — restarts are irrelevant.

The remaining objection — that a reaction leaves no audit trail and no edit path — stands, and is accepted deliberately. The sheet is hand-editable, and being permissive is the point.

## Decisions

| Question | Decision |
| --- | --- |
| Approval gate | An admin reaction (✅ or 👍) on the comment. Unreacted comments are collected but never appended. |
| Sync trigger | A `/pdc-sync-notes` slash command, run manually. Nothing writes to the sheet unattended. |

## What survives unchanged

This is a change of collection surface, not a rewrite. Already built and reused as-is:

- `appendToCell` in `src/lib/pdc-sheet.ts` — including its never-creates-a-row guarantee, `RAW` value input (so a comment cannot be read as a formula), and case-insensitive per-line duplicate detection, which is what makes re-syncing a thread safe.
- `src/lib/episode-notes.ts` — the note record, `normaliseNoteText`, the `isEpisodeNote` guard, and the open-episode pointer.
- `POST /api/episode-notes` and its `x-eh-key` auth — the bot already authenticates this way.
- `/review/submissions` Notable Moments tab — retained as a fallback and an audit view, not the primary path.
- `/pdc-note` — retained. It is the right tool for a note thought of later, outside the thread.

## What changes

### 1. The announcement becomes a thread

Today `notify-discord.ts --event=notes-open` posts to `#engineers` via a channel webhook. A webhook can post a message but cannot create a thread on it; that requires a bot token.

The `notes-open` step is replaced by a call that uses the Discord REST API with a bot token to:

1. Post the episode announcement to `#engineers`.
2. Create a thread on that message (`POST /channels/{channel}/messages/{message}/threads`), named for the episode.
3. Record `threadId` on the open-episode pointer.

`OpenEpisode` gains `threadId: string | null`. A null means thread creation failed; the pointer is still written, so `/pdc-note` keeps working. Thread creation must be non-fatal, matching every other Discord step in this project.

This needs a new `DISCORD_BOT_TOKEN` repo secret. `DISCORD_ENGINEERS_WEBHOOK_URL` is no longer required once this lands, but is left in place so nothing breaks mid-migration.

### 2. `/pdc-sync-notes` collects reacted comments

New bot command. No arguments in the common case; an optional `ep:` for an older episode.

1. Read the open-episode pointer to get `threadId` (via a new authenticated app endpoint, or by passing `ep:`).
2. Fetch the thread's messages.
3. Drop bot messages and the thread's own starter message.
4. For each remaining message, fetch its reactions and keep it only if ✅ or 👍 was added by a user holding the admin role. Reaction users require `reaction.users.fetch()`; this is a REST call, not a gateway subscription.
5. POST the surviving comments to the app as a batch.
6. Reply in-channel with what happened: how many were considered, how many appended, how many skipped as already present.

The bot needs `GatewayIntentBits.MessageContent` added, and the matching toggle enabled in the Developer Portal. This is the one hard constraint the shipped design avoided, and it is accepted here.

### 3. A batch sync endpoint

New `POST /api/episode-notes/sync`, `x-eh-key` authed, body:

```typescript
{
  episode: string;
  comments: Array<{
    discordMessageId: string;
    text: string;
    submittedBy: string;
  }>;
}
```

For each comment it runs `normaliseNoteText`, then `appendToCell(episode, 'Notable_Moments', text)`, and records a note in the existing store with `status: 'approved'` and the `discordMessageId`.

Two layers of idempotency, because a human will re-run this command:

- `discordMessageId` is stored, so an already-synced comment is skipped without touching the sheet.
- `appendBullet`'s duplicate detection catches anything that slips past — including a comment edited to match existing text.

The append-before-record ordering from the resolve route is preserved: a failed sheet write leaves the comment unsynced and retryable, never silently dropped.

`EpisodeNote` gains `discordMessageId?: string` and `source?: 'command' | 'thread'`, so the review tab can show where a note came from.

## What this does not do

- No live message listener. Nothing is read except when `/pdc-sync-notes` runs.
- No unattended sheet writes. The cron is not involved.
- No reaction listener. Reactions are read at sync time from fetched messages.
- No removal of the existing approval UI. It stays as an audit view and a fallback.

## Risks

**Permissiveness is now the design.** A reaction from anyone with the admin role appends a comment verbatim. Mitigated by `RAW` value input (no formula evaluation), `normaliseNoteText` (single line, length-capped), and the sheet being hand-editable.

**`MessageContent` is a real privilege escalation for the bot.** It can now read every message in every channel it can see, not just its own commands. Justified only because the whole point is reading comments people wrote. Worth revisiting if the bot's scope ever widens.

**Thread lifetime.** Discord archives inactive threads. An archived thread's messages remain fetchable, so a late `/pdc-sync-notes` still works, but the command should surface it if the thread was archived rather than appearing to find nothing.

## Sequencing

1. Extend `OpenEpisode` with `threadId`; extend `EpisodeNote` with `discordMessageId` and `source`. Pure type + guard changes, testable.
2. `POST /api/episode-notes/sync` with its idempotency, reusing `appendToCell` and `normaliseNoteText`.
3. Replace the `notes-open` step with the thread-creating call; record `threadId`.
4. Bot: add `MessageContent` intent and the `/pdc-sync-notes` command.
5. Surface `source` in the review tab so thread-sourced notes are distinguishable.

Steps 1–2 are app-side and independently testable. Step 4 is the only one requiring a Developer Portal change.
