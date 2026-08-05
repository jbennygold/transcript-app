# Engineers Notes — Thread-Based Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Notable Moment collection from the `/pdc-note` slash command into a Discord thread on the episode announcement, where an admin's ✅/👍 reaction is the approval gate and a manual `/pdc-sync-notes` command appends reacted comments to the sheet.

**Architecture:** The episode announcement is posted with a bot token instead of a webhook so a thread can be created on it; the thread id is recorded on the existing open-episode Blob pointer. The bot's new `/pdc-sync-notes` command fetches that thread's messages on demand (no listener, no state, no polling), keeps only those an admin reacted to, and POSTs them as a batch to a new `POST /api/episode-notes/sync` endpoint. That endpoint reuses the already-shipped `appendToCell` + `normaliseNoteText` + note store, adding `discordMessageId` as an idempotency key so re-running the command is safe.

**Tech Stack:** Next.js App Router (API routes), TypeScript, Vercel Blob, Google Sheets API v4, discord.js v14 (bot repo), Discord REST v10 (app repo, via `fetch`), `node:test` + `tsx` for tests.

## Global Constraints

These apply to every task. Most are hard-won from the two prior builds of this feature (`.superpowers/sdd/progress.md`, `archive-tier1/`, `archive-tier2/`).

- **Two repos.** Tasks 1, 2, 3, 5 are in `/opt/projects/transcript-app`. **Task 4 is in `/opt/projects/transcript-bot`** — a separate git repo with its own remote. Never mix commits across them.
- **Push straight to master** (app) / **main** (bot). No PRs, no feature branches. This is the repo convention.
- `npm run lint` in the app repo is **non-functional**. The verification gate is `npx tsc --noEmit`.
- **`scripts/` is excluded from the app's `tsconfig.json`** (see `tsconfig.json:38-41`), so `npx tsc --noEmit` typechecks *nothing* under `scripts/`. Any non-trivial logic must live under `src/lib/` to get a compile gate. `scripts/notify-discord.ts` should stay a thin caller.
- **`appendToCell` must NEVER create a sheet row.** An episode with no row returns `'no_row'`. Do not modify `src/lib/pdc-sheet.ts` in this plan — it is reused as-is.
- **Append-before-record ordering is a hard invariant.** The sheet write must succeed before the note is persisted as approved. A failed write leaves the comment unsynced and retryable, never silently dropped.
- **Every Discord step is non-fatal.** A Discord failure logs a warning and continues; it never fails the workflow or blocks the Blob pointer write.
- **Bot → app auth is the `x-eh-key` header** via `validateExternalKey` (`src/lib/external-auth.ts`). App review-UI auth is Bearer via `checkAuth` (`src/lib/podreview-auth.ts`). Do not confuse them — a prior build shipped an inert review tab by putting Bearer auth on a route and then calling it with no header.
- **Log before returning null/empty.** Silent catch-and-continue is a debugging dead end.
- **Orphan check.** After each task, ask out loud: "does anything actually call this?" Both prior builds shipped code nothing invoked.
- **Workflow secrets must be mapped explicitly** in the `env:` block of the GitHub Actions step, or the feature is silently inert with CI green.
- **Pre-existing uncommitted change:** `src/lib/agent-search.ts` (modified) is NOT part of this work. `git add` only the files your task names — never `git add -A`.
- **Pre-existing breakage in the bot repo:** `scripts/discord-register.ts:118,123` have 2 tsc errors. That repo has no working typecheck gate today; Task 4 adds a test script but does not need to fix those errors.
- **Emoji, exact:** approval reactions are `✅` (U+2705, `white_check_mark`) and `👍` (U+1F44D, `thumbsup`). Match on `reaction.emoji.name`.
- **Admin role name:** reuse the existing `EPISODE_TRIGGER_ROLE` env var, default `'hosts'` (`scripts/discord-bot.ts:29`). Do not introduce a second role concept.

---

## File Structure

**App repo (`/opt/projects/transcript-app`):**

| File | Responsibility | Task |
| --- | --- | --- |
| `src/lib/episode-notes.ts` (modify) | Types, guards, note builders, Blob I/O. Gains `threadId`, `discordMessageId`, `source`, `isOpenEpisode`, `buildThreadNote`, `listSyncedMessageIds`. | 1 |
| `src/lib/episode-notes.test.ts` (modify) | Tests for the above. | 1 |
| `src/lib/note-sync.ts` (create) | Pure batch-sync logic with injected deps — validation + per-comment outcome decisions. This is where the append-before-record invariant becomes testable. | 2 |
| `src/lib/note-sync.test.ts` (create) | Tests for `note-sync.ts`, including the ordering invariant. | 2 |
| `src/app/api/episode-notes/sync/route.ts` (create) | Thin HTTP shell: `x-eh-key` auth + rate limit, wires real deps into `syncComments`. | 2 |
| `src/app/api/episode-notes/open/route.ts` (create) | `x-eh-key`-authed read of the open-episode pointer, so the bot can resolve `threadId`. | 2 |
| `src/lib/discord-thread.ts` (create) | Discord REST calls with a bot token: post a message, create a thread on it. Plus the pure `threadNameFor()` helper. Lives in `src/lib/` so it is typechecked. | 3 |
| `src/lib/discord-thread.test.ts` (create) | Tests for `threadNameFor` and the REST wrapper's failure handling (injected `fetch`). | 3 |
| `scripts/notify-discord.ts` (modify) | The `notes-open` branch calls `discord-thread.ts` when a bot token is configured, falls back to the webhook otherwise, and always writes the pointer. | 3 |
| `scripts/notify-notes-open.test.ts` (modify) | Tests for the branch-selection helper. | 3 |
| `.github/workflows/ingest-episode.yml` (modify) | Map `DISCORD_BOT_TOKEN` and `DISCORD_ENGINEERS_CHANNEL_ID` into the notes-open step. | 3 |
| `src/app/review/submissions/page.tsx` (modify) | Show note `source` in the Notable Moments tab. | 5 |

**Bot repo (`/opt/projects/transcript-bot`):**

| File | Responsibility | Task |
| --- | --- | --- |
| `src/thread-notes.ts` (create) | Pure helpers: filter thread messages to admin-reacted comments, build the sync payload, format the reply. No discord.js imports — plain data in, plain data out. | 4 |
| `src/thread-notes.test.ts` (create) | Tests for those helpers. | 4 |
| `scripts/discord-bot.ts` (modify) | Add `MessageContent` intent, `/pdc-sync-notes` handler, Discord fetching + app POST. | 4 |
| `scripts/discord-register.ts` (modify) | Register `/pdc-sync-notes`. | 4 |
| `package.json` (modify) | Add a `test` script (none exists today). | 4 |

---

### Task 1: Types, guards, and note builders

Pure type + guard changes in one file, plus tests. No behaviour changes to any caller yet.

**Files:**
- Modify: `src/lib/episode-notes.ts`
- Test: `src/lib/episode-notes.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces, for Tasks 2/3/5:
  - `interface OpenEpisode { episode: string; film: string; openedAt: string; threadId: string | null }`
  - `interface EpisodeNote { ...existing; discordMessageId?: string; source?: NoteSource }`
  - `type NoteSource = 'command' | 'thread'`
  - `function isOpenEpisode(value: unknown): value is OpenEpisode`
  - `function buildThreadNote(value: { episode: string; note: string; submittedBy: string; discordMessageId: string }, id: string, createdAt: string): EpisodeNote`
  - `function listSyncedMessageIds(notes: EpisodeNote[]): Set<string>`

**Background you need:** `OpenEpisode` documents already exist in Vercel Blob at `episode-notes/open.json` **without** a `threadId` field. `getOpenEpisode()` today has no type guard at all — it casts blindly. Both facts matter: the new guard must accept a legacy document (missing `threadId`) and normalise it to `threadId: null`, or the very next ingest run breaks `/pdc-note` for everyone.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/episode-notes.test.ts`:

```typescript
import {
  isOpenEpisode,
  buildThreadNote,
  listSyncedMessageIds,
  type EpisodeNote,
} from './episode-notes.ts';

test('isOpenEpisode accepts a document with a threadId', () => {
  assert.equal(
    isOpenEpisode({ episode: '317', film: 'Barton Fink (1991)', openedAt: '2026-08-05T00:00:00.000Z', threadId: '123' }),
    true
  );
});

test('isOpenEpisode accepts a legacy document with no threadId at all', () => {
  // Pointers written before this feature have no threadId. Rejecting them
  // would break /pdc-note for every already-open episode.
  assert.equal(
    isOpenEpisode({ episode: '317', film: 'Barton Fink (1991)', openedAt: '2026-08-05T00:00:00.000Z' }),
    true
  );
});

test('isOpenEpisode accepts an explicit null threadId', () => {
  assert.equal(
    isOpenEpisode({ episode: '317', film: '', openedAt: '2026-08-05T00:00:00.000Z', threadId: null }),
    true
  );
});

test('isOpenEpisode rejects a wrongly typed threadId', () => {
  assert.equal(
    isOpenEpisode({ episode: '317', film: '', openedAt: '2026-08-05T00:00:00.000Z', threadId: 123 }),
    false
  );
});

test('isOpenEpisode rejects documents missing required fields', () => {
  assert.equal(isOpenEpisode({}), false);
  assert.equal(isOpenEpisode(null), false);
  assert.equal(isOpenEpisode({ episode: '317', film: '' }), false);
});

test('buildThreadNote records the message id, the source, and lands approved', () => {
  const note = buildThreadNote(
    { episode: '317', note: 'The Roy Scheider tangent', submittedBy: 'jason#0', discordMessageId: 'm1' },
    'note_1',
    '2026-08-05T00:00:00.000Z'
  );
  assert.equal(note.status, 'approved');
  assert.equal(note.source, 'thread');
  assert.equal(note.discordMessageId, 'm1');
  assert.equal(note.resolvedAt, '2026-08-05T00:00:00.000Z');
});

test('buildThreadNote output passes the isEpisodeNote guard', () => {
  const note = buildThreadNote(
    { episode: '317', note: 'A moment', submittedBy: 'jason#0', discordMessageId: 'm1' },
    'note_1',
    '2026-08-05T00:00:00.000Z'
  );
  assert.equal(isEpisodeNote(note), true);
});

test('listSyncedMessageIds collects ids and ignores notes without one', () => {
  const notes = [
    { discordMessageId: 'm1' },
    { discordMessageId: 'm2' },
    {},
    { discordMessageId: '' },
  ] as EpisodeNote[];
  const ids = listSyncedMessageIds(notes);
  assert.equal(ids.has('m1'), true);
  assert.equal(ids.has('m2'), true);
  assert.equal(ids.has(''), false);
  assert.equal(ids.size, 2);
});
```

Note: `isEpisodeNote` is already imported by the existing test file. If it is not, add it to the import list rather than creating a second import statement.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:notes`
Expected: FAIL — `SyntaxError`/`TypeError` on the imports, e.g. `The requested module './episode-notes.ts' does not provide an export named 'isOpenEpisode'`.

- [ ] **Step 3: Write the implementation**

In `src/lib/episode-notes.ts`, extend the type block (replacing the existing `EpisodeNote` and `OpenEpisode` declarations):

```typescript
export type NoteStatus = 'pending' | 'approved' | 'rejected';

/**
 * Where a note came from. 'command' is /pdc-note (admin-approved in
 * /review/submissions); 'thread' is a comment in the episode thread that an
 * admin reacted to and /pdc-sync-notes collected.
 */
export type NoteSource = 'command' | 'thread';

export interface EpisodeNote {
  id: string;
  episode: string;
  note: string;
  /** Discord tag of the submitter, so every note is attributable. */
  submittedBy: string;
  createdAt: string;
  status: NoteStatus;
  resolvedAt?: string;
  /**
   * Set for thread-sourced notes. This is the idempotency key: a comment whose
   * id is already stored is skipped without touching the sheet, so re-running
   * /pdc-sync-notes on the same thread is safe.
   */
  discordMessageId?: string;
  /** Absent on notes stored before this field existed; treat as 'command'. */
  source?: NoteSource;
}

export interface OpenEpisode {
  episode: string;
  film: string;
  openedAt: string;
  /**
   * The Discord thread comments are collected from. null when thread creation
   * failed or the pointer predates the thread redesign — /pdc-note still works,
   * only /pdc-sync-notes needs this.
   */
  threadId: string | null;
}
```

Add the guard next to `isEpisodeNote`:

```typescript
/**
 * Guards a parsed Blob document before it is trusted as an OpenEpisode.
 *
 * `threadId` is deliberately optional here: pointers written before the thread
 * redesign have no such field, and rejecting them would break /pdc-note for
 * every already-open episode. Callers normalise a missing value to null.
 */
export function isOpenEpisode(value: unknown): value is OpenEpisode {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.episode !== 'string' ||
    typeof v.film !== 'string' ||
    typeof v.openedAt !== 'string'
  ) {
    return false;
  }
  return v.threadId === undefined || v.threadId === null || typeof v.threadId === 'string';
}
```

Add the thread-note builder next to `buildNote`:

```typescript
/**
 * A thread comment arrives already approved — the admin's reaction was the
 * approval, and the caller appends to the sheet before this note is stored.
 * There is no pending state for it to sit in.
 */
export function buildThreadNote(
  value: { episode: string; note: string; submittedBy: string; discordMessageId: string },
  id: string,
  createdAt: string
): EpisodeNote {
  return {
    id,
    episode: value.episode,
    note: value.note,
    submittedBy: value.submittedBy,
    discordMessageId: value.discordMessageId,
    createdAt,
    status: 'approved',
    resolvedAt: createdAt,
    source: 'thread',
  };
}

/** The set of Discord message ids already synced, for skip-without-sheet-write. */
export function listSyncedMessageIds(notes: EpisodeNote[]): Set<string> {
  const ids = new Set<string>();
  for (const n of notes) {
    if (typeof n.discordMessageId === 'string' && n.discordMessageId !== '') {
      ids.add(n.discordMessageId);
    }
  }
  return ids;
}
```

Finally, apply the guard in `getOpenEpisode` and normalise `threadId` (replacing the existing function body):

```typescript
export async function getOpenEpisode(): Promise<OpenEpisode | null> {
  const { blobs } = await list({ prefix: OPEN_KEY });
  const match = blobs.find(b => b.pathname === OPEN_KEY);
  if (!match) return null;
  try {
    const result = await fetchBlobJson<unknown>(match.url, match.size, 'fast');
    if (!result) return null;
    if (!isOpenEpisode(result.data)) {
      console.warn('[episode-notes] open.json failed the OpenEpisode guard — ignoring.');
      return null;
    }
    // Legacy pointers have no threadId; normalise so callers never see undefined.
    return { ...result.data, threadId: result.data.threadId ?? null };
  } catch (err) {
    console.warn(
      `[episode-notes] could not read open.json: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:notes`
Expected: PASS — all tests, including the pre-existing ones (16 before this task; more now).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. In particular, `scripts/notify-discord.ts:260` constructs an `OpenEpisode` without `threadId` — but `scripts/` is excluded from tsconfig, so this will **not** surface here. Task 3 fixes that call site. Do not chase it now.

- [ ] **Step 6: Commit**

```bash
git add src/lib/episode-notes.ts src/lib/episode-notes.test.ts
git commit -m "feat(notes): add threadId, discordMessageId, source, and an OpenEpisode guard"
```

---

### Task 2: Batch sync endpoint

The app side of `/pdc-sync-notes`: a batch endpoint that appends reacted comments to `Notable_Moments` idempotently, plus a small read endpoint so the bot can resolve the open thread.

**Files:**
- Create: `src/lib/note-sync.ts`
- Create: `src/lib/note-sync.test.ts`
- Create: `src/app/api/episode-notes/sync/route.ts`
- Create: `src/app/api/episode-notes/open/route.ts`
- Modify: `package.json` (add `note-sync.test.ts` to `test:notes`)

**Interfaces:**
- Consumes from Task 1: `EpisodeNote`, `buildThreadNote`, `listSyncedMessageIds`, `saveNote`, `listNotes`, `getOpenEpisode`, `normaliseNoteText`.
- Produces, for Task 4 (the bot):
  - `POST /api/episode-notes/sync`, header `x-eh-key`, body `{ episode: string, comments: Array<{ discordMessageId: string, text: string, submittedBy: string }> }`
  - Response `200`: `{ ok: true, results: SyncResult[], summary: { considered: number, appended: number, duplicate: number, alreadySynced: number, failed: number } }`
  - `type SyncOutcome = 'appended' | 'duplicate' | 'already_synced' | 'invalid_note' | 'no_sheet_row' | 'append_failed'`
  - `interface SyncResult { discordMessageId: string; outcome: SyncOutcome }`
  - `GET /api/episode-notes/open`, header `x-eh-key`, response `200`: `{ open: { episode: string, film: string, threadId: string | null } | null }`

**Why the logic lives in `note-sync.ts` and not the route:** the append-before-record ordering is the one invariant that actually protects data, and a route handler cannot be unit-tested without a live Blob store and a live Google Sheet. Injecting the two effects makes the ordering assertable. This was flagged as a deferred item in the previous build's ledger; do it now.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/note-sync.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSyncInput, syncComments, type SyncDeps } from './note-sync.ts';
import type { EpisodeNote } from './episode-notes.ts';

function deps(overrides: Partial<SyncDeps> = {}): SyncDeps & { calls: string[]; saved: EpisodeNote[] } {
  const calls: string[] = [];
  const saved: EpisodeNote[] = [];
  return {
    calls,
    saved,
    listNotes: async () => [],
    appendToCell: async () => {
      calls.push('append');
      return 'appended' as const;
    },
    saveNote: async (n: EpisodeNote) => {
      calls.push('save');
      saved.push(n);
    },
    now: () => '2026-08-05T00:00:00.000Z',
    newId: (i: number) => `note_${i}`,
    ...overrides,
  };
}

test('validateSyncInput accepts a well-formed batch', () => {
  const r = validateSyncInput({
    episode: '317',
    comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.episode, '317');
    assert.equal(r.value.comments.length, 1);
  }
});

test('validateSyncInput rejects a missing episode', () => {
  const r = validateSyncInput({ comments: [] });
  assert.equal(r.ok, false);
});

test('validateSyncInput rejects a non-array comments field', () => {
  const r = validateSyncInput({ episode: '317', comments: 'nope' });
  assert.equal(r.ok, false);
});

test('validateSyncInput rejects an empty batch', () => {
  const r = validateSyncInput({ episode: '317', comments: [] });
  assert.equal(r.ok, false);
});

test('validateSyncInput drops comments with no discordMessageId', () => {
  const r = validateSyncInput({
    episode: '317',
    comments: [
      { discordMessageId: '', text: 'A great moment here', submittedBy: 'jason#0' },
      { discordMessageId: 'm2', text: 'Another great moment', submittedBy: 'jason#0' },
    ],
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value.comments.map(c => c.discordMessageId), ['m2']);
});

test('syncComments appends then records, in that order', async () => {
  const d = deps();
  await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  // The invariant: a failed sheet write must leave nothing recorded, which is
  // only true if append strictly precedes save.
  assert.deepEqual(d.calls, ['append', 'save']);
});

test('syncComments records the message id and thread source on the saved note', async () => {
  const d = deps();
  await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(d.saved[0].discordMessageId, 'm1');
  assert.equal(d.saved[0].source, 'thread');
  assert.equal(d.saved[0].status, 'approved');
  assert.equal(d.saved[0].episode, '317');
});

test('syncComments skips an already-synced comment without touching the sheet', async () => {
  const d = deps({
    listNotes: async () => [
      { id: 'n1', episode: '317', note: 'x', submittedBy: 'j', createdAt: 'z', status: 'approved', discordMessageId: 'm1' },
    ] as EpisodeNote[],
  });
  const r = await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.deepEqual(d.calls, []);
  assert.equal(r.results[0].outcome, 'already_synced');
  assert.equal(r.summary.alreadySynced, 1);
});

test('syncComments still records a duplicate so it is not retried forever', async () => {
  const d = deps({
    appendToCell: async () => 'duplicate' as const,
  });
  const r = await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(r.results[0].outcome, 'duplicate');
  assert.equal(d.saved.length, 1);
  assert.equal(r.summary.duplicate, 1);
});

test('syncComments records nothing when the sheet has no row', async () => {
  const d = deps({ appendToCell: async () => 'no_row' as const });
  const r = await syncComments(
    { episode: '999', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(r.results[0].outcome, 'no_sheet_row');
  assert.equal(d.saved.length, 0);
  assert.equal(r.summary.failed, 1);
});

test('syncComments records nothing when the sheet write throws', async () => {
  const d = deps({
    appendToCell: async () => {
      throw new Error('sheets 503');
    },
  });
  const r = await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(r.results[0].outcome, 'append_failed');
  assert.equal(d.saved.length, 0);
});

test('syncComments normalises text before it reaches the sheet', async () => {
  const appended: string[] = [];
  const d = deps({
    appendToCell: async (_ep: string, _col: string, line: string) => {
      appended.push(line);
      return 'appended' as const;
    },
  });
  await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'line one\nline two', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(appended[0], 'line one line two');
});

test('syncComments rejects a comment too short to be a bullet', async () => {
  const d = deps();
  const r = await syncComments(
    { episode: '317', comments: [{ discordMessageId: 'm1', text: 'ok', submittedBy: 'jason#0' }] },
    d
  );
  assert.equal(r.results[0].outcome, 'invalid_note');
  assert.deepEqual(d.calls, []);
});

test('syncComments keeps going after one comment fails', async () => {
  let n = 0;
  const d = deps({
    appendToCell: async () => {
      n += 1;
      if (n === 1) throw new Error('sheets 503');
      return 'appended' as const;
    },
  });
  const r = await syncComments(
    {
      episode: '317',
      comments: [
        { discordMessageId: 'm1', text: 'A great moment here', submittedBy: 'jason#0' },
        { discordMessageId: 'm2', text: 'Another great moment', submittedBy: 'jason#0' },
      ],
    },
    d
  );
  assert.equal(r.results[0].outcome, 'append_failed');
  assert.equal(r.results[1].outcome, 'appended');
  assert.equal(r.summary.considered, 2);
  assert.equal(r.summary.appended, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/lib/note-sync.test.ts`
Expected: FAIL — `Cannot find module './note-sync.ts'`.

- [ ] **Step 3: Write `src/lib/note-sync.ts`**

```typescript
/**
 * Batch sync of admin-reacted thread comments into Notable_Moments.
 *
 * The effects (sheet write, note store, clock, id generation) are injected so
 * the ordering invariant this module exists to protect — append to the sheet
 * BEFORE recording the note — can be asserted in a unit test. The route
 * handler in src/app/api/episode-notes/sync/route.ts is a thin shell that
 * supplies the real implementations.
 */
import {
  buildThreadNote,
  listSyncedMessageIds,
  normaliseNoteText,
  type EpisodeNote,
} from './episode-notes';
import type { PdcColumnKey } from './pdc-sheet';

export interface SyncComment {
  discordMessageId: string;
  text: string;
  submittedBy: string;
}

export interface SyncInput {
  episode: string;
  comments: SyncComment[];
}

export type SyncOutcome =
  | 'appended'
  | 'duplicate'
  | 'already_synced'
  | 'invalid_note'
  | 'no_sheet_row'
  | 'append_failed';

export interface SyncResult {
  discordMessageId: string;
  outcome: SyncOutcome;
}

export interface SyncSummary {
  considered: number;
  appended: number;
  duplicate: number;
  alreadySynced: number;
  failed: number;
}

export interface SyncDeps {
  listNotes: (status?: 'pending' | 'approved' | 'rejected' | 'all') => Promise<EpisodeNote[]>;
  appendToCell: (
    episode: string,
    column: PdcColumnKey,
    line: string
  ) => Promise<'appended' | 'duplicate' | 'no_row'>;
  saveNote: (note: EpisodeNote) => Promise<void>;
  now: () => string;
  newId: (index: number) => string;
}

/** A batch of thread comments is capped so one command cannot flood the sheet. */
const MAX_COMMENTS = 50;

export function validateSyncInput(
  input: unknown
): { ok: true; value: SyncInput } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'body must be an object' };
  }
  const o = input as Record<string, unknown>;

  const episode = String(o.episode ?? '').trim();
  if (episode === '') return { ok: false, reason: 'episode is required' };

  if (!Array.isArray(o.comments)) {
    return { ok: false, reason: 'comments must be an array' };
  }

  const comments: SyncComment[] = [];
  for (const raw of o.comments) {
    if (typeof raw !== 'object' || raw === null) continue;
    const c = raw as Record<string, unknown>;
    const discordMessageId = String(c.discordMessageId ?? '').trim();
    // No id means no idempotency key, so it could be appended twice on a
    // re-run. Drop it rather than risk a duplicate the sheet guard may miss.
    if (discordMessageId === '') continue;
    comments.push({
      discordMessageId,
      text: String(c.text ?? ''),
      submittedBy: String(c.submittedBy ?? '').trim() || 'unknown',
    });
  }

  if (comments.length === 0) {
    return { ok: false, reason: 'comments must contain at least one identified comment' };
  }
  if (comments.length > MAX_COMMENTS) {
    return { ok: false, reason: `at most ${MAX_COMMENTS} comments per sync` };
  }

  return { ok: true, value: { episode, comments } };
}

export async function syncComments(
  input: SyncInput,
  deps: SyncDeps
): Promise<{ results: SyncResult[]; summary: SyncSummary }> {
  // First idempotency layer: a comment already stored is skipped without any
  // sheet traffic. The second layer is appendBullet's duplicate detection,
  // which catches a comment edited to match text already in the cell.
  let synced: Set<string>;
  try {
    synced = listSyncedMessageIds(await deps.listNotes('all'));
  } catch (err) {
    // Without the stored ids we would re-append everything. Fail the batch
    // rather than risk duplicates; the command is retryable.
    console.error('[note-sync] could not list notes:', err);
    throw err;
  }

  const results: SyncResult[] = [];

  for (let i = 0; i < input.comments.length; i += 1) {
    const c = input.comments[i];

    if (synced.has(c.discordMessageId)) {
      results.push({ discordMessageId: c.discordMessageId, outcome: 'already_synced' });
      continue;
    }

    const normalised = normaliseNoteText(c.text);
    if (!normalised.ok) {
      console.warn(`[note-sync] skipping ${c.discordMessageId}: ${normalised.reason}`);
      results.push({ discordMessageId: c.discordMessageId, outcome: 'invalid_note' });
      continue;
    }

    try {
      const outcome = await deps.appendToCell(input.episode, 'Notable_Moments', normalised.value);
      if (outcome === 'no_row') {
        console.warn(`[note-sync] no sheet row for episode ${input.episode}`);
        results.push({ discordMessageId: c.discordMessageId, outcome: 'no_sheet_row' });
        continue; // nothing recorded — retryable once the row exists
      }

      // Recorded only after the sheet write succeeded. A 'duplicate' is still
      // recorded: the text is already in the cell, so re-attempting it every
      // sync would be pure noise.
      const at = deps.now();
      await deps.saveNote(
        buildThreadNote(
          {
            episode: input.episode,
            note: normalised.value,
            submittedBy: c.submittedBy,
            discordMessageId: c.discordMessageId,
          },
          deps.newId(i),
          at
        )
      );
      results.push({ discordMessageId: c.discordMessageId, outcome });
    } catch (err) {
      console.error(`[note-sync] append failed for ${c.discordMessageId}:`, err);
      results.push({ discordMessageId: c.discordMessageId, outcome: 'append_failed' });
    }
  }

  const summary: SyncSummary = {
    considered: results.length,
    appended: results.filter(r => r.outcome === 'appended').length,
    duplicate: results.filter(r => r.outcome === 'duplicate').length,
    alreadySynced: results.filter(r => r.outcome === 'already_synced').length,
    failed: results.filter(
      r => r.outcome === 'append_failed' || r.outcome === 'no_sheet_row' || r.outcome === 'invalid_note'
    ).length,
  };

  return { results, summary };
}
```

`PdcColumnKey` is already exported from `src/lib/pdc-sheet.ts:22` — import it as a type only (`import type { PdcColumnKey } from './pdc-sheet'`) so this module never pulls `googleapis` into a test process. Do not modify `pdc-sheet.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/lib/note-sync.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Write the sync route**

Create `src/app/api/episode-notes/sync/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { validateExternalKey } from '@/lib/external-auth';
import { checkRateLimit } from '@/lib/external-rate-limit';
import { listNotes, saveNote, newNoteId } from '@/lib/episode-notes';
import { appendToCell } from '@/lib/pdc-sheet';
import { validateSyncInput, syncComments } from '@/lib/note-sync';

/**
 * Batch-append admin-reacted thread comments to Notable_Moments.
 *
 * Called by the Discord bot's /pdc-sync-notes, so it uses the same x-eh-key
 * auth as the other external endpoints. All the interesting logic — including
 * the append-before-record ordering — lives in src/lib/note-sync.ts, which is
 * unit-tested; this handler only supplies the real effects.
 */
export async function POST(request: NextRequest) {
  const auth = validateExternalKey(request.headers.get('x-eh-key'));
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.reason === 'missing' ? 'Missing x-eh-key header' : 'Invalid key' },
      { status: 401 }
    );
  }

  const rl = checkRateLimit(auth.keyId);
  if (!rl.allowed) {
    const headers: Record<string, string> = {};
    if (rl.retryAfterSec) headers['Retry-After'] = String(rl.retryAfterSec);
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const validated = validateSyncInput(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 400 });
  }

  const stamp = Date.now();
  try {
    const { results, summary } = await syncComments(validated.value, {
      listNotes,
      appendToCell,
      saveNote,
      now: () => new Date().toISOString(),
      newId: (i: number) => newNoteId(stamp + i, Math.random().toString(36).slice(2, 10)),
    });
    return NextResponse.json({ ok: true, results, summary });
  } catch (err) {
    console.error('[episode-notes/sync] batch failed:', err);
    return NextResponse.json({ error: 'Sync failed — nothing was appended.' }, { status: 500 });
  }
}
```

- [ ] **Step 6: Write the open-pointer route**

Create `src/app/api/episode-notes/open/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { validateExternalKey } from '@/lib/external-auth';
import { getOpenEpisode } from '@/lib/episode-notes';

/**
 * Read the currently open episode, including the thread its comments live in.
 *
 * The bot calls this to resolve threadId for /pdc-sync-notes when the command
 * is run outside the thread. x-eh-key authed like the other bot-facing routes.
 */
export async function GET(request: NextRequest) {
  const auth = validateExternalKey(request.headers.get('x-eh-key'));
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.reason === 'missing' ? 'Missing x-eh-key header' : 'Invalid key' },
      { status: 401 }
    );
  }

  try {
    const open = await getOpenEpisode();
    return NextResponse.json({ open });
  } catch (err) {
    console.error('[episode-notes/open] read failed:', err);
    return NextResponse.json({ error: 'Failed to read the open episode' }, { status: 500 });
  }
}
```

- [ ] **Step 7: Wire the new test file into the suite**

In `package.json`, change the `test:notes` script:

```json
"test:notes": "node --import tsx --test src/lib/episode-notes.test.ts src/lib/note-sync.test.ts"
```

This is the orphan check for this task: a test file not in a script is a test file nobody runs. A prior build dropped one exactly this way.

- [ ] **Step 8: Verify**

Run: `npm run test:notes && npx tsc --noEmit`
Expected: all tests PASS, tsc reports no errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/note-sync.ts src/lib/note-sync.test.ts src/app/api/episode-notes/sync/route.ts src/app/api/episode-notes/open/route.ts package.json
git commit -m "feat(notes): batch sync endpoint for admin-reacted thread comments"
```

---

### Task 3: The announcement becomes a thread

Replace the webhook post for `notes-open` with a bot-token post plus a thread, and record `threadId` on the pointer.

**Files:**
- Create: `src/lib/discord-thread.ts`
- Create: `src/lib/discord-thread.test.ts`
- Modify: `scripts/notify-discord.ts:250-282` (the `notes-open` branch) and its `buildNotesOpenMessage` copy at `:120-140`
- Modify: `scripts/notify-notes-open.test.ts`
- Modify: `.github/workflows/ingest-episode.yml:88-95`
- Modify: `package.json` (add `discord-thread.test.ts` to `test:notes`)

**Interfaces:**
- Consumes from Task 1: `setOpenEpisode`, `OpenEpisode` (with `threadId`).
- Produces:
  - `function threadNameFor(episode: string, film: string): string`
  - `async function announceWithThread(opts: AnnounceOptions): Promise<{ messageId: string; threadId: string | null } | null>`
  - `interface AnnounceOptions { token: string; channelId: string; payload: unknown; threadName: string; fetchImpl?: typeof fetch }`

**Critical ordering note — read this before writing code.** The current branch writes the Blob pointer *first*, deliberately: a previous build gated the pointer write behind the webhook lookup, and a missing webhook secret silently broke `/pdc-note` for every contributor with CI green. The new code needs the announcement to run first (that is where `threadId` comes from), which reverses the order. **The pointer write must therefore be unconditional and outside any early return** — reachable on every path, including "no bot token", "post failed", and "thread creation failed". If you find yourself writing `return` before `setOpenEpisode`, you have reintroduced the bug.

Discord REST specifics you need:
- Post: `POST https://discord.com/api/v10/channels/{channelId}/messages`, header `Authorization: Bot {token}`, JSON body identical to the webhook payload's `embeds`/`content`. Response JSON has `id`.
- Thread: `POST https://discord.com/api/v10/channels/{channelId}/messages/{messageId}/threads`, body `{ name, auto_archive_duration: 10080 }`. Response JSON has `id` — that is the thread id. `10080` minutes is 7 days, the longest available.
- Thread names are capped at **100 characters** by Discord; a longer name is rejected outright.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/discord-thread.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadNameFor, announceWithThread } from './discord-thread.ts';

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
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith('/threads')) {
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/lib/discord-thread.test.ts`
Expected: FAIL — `Cannot find module './discord-thread.ts'`.

- [ ] **Step 3: Write `src/lib/discord-thread.ts`**

```typescript
/**
 * Posting an episode announcement as a bot, with a thread on it.
 *
 * A channel webhook can post a message but cannot create a thread on it; that
 * requires a bot token. This module is the only place in the app repo that
 * talks to Discord as a bot.
 *
 * It lives under src/lib/ rather than scripts/ on purpose: scripts/ is
 * excluded from tsconfig.json, so nothing there is typechecked.
 */

const DISCORD_API = 'https://discord.com/api/v10';

/** Discord rejects thread names longer than this outright. */
const MAX_THREAD_NAME = 100;

/** 7 days, the longest auto-archive Discord offers. */
const AUTO_ARCHIVE_MINUTES = 10080;

export interface AnnounceOptions {
  token: string;
  channelId: string;
  /** The same shape the webhook path posts: { content?, embeds? }. */
  payload: unknown;
  threadName: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/** Matches the announcement embed title, so the thread reads the same way. */
export function threadNameFor(episode: string, film: string): string {
  const name = film ? `Ep ${episode} · ${film}` : `Episode ${episode}`;
  return name.length > MAX_THREAD_NAME ? name.slice(0, MAX_THREAD_NAME) : name;
}

/**
 * Post the announcement and open a thread on it.
 *
 * Returns null when the announcement itself failed. Returns a null `threadId`
 * when the message posted but the thread did not — a degraded success: the
 * announcement is visible and the open-episode pointer is still written, so
 * /pdc-note keeps working and only /pdc-sync-notes has nothing to read.
 * Never throws; every Discord step in this project is non-fatal.
 */
export async function announceWithThread(
  opts: AnnounceOptions
): Promise<{ messageId: string; threadId: string | null } | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bot ${opts.token}`,
    'Content-Type': 'application/json',
  };

  let messageId: string;
  try {
    const res = await doFetch(`${DISCORD_API}/channels/${opts.channelId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.payload),
    });
    if (!res.ok) {
      console.warn(
        `[discord-thread] posting the announcement returned ${res.status}: ${await res.text()}`
      );
      return null;
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      console.warn('[discord-thread] Discord returned no message id — cannot create a thread.');
      return null;
    }
    messageId = data.id;
  } catch (err) {
    console.warn(
      `[discord-thread] posting the announcement failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  try {
    const res = await doFetch(
      `${DISCORD_API}/channels/${opts.channelId}/messages/${messageId}/threads`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: opts.threadName,
          auto_archive_duration: AUTO_ARCHIVE_MINUTES,
        }),
      }
    );
    if (!res.ok) {
      console.warn(
        `[discord-thread] creating the thread returned ${res.status}: ${await res.text()}`
      );
      return { messageId, threadId: null };
    }
    const data = (await res.json()) as { id?: string };
    return { messageId, threadId: data.id ?? null };
  } catch (err) {
    console.warn(
      `[discord-thread] creating the thread failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { messageId, threadId: null };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/lib/discord-thread.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Write the failing test for the branch selector**

Append to `scripts/notify-notes-open.test.ts` (add `notesOpenTransport` to the existing import from `./notify-discord.ts`):

```typescript
test('notesOpenTransport prefers the bot when both a token and a channel id are set', () => {
  assert.deepEqual(
    notesOpenTransport({
      DISCORD_BOT_TOKEN: 't',
      DISCORD_ENGINEERS_CHANNEL_ID: 'c',
      DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng',
    }),
    { kind: 'bot', token: 't', channelId: 'c' }
  );
});

test('notesOpenTransport falls back to the webhook when the bot is half-configured', () => {
  // A token with no channel id (or vice versa) cannot post; the webhook still
  // can, so the announcement degrades to threadless rather than vanishing.
  assert.deepEqual(
    notesOpenTransport({ DISCORD_BOT_TOKEN: 't', DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' }),
    { kind: 'webhook', url: 'https://eng' }
  );
  assert.deepEqual(
    notesOpenTransport({ DISCORD_ENGINEERS_CHANNEL_ID: 'c', DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' }),
    { kind: 'webhook', url: 'https://eng' }
  );
});

test('notesOpenTransport reports none when nothing is configured', () => {
  assert.deepEqual(notesOpenTransport({}), { kind: 'none' });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm run test:notify`
Expected: FAIL — no export named `notesOpenTransport`.

- [ ] **Step 7: Update `scripts/notify-discord.ts`**

Add the transport selector next to `webhookForEvent` (around line 154):

```typescript
export type NotesOpenTransport =
  | { kind: 'bot'; token: string; channelId: string }
  | { kind: 'webhook'; url: string }
  | { kind: 'none' };

/**
 * The bot path is preferred because only a bot token can create the thread
 * comments are collected in. The webhook is kept as a fallback so a
 * half-configured bot degrades to a threadless announcement rather than
 * silence — DISCORD_ENGINEERS_WEBHOOK_URL is no longer required, but is still
 * honoured while the migration lands.
 */
export function notesOpenTransport(env: Record<string, string | undefined>): NotesOpenTransport {
  const token = env.DISCORD_BOT_TOKEN;
  const channelId = env.DISCORD_ENGINEERS_CHANNEL_ID;
  if (token && channelId) return { kind: 'bot', token, channelId };
  const url = env.DISCORD_ENGINEERS_WEBHOOK_URL;
  if (url) return { kind: 'webhook', url };
  return { kind: 'none' };
}
```

Then replace the whole `if (event === 'notes-open') { ... }` block (currently lines 250-282) with:

```typescript
  if (event === 'notes-open') {
    const ep = getArg(args, 'episode')?.replace(/^episode_/, '').trim();
    if (!ep) {
      console.warn('[notify-discord] notes-open needs --episode — skipping.');
      return;
    }
    const film = resolveNotesOpenFilm(ep, getArg(args, 'film'), metadataPath);

    // Announce first, because the thread id it produces goes on the pointer.
    // Every failure below is non-fatal and leaves threadId null.
    let threadId: string | null = null;
    const transport = notesOpenTransport(process.env);

    if (transport.kind === 'bot') {
      const { announceWithThread, threadNameFor } = await import('../src/lib/discord-thread');
      const result = await announceWithThread({
        token: transport.token,
        channelId: transport.channelId,
        payload: buildNotesOpenMessage(ep, film),
        threadName: threadNameFor(ep, film),
      });
      threadId = result?.threadId ?? null;
      if (result && threadId) console.log(`[notify-discord] Posted announcement and opened thread ${threadId}.`);
      else if (result) console.warn('[notify-discord] Announced, but the thread was not created.');
    } else if (transport.kind === 'webhook') {
      console.warn('[notify-discord] No bot token/channel id — posting via webhook, so no thread.');
      try {
        await postToDiscord(transport.url, buildNotesOpenMessage(ep, film));
        console.log('[notify-discord] Posted notification.');
      } catch (err) {
        console.warn(
          `[notify-discord] Failed to post (non-fatal): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      console.warn('[notify-discord] Neither DISCORD_BOT_TOKEN+DISCORD_ENGINEERS_CHANNEL_ID nor DISCORD_ENGINEERS_WEBHOOK_URL is set — skipping the announcement.');
    }

    // Unconditional, and deliberately AFTER the announcement but outside every
    // early return: the pointer write needs only BLOB_READ_WRITE_TOKEN, and
    // gating it behind a Discord secret silently broke /pdc-note for every
    // contributor once already. A null threadId is a valid pointer.
    try {
      const { setOpenEpisode } = await import('../src/lib/episode-notes');
      await setOpenEpisode({ episode: ep, film, openedAt: new Date().toISOString(), threadId });
    } catch (err) {
      console.warn(
        `[notify-discord] could not record open episode: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }
```

Also update the announcement copy in `buildNotesOpenMessage` (lines 130-137) so it points at the thread rather than the slash command:

```typescript
      {
        title,
        description:
          'This episode is now open for Notable Moments.\n\n' +
          '**Reply in this thread** with any moment worth recording — one per message, as many as you like.\n' +
          'An admin reacts ✅ to the ones that should go in the sheet, then runs `/pdc-sync-notes`.\n\n' +
          'Thought of one later, outside the thread? `/pdc-note note: Haitch\'s Roy Scheider tangent around 42:00` still works.',
        color: AMBER,
      },
```

The existing test `notes-open tells people the command and shows an example` asserts `/\/pdc-note/` and `/note:/` against this description; the copy above keeps both, so it still passes. Do not delete that test.

- [ ] **Step 8: Run the notify tests**

Run: `npm run test:notify`
Expected: PASS — including the pre-existing `buildNotesOpenMessage` and `webhookForEvent` tests.

- [ ] **Step 9: Map the new secrets into the workflow**

In `.github/workflows/ingest-episode.yml`, replace the notes-open step (lines 88-95) with:

```yaml
      # Open the episode for Notable Moment nominations in #engineers.
      # The bot token is what makes a thread possible; the webhook is kept as a
      # fallback so a half-configured bot still announces (threadless).
      - name: Notify Discord — notes open
        continue-on-error: true
        env:
          DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}
          DISCORD_ENGINEERS_CHANNEL_ID: ${{ secrets.DISCORD_ENGINEERS_CHANNEL_ID }}
          DISCORD_ENGINEERS_WEBHOOK_URL: ${{ secrets.DISCORD_ENGINEERS_WEBHOOK_URL }}
          BLOB_READ_WRITE_TOKEN: ${{ secrets.BLOB_READ_WRITE_TOKEN }}
          EPISODE: ${{ inputs.episode }}
        run: node --import tsx ./scripts/notify-discord.ts --event=notes-open --episode="$EPISODE"
```

An unmapped secret is the silent-inertness failure mode this project keeps hitting. Both new vars must be listed.

- [ ] **Step 10: Wire the new test file into the suite**

In `package.json`, change `test:notes`:

```json
"test:notes": "node --import tsx --test src/lib/episode-notes.test.ts src/lib/note-sync.test.ts src/lib/discord-thread.test.ts"
```

- [ ] **Step 11: Verify**

Run: `npm run test:notes && npm run test:notify && npx tsc --noEmit`
Expected: all PASS, tsc clean.

- [ ] **Step 12: Commit**

```bash
git add src/lib/discord-thread.ts src/lib/discord-thread.test.ts scripts/notify-discord.ts scripts/notify-notes-open.test.ts .github/workflows/ingest-episode.yml package.json
git commit -m "feat(notes): post the episode announcement as a bot and open a thread on it"
```

---

### Task 4: `/pdc-sync-notes` — SEPARATE REPO

**⚠️ This task is in `/opt/projects/transcript-bot`, a different git repo with its own remote and its own `main` branch. `cd` there first. Do not commit any of it to the app repo.**

**Files:**
- Create: `/opt/projects/transcript-bot/src/thread-notes.ts`
- Create: `/opt/projects/transcript-bot/src/thread-notes.test.ts`
- Modify: `/opt/projects/transcript-bot/scripts/discord-bot.ts` (intents at `:683`, handler after the `pdc-note` block ending at `:891`)
- Modify: `/opt/projects/transcript-bot/scripts/discord-register.ts`
- Modify: `/opt/projects/transcript-bot/package.json`

**Interfaces:**
- Consumes from Task 2: `GET /api/episode-notes/open` and `POST /api/episode-notes/sync` (shapes above).
- Produces: the `/pdc-sync-notes` slash command. Nothing downstream consumes it.

**Design decisions this task locks in** (the spec leaves them open; these are the resolutions):

1. **Which thread.** If the command is invoked *inside a thread*, that thread is the one synced. Otherwise the bot reads `GET /api/episode-notes/open` and uses that pointer's `threadId`. This is what makes an older episode reachable: go to its thread and run the command there.
2. **Which episode.** The `ep:` option always wins. Otherwise: the open pointer's episode if the thread being synced *is* the open thread; else parse `Ep <n>` from the thread name. If neither resolves, the command errors and asks for `ep:` rather than guessing — a wrong episode writes to the wrong sheet row.
3. **Existing intents.** The bot runs on `[GatewayIntentBits.Guilds]` today. `MessageContent` is added. Do not add `GuildMessages` or `GuildMessageReactions` — the messages are *fetched* over REST, not received over the gateway, and reaction users come from `reaction.users.fetch()`.
4. **`MessageContent` requires a Developer Portal toggle** (Bot → Privileged Gateway Intents → Message Content Intent). Without it the bot will fail to log in with a `disallowed intents` error. This is a human step, listed at the end of the plan.

- [ ] **Step 1: Write the failing tests**

Create `/opt/projects/transcript-bot/src/thread-notes.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_EMOJI,
  episodeFromThreadName,
  selectApprovedComments,
  formatSyncReply,
  type ThreadMessage,
} from './thread-notes.ts';

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    authorTag: 'jason#0',
    authorIsBot: false,
    content: 'A moment worth recording',
    approvedByAdmin: true,
    ...over,
  };
}

test('APPROVAL_EMOJI is exactly the check mark and thumbs up', () => {
  assert.deepEqual(APPROVAL_EMOJI, ['✅', '👍']);
});

test('selectApprovedComments keeps an admin-reacted human comment', () => {
  assert.deepEqual(selectApprovedComments([msg()], 'starter'), [
    { discordMessageId: 'm1', text: 'A moment worth recording', submittedBy: 'jason#0' },
  ]);
});

test('selectApprovedComments drops comments with no admin reaction', () => {
  assert.deepEqual(selectApprovedComments([msg({ approvedByAdmin: false })], 'starter'), []);
});

test('selectApprovedComments drops bot messages', () => {
  assert.deepEqual(selectApprovedComments([msg({ authorIsBot: true })], 'starter'), []);
});

test('selectApprovedComments drops the thread starter message', () => {
  // In Discord a thread's id equals its starter message's id.
  assert.deepEqual(selectApprovedComments([msg({ id: 'starter' })], 'starter'), []);
});

test('selectApprovedComments drops empty comments', () => {
  assert.deepEqual(selectApprovedComments([msg({ content: '   ' })], 'starter'), []);
});

test('selectApprovedComments preserves order and handles a mixed thread', () => {
  const picked = selectApprovedComments(
    [
      msg({ id: 'starter', content: 'announcement' }),
      msg({ id: 'a', content: 'first moment here' }),
      msg({ id: 'b', content: 'unreacted', approvedByAdmin: false }),
      msg({ id: 'c', content: 'second moment here' }),
      msg({ id: 'd', content: 'bot chatter', authorIsBot: true }),
    ],
    'starter'
  );
  assert.deepEqual(picked.map(p => p.discordMessageId), ['a', 'c']);
});

test('episodeFromThreadName reads the episode out of the thread title', () => {
  assert.equal(episodeFromThreadName('Ep 317 · Barton Fink (1991)'), '317');
  assert.equal(episodeFromThreadName('Episode 317'), '317');
});

test('episodeFromThreadName returns null when there is no episode to read', () => {
  assert.equal(episodeFromThreadName('General chat'), null);
  assert.equal(episodeFromThreadName(''), null);
});

test('formatSyncReply reports considered, appended, and skipped counts', () => {
  const reply = formatSyncReply('317', {
    considered: 5,
    appended: 3,
    duplicate: 1,
    alreadySynced: 1,
    failed: 0,
  }, false);
  assert.match(reply, /317/);
  assert.match(reply, /5/);
  assert.match(reply, /3/);
});

test('formatSyncReply flags failures rather than reading as a clean success', () => {
  const reply = formatSyncReply('317', {
    considered: 2,
    appended: 1,
    duplicate: 0,
    alreadySynced: 0,
    failed: 1,
  }, false);
  assert.match(reply, /fail/i);
});

test('formatSyncReply says so when the thread was archived', () => {
  // Otherwise an archived thread with no new reactions looks identical to a
  // live thread nobody reacted in.
  const reply = formatSyncReply('317', {
    considered: 0,
    appended: 0,
    duplicate: 0,
    alreadySynced: 0,
    failed: 0,
  }, true);
  assert.match(reply, /archiv/i);
});
```

- [ ] **Step 2: Add a test script and run to verify failure**

In `/opt/projects/transcript-bot/package.json`, add to `scripts`:

```json
"test": "node --import tsx --test src/*.test.ts"
```

This repo has a `src/github-dispatch.test.ts` that nothing has ever run — the glob picks it up too, which is intentional.

Run: `cd /opt/projects/transcript-bot && npm test`
Expected: FAIL — `Cannot find module './thread-notes.ts'`. (`github-dispatch.test.ts` should pass; if it does not, note it and continue — it is pre-existing.)

- [ ] **Step 3: Write `src/thread-notes.ts`**

```typescript
/**
 * Pure helpers for /pdc-sync-notes.
 *
 * Deliberately free of discord.js imports: the command handler flattens
 * discord.js objects into ThreadMessage records, and everything decision-shaped
 * happens here where it can be tested without a gateway connection.
 */

/** An admin adds one of these to a comment to approve it. Nothing else counts. */
export const APPROVAL_EMOJI = ['✅', '👍'] as const;

export interface ThreadMessage {
  id: string;
  authorTag: string;
  authorIsBot: boolean;
  content: string;
  /** True when ✅ or 👍 was added by a user holding the admin role. */
  approvedByAdmin: boolean;
}

export interface SyncComment {
  discordMessageId: string;
  text: string;
  submittedBy: string;
}

export interface SyncSummary {
  considered: number;
  appended: number;
  duplicate: number;
  alreadySynced: number;
  failed: number;
}

/**
 * Keep only human comments an admin reacted to.
 *
 * `starterMessageId` is the thread's own id — in Discord a thread and its
 * starter message share one id — so the announcement itself is never collected.
 */
export function selectApprovedComments(
  messages: ThreadMessage[],
  starterMessageId: string
): SyncComment[] {
  const picked: SyncComment[] = [];
  for (const m of messages) {
    if (m.id === starterMessageId) continue;
    if (m.authorIsBot) continue;
    if (!m.approvedByAdmin) continue;
    const text = m.content.trim();
    if (text === '') continue;
    picked.push({ discordMessageId: m.id, text, submittedBy: m.authorTag });
  }
  return picked;
}

/**
 * Read the episode number out of a thread name written by threadNameFor()
 * in the app repo — "Ep 317 · Film" or "Episode 317". Returns null rather than
 * guessing: writing a note to the wrong sheet row is worse than asking for ep:.
 */
export function episodeFromThreadName(name: string): string | null {
  const m = /^Ep(?:isode)?\s+(\d+)/i.exec(String(name ?? '').trim());
  return m ? m[1] : null;
}

export function formatSyncReply(
  episode: string,
  summary: SyncSummary,
  archived: boolean
): string {
  const lines = [
    `**Episode ${episode}** — considered ${summary.considered} reacted comment${summary.considered === 1 ? '' : 's'}.`,
    `• Appended: ${summary.appended}`,
    `• Already in the sheet: ${summary.duplicate}`,
    `• Already synced earlier: ${summary.alreadySynced}`,
  ];
  if (summary.failed > 0) {
    lines.push(`• ⚠️ Failed: ${summary.failed} — these stay unsynced; run the command again to retry.`);
  }
  if (archived) {
    lines.push('_This thread is archived. Any new reaction needs the thread unarchived first._');
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /opt/projects/transcript-bot && npm test`
Expected: PASS — 13 tests from `thread-notes.test.ts`.

- [ ] **Step 5: Commit the pure layer**

```bash
cd /opt/projects/transcript-bot
git add src/thread-notes.ts src/thread-notes.test.ts package.json
git commit -m "feat(notes): pure helpers for collecting admin-reacted thread comments"
```

- [ ] **Step 6: Add the intent**

In `scripts/discord-bot.ts`, change the client intents (line ~683):

```typescript
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent],
```

`MessageContent` is privileged. It must also be toggled on in the Discord Developer Portal (Bot → Privileged Gateway Intents → Message Content Intent) or the bot will refuse to log in with a `disallowed intents` error at startup.

- [ ] **Step 7: Add the fetch/POST helpers**

In `scripts/discord-bot.ts`, add near `submitNote` (around line 396):

```typescript
interface OpenEpisodeResponse {
  open?: { episode: string; film: string; threadId: string | null } | null;
  error?: string;
}

interface SyncResponse {
  ok?: boolean;
  summary?: SyncSummary;
  error?: string;
}

async function fetchOpenEpisode(): Promise<OpenEpisodeResponse> {
  const key = process.env.EH_BOT_KEY;
  if (!key) return { error: 'EH_BOT_KEY is not configured on the bot.' };

  const res = await fetch(`${baseUrl}/api/episode-notes/open`, {
    headers: { 'x-eh-key': key },
  });
  const data = (await res.json().catch(() => ({}))) as OpenEpisodeResponse;
  if (!res.ok) return { error: data.error ?? `Request failed (${res.status})` };
  return data;
}

async function syncNotes(episode: string, comments: SyncComment[]): Promise<SyncResponse> {
  const key = process.env.EH_BOT_KEY;
  if (!key) return { error: 'EH_BOT_KEY is not configured on the bot.' };

  const res = await fetch(`${baseUrl}/api/episode-notes/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-eh-key': key },
    body: JSON.stringify({ episode, comments }),
  });
  const data = (await res.json().catch(() => ({}))) as SyncResponse;
  if (!res.ok) return { error: data.error ?? `Request failed (${res.status})` };
  return data;
}
```

And add to the imports at the top of the file:

```typescript
import {
  APPROVAL_EMOJI,
  episodeFromThreadName,
  selectApprovedComments,
  formatSyncReply,
  type SyncComment,
  type SyncSummary,
  type ThreadMessage,
} from '../src/thread-notes.js';
```

Note the `.js` extension on the import — this repo is `"type": "module"` and existing imports (`../src/share-summary.js`) follow that convention.

Also add `ThreadChannel` to the `discord.js` import list at the top of the file.

- [ ] **Step 8: Add the command handler**

In `scripts/discord-bot.ts`, immediately after the `pdc-note` block (which ends at line ~891 with its `return;`), add:

```typescript
      if (interaction.commandName === 'pdc-sync-notes') {
        if (!interaction.inCachedGuild()) {
          await interaction.reply({
            content: 'This command can only be used inside a server.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Same role gate as /pdc-check-episodes. A reaction is the approval,
        // so whoever runs the sync must be able to approve too.
        const hasRole = interaction.member.roles.cache.some(
          (r) => r.name.toLowerCase() === episodeTriggerRole.toLowerCase(),
        );
        if (!hasRole) {
          await interaction.reply({
            content: `You need the **${episodeTriggerRole}** role to run this.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const epOption = interaction.options.getString('ep');
        await interaction.deferReply();

        try {
          // Which thread: the one this command was run in, else the open one.
          let thread: ThreadChannel | null = interaction.channel?.isThread()
            ? (interaction.channel as ThreadChannel)
            : null;
          let openEpisode: string | null = null;
          let openThreadId: string | null = null;

          const open = await fetchOpenEpisode();
          if (open.error) {
            await interaction.editReply(`Could not read the open episode: ${open.error}`);
            return;
          }
          openEpisode = open.open?.episode ?? null;
          openThreadId = open.open?.threadId ?? null;

          if (!thread) {
            if (!openThreadId) {
              await interaction.editReply(
                'No thread to sync. Run this inside an episode thread, or open an episode first.'
              );
              return;
            }
            const fetched = await interaction.client.channels.fetch(openThreadId);
            if (!fetched || !fetched.isThread()) {
              await interaction.editReply(
                `Could not open thread ${openThreadId}. Run this command inside the thread instead.`
              );
              return;
            }
            thread = fetched as ThreadChannel;
          }

          // Which episode: ep: wins, then the pointer if this IS the open
          // thread, then the thread name. Never guess — a wrong episode writes
          // to the wrong sheet row.
          const episode =
            epOption?.trim() ||
            (thread.id === openThreadId ? openEpisode : null) ||
            episodeFromThreadName(thread.name);
          if (!episode) {
            await interaction.editReply(
              'Could not work out which episode this thread is for. Re-run with `ep:` set.'
            );
            return;
          }

          const archived = thread.archived === true;
          const fetchedMessages = await thread.messages.fetch({ limit: 100 });

          const flattened: ThreadMessage[] = [];
          for (const m of fetchedMessages.values()) {
            let approvedByAdmin = false;
            for (const emoji of APPROVAL_EMOJI) {
              const reaction = m.reactions.cache.find((r) => r.emoji.name === emoji);
              if (!reaction) continue;
              // Reaction users are not cached; this is a REST call, not a
              // gateway subscription.
              const users = await reaction.users.fetch();
              for (const u of users.values()) {
                const member = await thread.guild.members.fetch(u.id).catch(() => null);
                if (
                  member?.roles.cache.some(
                    (r) => r.name.toLowerCase() === episodeTriggerRole.toLowerCase(),
                  )
                ) {
                  approvedByAdmin = true;
                  break;
                }
              }
              if (approvedByAdmin) break;
            }
            flattened.push({
              id: m.id,
              authorTag: m.author.tag,
              authorIsBot: m.author.bot,
              content: m.content,
              approvedByAdmin,
            });
          }

          // fetch() returns newest-first; read the thread in the order it was written.
          flattened.reverse();

          const comments = selectApprovedComments(flattened, thread.id);
          if (comments.length === 0) {
            await interaction.editReply(
              formatSyncReply(
                episode,
                { considered: 0, appended: 0, duplicate: 0, alreadySynced: 0, failed: 0 },
                archived,
              ),
            );
            return;
          }

          const result = await syncNotes(episode, comments);
          if (result.error || !result.summary) {
            await interaction.editReply(
              `Sync failed: ${result.error ?? 'the app returned no summary'}. Nothing was appended — run it again to retry.`,
            );
            return;
          }

          await interaction.editReply(formatSyncReply(episode, result.summary, archived));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          await interaction.editReply(`Sync failed: ${msg}`);
        }
        return;
      }
```

The `limit: 100` on `messages.fetch` is Discord's per-call maximum. A thread with more than 100 messages will only have its most recent 100 considered — acceptable at the expected volume, and `MAX_COMMENTS = 50` in the app caps the batch anyway. Do not add pagination.

- [ ] **Step 9: Register the command**

In `scripts/discord-register.ts`, add after `noteCommand` (line ~97):

```typescript
const syncNotesCommand = new SlashCommandBuilder()
  .setName('pdc-sync-notes')
  .setDescription('Append this thread\'s ✅-reacted comments to Notable Moments')
  .addStringOption((option) =>
    option
      .setName('ep')
      .setDescription('Episode number (defaults to the thread\'s episode)')
      .setRequired(false)
  );
```

And add `syncNotesCommand.toJSON(),` to the `commands` array (line ~110). Forgetting this array entry is the orphan failure for this task: the handler would exist and never fire.

- [ ] **Step 10: Verify**

Run: `cd /opt/projects/transcript-bot && npm test && npx tsc --noEmit`
Expected: tests PASS. `tsc` will report the **2 pre-existing errors** at `scripts/discord-register.ts:118,123` — those are not yours. Any *other* error is yours and must be fixed.

- [ ] **Step 11: Commit**

```bash
cd /opt/projects/transcript-bot
git add scripts/discord-bot.ts scripts/discord-register.ts
git commit -m "feat(notes): /pdc-sync-notes collects admin-reacted thread comments"
```

---

### Task 5: Show the note source in the review tab

The review tab stays as an audit view. It should distinguish a thread-sourced note from a `/pdc-note` submission.

**Files:**
- Modify: `src/app/review/submissions/page.tsx`

**Interfaces:**
- Consumes from Task 1: `EpisodeNote.source` (`'command' | 'thread' | undefined`).
- Produces: nothing.

**Note:** the notes tab lists `status=pending` only, and thread-sourced notes are stored as `approved` — so they will *not* appear under the default filter. That is correct: the tab's job is the approval queue. The `source` badge exists so that when the tab is pointed at `status=all` (or a thread note somehow lands pending), its origin is legible. Do not change the default filter.

- [ ] **Step 1: Add `source` to the view type**

In `src/app/review/submissions/page.tsx`, replace the `EpisodeNoteView` interface (around line 24):

```typescript
interface EpisodeNoteView {
  id: string;
  episode: string;
  note: string;
  submittedBy: string;
  createdAt: string;
  /** Absent on notes stored before this field existed; render as /pdc-note. */
  source?: 'command' | 'thread';
}
```

- [ ] **Step 2: Render the badge**

In the same file, in the `notes.map((n) => ...)` block, replace the metadata line:

```tsx
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                    Ep {n.episode} · {n.submittedBy} · {new Date(n.createdAt).toLocaleString()}
                  </div>
```

with:

```tsx
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                    Ep {n.episode} · {n.submittedBy} · {new Date(n.createdAt).toLocaleString()}
                    <span
                      style={{
                        marginLeft: 8,
                        padding: '1px 6px',
                        borderRadius: 4,
                        fontSize: 11,
                        background: n.source === 'thread' ? '#e8f0fe' : '#f1f1f1',
                        color: '#444',
                      }}
                    >
                      {n.source === 'thread' ? 'thread' : '/pdc-note'}
                    </span>
                  </div>
```

This keeps the file's inline-style convention — do not introduce CSS classes here.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: no errors.

Then start the dev server and load the page:

Run: `npm run dev` and open `http://localhost:3000/review/submissions`, enter the review password, click the Notable Moments tab.
Expected: the tab loads without error. If there are no pending notes it reads "No notes awaiting review" — that is the correct empty state, not a failure.

- [ ] **Step 4: Commit**

```bash
git add src/app/review/submissions/page.tsx
git commit -m "feat(notes): show whether a note came from the thread or /pdc-note"
```

---

## Final verification

After all five tasks:

- [ ] `cd /opt/projects/transcript-app && npm run test:notes && npm run test:notify && npm run test:pdc && npx tsc --noEmit` — all green.
- [ ] `cd /opt/projects/transcript-bot && npm test && npx tsc --noEmit` — tests green, only the 2 known `discord-register.ts` errors.
- [ ] `git status` in the app repo shows `src/lib/agent-search.ts` still modified and uncommitted. If it got committed, that is a mistake to undo.
- [ ] Orphan sweep — confirm each of these has a caller: `announceWithThread` ← `notify-discord.ts`; `syncComments` ← the sync route; the sync route ← the bot's `syncNotes`; `/pdc-sync-notes` ← the `commands` array in `discord-register.ts`; every new `.test.ts` ← a `package.json` script.
- [ ] Push: `git push origin master` (app) and `git push origin main` (bot).

## Human deployment steps (blocking — the feature is inert without these)

1. **Discord Developer Portal:** enable Bot → Privileged Gateway Intents → **Message Content Intent**. Without it the bot will not start.
2. **App repo secrets** (GitHub → Settings → Secrets → Actions): add `DISCORD_BOT_TOKEN` (the same token the bot uses) and `DISCORD_ENGINEERS_CHANNEL_ID` (right-click #engineers → Copy Channel ID, with Developer Mode on).
3. **Bot permissions:** the bot must be able to *Send Messages*, *Create Public Threads*, *Read Message History*, and *View Channel* in `#engineers`.
4. **Register the command:** `cd /opt/projects/transcript-bot && npm run register`.
5. **Restart the bot on Railway** so the new intent and handler take effect.
6. **End-to-end walkthrough** (the only evidence this works — Tasks 3 and 4 have no automated coverage of the live path):
   - Run the ingest workflow for a test episode, or invoke `notify-discord.ts --event=notes-open --episode=<n>` manually with the secrets set.
   - Confirm the announcement appears in #engineers **with a thread on it**.
   - Post two comments in the thread. React ✅ to one only.
   - Run `/pdc-sync-notes` in the thread. Expect "considered 1, appended 1".
   - Check the sheet: exactly one new `- ` bullet in `Notable_Moments` for that episode.
   - Run `/pdc-sync-notes` again. Expect "already synced earlier: 1, appended 0" and **no second bullet**.

## Deferred (not in scope)

- Pagination past 100 thread messages.
- A CI workflow running the six manual test suites — still the cheapest insurance against the orphan class this project keeps hitting.
- Removing `DISCORD_ENGINEERS_WEBHOOK_URL` once the bot path is proven in production.
- Fixing the 2 pre-existing tsc errors in the bot repo.
