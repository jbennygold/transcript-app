# PDC Engineers Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual `Notable_Moments` entry with a collection flow: the bot announces a new episode in `#engineers`, contributors submit notes with `/pdc-note`, an admin approves them in `/review/submissions`, and approved notes append to the sheet.

**Architecture:** Notes are stored in Vercel Blob with the same submit-then-approve lifecycle as the existing transcription reports. The Discord bot stays on its current minimal `Guilds` intent by using a slash command rather than reading thread replies or reactions. A single "notes open" pointer in Blob lets `/pdc-note` attach to the current episode without the contributor naming it. Approval appends a `- ` bullet to `Notable_Moments`, matching the format already in the sheet.

**Tech Stack:** TypeScript (strict, ES modules), Next.js App Router, `@vercel/blob`, `googleapis` Sheets v4, discord.js v14 (separate `transcript-bot` repo, deployed on Railway), `node:test` + `node:assert/strict` via `node --import tsx --test`.

## Global Constraints

- **The bot keeps `intents: [GatewayIntentBits.Guilds]`.** Reading thread replies or reactions would require `GuildMessages`, `GuildMessageReactions`, and the privileged `MessageContent` intent, plus reaction polling to survive Railway restarts. A slash command needs none of that and gives an audit trail, an edit path, and reject-with-reason.
- **`Notable_Moments` is newline-delimited `- ` bullets** in existing rows. Appended notes must match that format so `searchNotableMoments()` tokenisation keeps working.
- Appending is a read-modify-write on one cell. It must **never create a row** — if the episode has no sheet row, the append is refused, not inserted.
- `/pdc-note` is open to any member of `#engineers`. Collection is meant to be low-friction; the approval step is the gate. This differs deliberately from `/pdc-check-episodes`, which is role-gated because it triggers billable work.
- `#engineers` needs its **own webhook**. `DISCORD_PDC_WEBHOOK_URL` is channel-scoped to `#pod-data-central` and cannot post elsewhere.
- Bot → app calls authenticate with the `x-eh-key` header via `validateExternalKey`, matching `src/app/api/external/transcription-error/route.ts`. Do not invent a new auth scheme.
- Tests are pure-function only. No network, no Blob, no Google API, no credentialed fixtures.
- Test files import source **without** a `.ts` extension in `src/`; files under `scripts/` follow the existing `scripts/notify-discord.test.ts` convention (which uses `.ts` and works because `tsconfig.json` excludes `scripts`).
- `npm run lint` is non-functional in this repo (Next 16 removed `next lint`). Use `npx tsc --noEmit`.
- Task 5 is in a **different git repository** (`/opt/projects/transcript-bot`, deployed on Railway). Commit there separately.

## Out of scope

- Plan B — Tier 2 staged extraction. The two plans touch different columns and can land in either order.
- Migrating historical `Notable_Moments` content. Existing cells are left exactly as they are; notes only append.

---

### Task 1: Append to a single cell

**Files:**
- Modify: `src/lib/pdc-sheet.ts`
- Modify: `src/lib/pdc-sheet.test.ts`

**Interfaces:**
- Consumes: `mapHeaders`, `findRowIndexByEpisode`, `PdcColumnKey`, `PdcSheetValidationError` from `src/lib/pdc-sheet.ts`.
- Produces:
  - `appendBullet(existing: string, line: string): string | null` — pure; `null` means the line is already present
  - `appendToCell(episode: string, column: PdcColumnKey, line: string): Promise<'appended' | 'duplicate' | 'no_row'>`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/pdc-sheet.test.ts`:

```typescript
import { appendBullet } from './pdc-sheet';

test('appendBullet adds a bullet to an empty cell without a leading newline', () => {
  assert.equal(appendBullet('', 'Roy Scheider tangent'), '- Roy Scheider tangent');
});

test('appendBullet appends to existing bullets on a new line', () => {
  assert.equal(
    appendBullet('- First moment', 'Second moment'),
    '- First moment\n- Second moment'
  );
});

test('appendBullet preserves existing content that is not bulleted', () => {
  // Older rows are free prose; we append rather than reformat what is there.
  assert.equal(
    appendBullet('Summer of Jason continues', 'New note'),
    'Summer of Jason continues\n- New note'
  );
});

test('appendBullet trims the incoming line and strips a leading dash', () => {
  assert.equal(appendBullet('', '  - Already bulleted  '), '- Already bulleted');
});

test('appendBullet returns null when the line is already present', () => {
  assert.equal(appendBullet('- First moment', 'First moment'), null);
});

test('appendBullet duplicate detection ignores case and surrounding space', () => {
  assert.equal(appendBullet('- First Moment', '  first moment '), null);
});

test('appendBullet returns null for an empty line rather than adding a bare dash', () => {
  assert.equal(appendBullet('- First', '   '), null);
});

test('appendBullet does not treat a longer line containing an existing one as duplicate', () => {
  assert.equal(
    appendBullet('- Roy', 'Roy Scheider tangent'),
    '- Roy\n- Roy Scheider tangent'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:pdc`
Expected: FAIL — `appendBullet is not a function` / import error

- [ ] **Step 3: Write the implementation**

Add to `src/lib/pdc-sheet.ts`, after `buildNewRow`:

```typescript
/**
 * Append one bullet to a Notable_Moments-style cell.
 *
 * Existing rows are newline-delimited "- " bullets, so appended notes match
 * that shape and searchNotableMoments() tokenisation keeps working. Older rows
 * are free prose; we append to them rather than reformatting what is there.
 *
 * Returns null when the line is blank or already present — the caller treats
 * that as a no-op, not an error.
 */
export function appendBullet(existing: string, line: string): string | null {
  const clean = String(line ?? '').trim().replace(/^-\s*/, '').trim();
  if (clean === '') return null;

  const current = String(existing ?? '');
  const already = current
    .split('\n')
    .map(l => l.replace(/^-\s*/, '').trim().toLowerCase())
    .some(l => l !== '' && l === clean.toLowerCase());
  if (already) return null;

  return current.trim() === '' ? `- ${clean}` : `${current.replace(/\s+$/, '')}\n- ${clean}`;
}
```

Then add the I/O wrapper, after `upsertEpisodeRow`:

```typescript
/**
 * Append a bullet to one cell of an existing row.
 *
 * Never creates a row: an episode with no sheet row returns 'no_row'. This is
 * a read-modify-write of a single cell, so it writes only that cell rather than
 * the whole row.
 */
export async function appendToCell(
  episode: string,
  column: PdcColumnKey,
  line: string
): Promise<'appended' | 'duplicate' | 'no_row'> {
  const auth = getSheetsAuth();
  if (!auth) throw new PdcSheetValidationError('Google Sheets credentials not configured');

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'`,
  });

  const rows = (res.data.values as string[][] | undefined) ?? [];
  if (rows.length === 0) throw new PdcSheetValidationError('Sheet is empty or not found');

  const headerMap = mapHeaders(rows[0].map(h => String(h).trim()));
  const epColIdx = headerMap.get('Ep');
  if (epColIdx === undefined) throw new PdcSheetValidationError('Could not find Ep column in sheet');

  const colIdx = headerMap.get(column);
  if (colIdx === undefined) throw new PdcSheetValidationError(`Could not find ${column} column in sheet`);

  const rowIdx = findRowIndexByEpisode(rows, epColIdx, episode);
  if (rowIdx === -1) return 'no_row';

  const next = appendBullet(String(rows[rowIdx][colIdx] ?? ''), line);
  if (next === null) return 'duplicate';

  // Column index to A1 letter. The sheet has 24 columns, so one letter suffices,
  // but handle two just in case a column is added later.
  const a1 =
    colIdx < 26
      ? String.fromCharCode(65 + colIdx)
      : String.fromCharCode(64 + Math.floor(colIdx / 26)) + String.fromCharCode(65 + (colIdx % 26));

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'!${a1}${rowIdx + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[next]] },
  });

  return 'appended';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:pdc`
Expected: PASS — 8 new tests on top of the existing suite, 0 failing

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` — Expected: no errors

```bash
git add src/lib/pdc-sheet.ts src/lib/pdc-sheet.test.ts
git commit -m "feat(notes): append a bullet to a single sheet cell"
```

---

### Task 2: Notes store

**Files:**
- Create: `src/lib/episode-notes.ts`
- Create: `src/lib/episode-notes.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type NoteStatus = 'pending' | 'approved' | 'rejected'`
  - `interface EpisodeNote { id: string; episode: string; note: string; submittedBy: string; createdAt: string; status: NoteStatus; resolvedAt?: string }`
  - `interface OpenEpisode { episode: string; film: string; openedAt: string }`
  - `newNoteId(now: number, rand: string): string`
  - `validateNoteInput(input: unknown): { ok: true; value: { episode: string; note: string; submittedBy: string } } | { ok: false; reason: string }`
  - `buildNote(value: { episode: string; note: string; submittedBy: string }, id: string, createdAt: string): EpisodeNote`
  - `saveNote(note: EpisodeNote): Promise<void>`
  - `listNotes(status?: NoteStatus | 'all'): Promise<EpisodeNote[]>`
  - `loadNote(id: string): Promise<EpisodeNote | null>`
  - `setOpenEpisode(open: OpenEpisode): Promise<void>`
  - `getOpenEpisode(): Promise<OpenEpisode | null>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/episode-notes.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNoteId, validateNoteInput, buildNote } from './episode-notes';

test('newNoteId is stable for the same inputs and sortable by time', () => {
  const a = newNoteId(1000, 'abc');
  const b = newNoteId(2000, 'abc');
  assert.equal(a, newNoteId(1000, 'abc'));
  assert.ok(a < b, 'later timestamps must sort after earlier ones');
});

test('validateNoteInput accepts a well-formed note', () => {
  const r = validateNoteInput({ episode: '317', note: 'Roy Scheider tangent', submittedBy: 'matt' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.episode, '317');
});

test('validateNoteInput trims the note and the submitter', () => {
  const r = validateNoteInput({ episode: ' 317 ', note: '  a real note  ', submittedBy: ' matt ' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.episode, '317');
    assert.equal(r.value.note, 'a real note');
    assert.equal(r.value.submittedBy, 'matt');
  }
});

test('validateNoteInput rejects a missing episode', () => {
  const r = validateNoteInput({ note: 'x'.repeat(20), submittedBy: 'matt' });
  assert.equal(r.ok, false);
});

test('validateNoteInput rejects a note that is too short to be useful', () => {
  const r = validateNoteInput({ episode: '317', note: 'ok', submittedBy: 'matt' });
  assert.equal(r.ok, false);
});

test('validateNoteInput rejects a note longer than the cell should carry', () => {
  const r = validateNoteInput({ episode: '317', note: 'x'.repeat(1001), submittedBy: 'matt' });
  assert.equal(r.ok, false);
});

test('validateNoteInput rejects a missing submitter so every note is attributable', () => {
  const r = validateNoteInput({ episode: '317', note: 'a real note here' });
  assert.equal(r.ok, false);
});

test('validateNoteInput rejects a non-object', () => {
  assert.equal(validateNoteInput(null).ok, false);
  assert.equal(validateNoteInput('note').ok, false);
});

test('validateNoteInput strips newlines so one note stays one bullet', () => {
  const r = validateNoteInput({ episode: '317', note: 'line one\nline two', submittedBy: 'matt' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.note, 'line one line two');
});

test('buildNote stamps status pending and carries the id and timestamp', () => {
  const n = buildNote(
    { episode: '317', note: 'a real note here', submittedBy: 'matt' },
    'note_1_abc',
    '2026-08-03T00:00:00.000Z'
  );
  assert.equal(n.status, 'pending');
  assert.equal(n.id, 'note_1_abc');
  assert.equal(n.createdAt, '2026-08-03T00:00:00.000Z');
  assert.equal(n.resolvedAt, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/episode-notes.test.ts`
Expected: FAIL — `Cannot find module './episode-notes'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/episode-notes.ts`:

```typescript
/**
 * Engineers Notes store.
 *
 * Contributors submit notes with /pdc-note in #engineers; an admin approves
 * them in /review/submissions; approval appends a bullet to Notable_Moments.
 * Mirrors the lifecycle of src/lib/transcription-report.ts.
 */
import { put, list } from '@vercel/blob';

const PREFIX = 'episode-notes/';
const OPEN_KEY = `${PREFIX}open.json`;

/** A note becomes one bullet, so it must fit on one line and in one cell. */
const MIN_NOTE_LENGTH = 5;
const MAX_NOTE_LENGTH = 1000;

export type NoteStatus = 'pending' | 'approved' | 'rejected';

export interface EpisodeNote {
  id: string;
  episode: string;
  note: string;
  /** Discord tag of the submitter, so every note is attributable. */
  submittedBy: string;
  createdAt: string;
  status: NoteStatus;
  resolvedAt?: string;
}

export interface OpenEpisode {
  episode: string;
  film: string;
  openedAt: string;
}

export function newNoteId(now: number, rand: string): string {
  return `note_${String(now).padStart(15, '0')}_${rand}`;
}

export function validateNoteInput(
  input: unknown
):
  | { ok: true; value: { episode: string; note: string; submittedBy: string } }
  | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'body must be an object' };
  }
  const o = input as Record<string, unknown>;

  const episode = String(o.episode ?? '').trim();
  if (episode === '') return { ok: false, reason: 'episode is required' };

  const submittedBy = String(o.submittedBy ?? '').trim();
  if (submittedBy === '') return { ok: false, reason: 'submittedBy is required' };

  // One note is one bullet, so collapse any newlines the client sent.
  const note = String(o.note ?? '').replace(/\s*\n+\s*/g, ' ').trim();
  if (note.length < MIN_NOTE_LENGTH) {
    return { ok: false, reason: `note must be at least ${MIN_NOTE_LENGTH} characters` };
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return { ok: false, reason: `note must be at most ${MAX_NOTE_LENGTH} characters` };
  }

  return { ok: true, value: { episode, note, submittedBy } };
}

export function buildNote(
  value: { episode: string; note: string; submittedBy: string },
  id: string,
  createdAt: string
): EpisodeNote {
  return { id, ...value, createdAt, status: 'pending' };
}

// ── Blob I/O ──

export async function saveNote(note: EpisodeNote): Promise<void> {
  await put(`${PREFIX}${note.id}.json`, JSON.stringify(note, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function listNotes(status: NoteStatus | 'all' = 'all'): Promise<EpisodeNote[]> {
  const { blobs } = await list({ prefix: PREFIX });
  const notes: EpisodeNote[] = [];
  for (const blob of blobs) {
    if (!blob.pathname.endsWith('.json')) continue;
    if (blob.pathname === OPEN_KEY) continue;
    try {
      const resp = await fetch(blob.url, { cache: 'no-store' });
      if (resp.ok) notes.push((await resp.json()) as EpisodeNote);
    } catch {
      // skip corrupt entries
    }
  }
  const filtered = status === 'all' ? notes : notes.filter(n => n.status === status);
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadNote(id: string): Promise<EpisodeNote | null> {
  const key = `${PREFIX}${id}.json`;
  const { blobs } = await list({ prefix: key });
  const match = blobs.find(b => b.pathname === key);
  if (!match) return null;
  try {
    const resp = await fetch(match.url, { cache: 'no-store' });
    if (!resp.ok) return null;
    return (await resp.json()) as EpisodeNote;
  } catch {
    return null;
  }
}

/** One episode is open for notes at a time; a new one replaces the previous. */
export async function setOpenEpisode(open: OpenEpisode): Promise<void> {
  await put(OPEN_KEY, JSON.stringify(open, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function getOpenEpisode(): Promise<OpenEpisode | null> {
  const { blobs } = await list({ prefix: OPEN_KEY });
  const match = blobs.find(b => b.pathname === OPEN_KEY);
  if (!match) return null;
  try {
    const resp = await fetch(match.url, { cache: 'no-store' });
    if (!resp.ok) return null;
    return (await resp.json()) as OpenEpisode;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/episode-notes.test.ts`
Expected: PASS — 10 tests passing

- [ ] **Step 5: Add the test script, verify, commit**

In `package.json`, add to `"scripts"`:

```json
"test:notes": "node --import tsx --test src/lib/episode-notes.test.ts",
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:notes` — Expected: 10 tests passing

```bash
git add src/lib/episode-notes.ts src/lib/episode-notes.test.ts package.json
git commit -m "feat(notes): add episode notes store"
```

---

### Task 3: Notes API

**Files:**
- Create: `src/app/api/episode-notes/route.ts`
- Create: `src/app/api/episode-notes/resolve/route.ts`

**Interfaces:**
- Consumes: `validateNoteInput`, `buildNote`, `newNoteId`, `saveNote`, `listNotes`, `loadNote`, `getOpenEpisode`, `EpisodeNote`, `NoteStatus` (Task 2); `appendToCell` (Task 1); `validateExternalKey` from `src/lib/external-auth`; `checkRateLimit` from `src/lib/external-rate-limit`; `checkAuth` from `src/lib/podreview-auth`.
- Produces:
  - `POST /api/episode-notes` — `x-eh-key` auth, body `{ note, submittedBy, episode? }`, returns `{ ok: true, id, episode }`
  - `GET /api/episode-notes?status=pending` — `Bearer` auth, returns `{ notes: EpisodeNote[] }`
  - `POST /api/episode-notes/resolve` — `Bearer` auth, body `{ decisions: Array<{ id, status, note? }> }`, returns `{ ok: true, results }`

- [ ] **Step 1: Write the submit and list route**

Create `src/app/api/episode-notes/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { validateExternalKey } from '@/lib/external-auth';
import { checkRateLimit } from '@/lib/external-rate-limit';
import { checkAuth } from '@/lib/podreview-auth';
import {
  validateNoteInput,
  buildNote,
  newNoteId,
  saveNote,
  listNotes,
  getOpenEpisode,
  type NoteStatus,
} from '@/lib/episode-notes';

const STATUSES: Array<NoteStatus | 'all'> = ['pending', 'approved', 'rejected', 'all'];

/**
 * Submit a note. Called by the Discord bot's /pdc-note command, so it uses the
 * same x-eh-key auth as the other external endpoints.
 *
 * `episode` is optional: when omitted the note attaches to the currently open
 * episode, which is what makes /pdc-note a one-argument command.
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
  if (!rl.ok) {
    const headers: Record<string, string> = {};
    if (rl.retryAfterSec) headers['Retry-After'] = String(rl.retryAfterSec);
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  let episode = String(body.episode ?? '').trim();
  if (episode === '') {
    const open = await getOpenEpisode();
    if (!open) {
      return NextResponse.json(
        { error: 'No episode is open for notes — pass ep explicitly.' },
        { status: 400 }
      );
    }
    episode = open.episode;
  }

  const validated = validateNoteInput({ ...body, episode });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 400 });
  }

  const id = newNoteId(Date.now(), Math.random().toString(36).slice(2, 10));
  const note = buildNote(validated.value, id, new Date().toISOString());
  await saveNote(note);

  return NextResponse.json({ ok: true, id, episode }, { status: 201 });
}

/** List notes for the review UI. Bearer-authed, same as the other review APIs. */
export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('status') ?? 'pending';
  const status = (STATUSES as string[]).includes(raw) ? (raw as NoteStatus | 'all') : 'pending';

  try {
    return NextResponse.json({ notes: await listNotes(status) });
  } catch {
    return NextResponse.json({ error: 'Failed to list notes' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Write the resolve route**

Create `src/app/api/episode-notes/resolve/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import { loadNote, saveNote, type NoteStatus } from '@/lib/episode-notes';
import { appendToCell } from '@/lib/pdc-sheet';

interface Decision {
  id: string;
  status: NoteStatus;
  /** Optional edited text — an admin may fix a note before approving it. */
  note?: string;
}

/**
 * Approve or reject notes in batch.
 *
 * Approving appends the note to Notable_Moments and only then marks it
 * approved, so a failed sheet write leaves the note pending and retryable
 * rather than silently lost.
 */
export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const decisions = body?.decisions;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return NextResponse.json({ error: 'decisions must be a non-empty array' }, { status: 400 });
  }

  const results: Array<{ id: string; outcome: string }> = [];

  for (const d of decisions as Decision[]) {
    if (!d?.id || (d.status !== 'approved' && d.status !== 'rejected')) {
      results.push({ id: String(d?.id ?? ''), outcome: 'invalid_decision' });
      continue;
    }

    const note = await loadNote(d.id);
    if (!note) {
      results.push({ id: d.id, outcome: 'not_found' });
      continue;
    }
    if (note.status !== 'pending') {
      results.push({ id: d.id, outcome: `already_${note.status}` });
      continue;
    }

    const text = typeof d.note === 'string' && d.note.trim() !== '' ? d.note.trim() : note.note;

    if (d.status === 'rejected') {
      await saveNote({ ...note, status: 'rejected', resolvedAt: new Date().toISOString() });
      results.push({ id: d.id, outcome: 'rejected' });
      continue;
    }

    try {
      const outcome = await appendToCell(note.episode, 'Notable_Moments', text);
      if (outcome === 'no_row') {
        results.push({ id: d.id, outcome: 'no_sheet_row' });
        continue; // stays pending
      }
      await saveNote({
        ...note,
        note: text,
        status: 'approved',
        resolvedAt: new Date().toISOString(),
      });
      results.push({ id: d.id, outcome });
    } catch (err) {
      console.error('Notable_Moments append failed:', err);
      results.push({ id: d.id, outcome: 'append_failed' }); // stays pending
    }
  }

  return NextResponse.json({ ok: true, results });
}
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run build:local` — Expected: build succeeds, `/api/episode-notes` and `/api/episode-notes/resolve` appear in the route list

```bash
git add src/app/api/episode-notes
git commit -m "feat(notes): add submit, list, and resolve endpoints"
```

---

### Task 4: Announce in #engineers

**Files:**
- Modify: `scripts/notify-discord.ts`
- Create: `scripts/notify-notes-open.test.ts`
- Modify: `.github/workflows/ingest-episode.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: `setOpenEpisode` (Task 2); `WebhookPayload`, `AMBER` from `scripts/notify-discord.ts`.
- Produces: `buildNotesOpenMessage(episode: string, film: string): WebhookPayload`; a `notes-open` event; per-event webhook selection.

- [ ] **Step 1: Write the failing test**

Create `scripts/notify-notes-open.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotesOpenMessage, webhookForEvent, AMBER } from './notify-discord.ts';

test('notes-open names the episode and film', () => {
  const p = buildNotesOpenMessage('317', 'Barton Fink (1991)');
  assert.equal(p.embeds[0].title, 'Ep 317 · Barton Fink (1991)');
  assert.equal(p.embeds[0].color, AMBER);
});

test('notes-open states that it is a call for nominations', () => {
  const p = buildNotesOpenMessage('317', 'Barton Fink (1991)');
  const text = `${p.content ?? ''} ${p.embeds[0].description ?? ''}`;
  assert.match(text, /notable moment/i);
});

test('notes-open tells people the command and shows an example', () => {
  const d = buildNotesOpenMessage('317', 'Barton Fink (1991)').embeds[0].description ?? '';
  assert.match(d, /\/pdc-note/);
  assert.match(d, /note:/);
});

test('notes-open works when the film is unknown', () => {
  const p = buildNotesOpenMessage('317', '');
  assert.equal(p.embeds[0].title, 'Episode 317');
});

test('webhookForEvent routes notes-open to the engineers webhook', () => {
  const env = { DISCORD_PDC_WEBHOOK_URL: 'https://pdc', DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' };
  assert.equal(webhookForEvent('notes-open', env), 'https://eng');
});

test('webhookForEvent routes every other event to the pdc webhook', () => {
  const env = { DISCORD_PDC_WEBHOOK_URL: 'https://pdc', DISCORD_ENGINEERS_WEBHOOK_URL: 'https://eng' };
  for (const e of ['needs-mapping', 'ingested', 'no-new-episodes', 'drive-unresolved']) {
    assert.equal(webhookForEvent(e, env), 'https://pdc');
  }
});

test('webhookForEvent returns undefined when the needed webhook is unset', () => {
  assert.equal(webhookForEvent('notes-open', { DISCORD_PDC_WEBHOOK_URL: 'https://pdc' }), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/notify-notes-open.test.ts`
Expected: FAIL — `buildNotesOpenMessage is not a function`

- [ ] **Step 3: Add the builder and webhook routing**

In `scripts/notify-discord.ts`, add next to the other `build*Message` functions:

```typescript
export function buildNotesOpenMessage(episode: string, film: string): WebhookPayload {
  const title = film.trim() === '' ? `Episode ${episode}` : `Ep ${episode} · ${film}`;
  return {
    content: '🗒️ Notable Moment nominations are open',
    embeds: [
      {
        title,
        description:
          `This episode is now open for Notable Moments. Nominate one with:\n` +
          '```\n/pdc-note note: Haitch\'s Roy Scheider tangent around 42:00\n```\n' +
          'One moment per note. Add as many as you like — an admin reviews them before anything reaches the sheet.',
        color: AMBER,
      },
    ],
  };
}

/**
 * Discord webhooks are channel-scoped, so each event posts through the webhook
 * for its channel. notes-open goes to #engineers; everything else to
 * #pod-data-central.
 */
export function webhookForEvent(
  event: string,
  env: Record<string, string | undefined>
): string | undefined {
  return event === 'notes-open'
    ? env.DISCORD_ENGINEERS_WEBHOOK_URL
    : env.DISCORD_PDC_WEBHOOK_URL;
}
```

- [ ] **Step 4: Use the routing in main()**

In `scripts/notify-discord.ts`, replace the top of `main()`:

```typescript
  const webhookUrl = process.env.DISCORD_PDC_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[notify-discord] DISCORD_PDC_WEBHOOK_URL not set — skipping.');
    return;
  }
```

with:

```typescript
  const event = getArg(args, 'event') ?? '';
  const webhookUrl = webhookForEvent(event, process.env);
  if (!webhookUrl) {
    const needed = event === 'notes-open' ? 'DISCORD_ENGINEERS_WEBHOOK_URL' : 'DISCORD_PDC_WEBHOOK_URL';
    console.warn(`[notify-discord] ${needed} not set — skipping.`);
    return;
  }
```

Delete the later `const event = getArg(args, 'event');` line so `event` is declared once.

Add the branch, after the `drive-unresolved` branch:

```typescript
  } else if (event === 'notes-open') {
    const ep = getArg(args, 'episode')?.replace(/^episode_/, '').trim();
    const film = getArg(args, 'film') ?? '';
    if (!ep) {
      console.warn('[notify-discord] notes-open needs --episode — skipping.');
      return;
    }
    payload = buildNotesOpenMessage(ep, film);
    try {
      const { setOpenEpisode } = await import('../src/lib/episode-notes');
      await setOpenEpisode({ episode: ep, film, openedAt: new Date().toISOString() });
    } catch (err) {
      // A failed pointer write means /pdc-note needs an explicit ep, which is
      // recoverable. Announcing is still worthwhile, so this is not fatal.
      console.warn(`[notify-discord] could not record open episode: ${err instanceof Error ? err.message : String(err)}`);
    }
```

Update the unknown-event warning to list `notes-open`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test scripts/notify-notes-open.test.ts`
Expected: PASS — 7 tests passing

- [ ] **Step 6: Wire into the ingest workflow**

In `.github/workflows/ingest-episode.yml`, insert after "Notify Discord — episode ingested" and before "Trigger deploy":

```yaml
      # Open the episode for Notable Moment nominations in #engineers.
      # Needs its own webhook: the PDC webhook is scoped to #pod-data-central.
      - name: Notify Discord — notes open
        continue-on-error: true
        env:
          DISCORD_ENGINEERS_WEBHOOK_URL: ${{ secrets.DISCORD_ENGINEERS_WEBHOOK_URL }}
          BLOB_READ_WRITE_TOKEN: ${{ secrets.BLOB_READ_WRITE_TOKEN }}
          EPISODE: ${{ inputs.episode }}
        run: node --import tsx ./scripts/notify-discord.ts --event=notes-open --episode="$EPISODE"
```

- [ ] **Step 7: Verify and commit**

In `package.json`, change `"test:notify"` to include the new file (keep the existing entries):

```json
"test:notify": "node --import tsx --test scripts/notify-discord.test.ts scripts/notify-drive-unresolved.test.ts scripts/notify-notes-open.test.ts",
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:notify` — Expected: existing tests plus 7 new, all passing

```bash
git add scripts/notify-discord.ts scripts/notify-notes-open.test.ts \
        .github/workflows/ingest-episode.yml package.json
git commit -m "feat(notes): announce nominations in #engineers"
```

---

### Task 5: The /pdc-note command

**This task is in a different repository:** `/opt/projects/transcript-bot` (discord.js v14, deployed on Railway). Commit there, not in `transcript-app`.

**Files:**
- Modify: `/opt/projects/transcript-bot/scripts/discord-register.ts`
- Modify: `/opt/projects/transcript-bot/scripts/discord-bot.ts`
- Modify: `/opt/projects/transcript-bot/CLAUDE.md`

**Interfaces:**
- Consumes: `POST /api/episode-notes` (Task 3) with header `x-eh-key` and body `{ note, submittedBy, episode? }`.
- Produces: a `/pdc-note` slash command.

- [ ] **Step 1: Register the command**

In `/opt/projects/transcript-bot/scripts/discord-register.ts`, add next to the other command builders:

```typescript
const noteCommand = new SlashCommandBuilder()
  .setName('pdc-note')
  .setDescription('Nominate a Notable Moment for the current episode')
  .addStringOption((option) =>
    option
      .setName('note')
      .setDescription('The moment, in one line')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('ep')
      .setDescription('Episode number (defaults to the episode currently open for notes)')
      .setRequired(false)
  );
```

Then add `noteCommand.toJSON()` to the array of commands passed to `rest.put(...)`, matching how the existing commands are registered in that file.

- [ ] **Step 2: Handle the command**

In `/opt/projects/transcript-bot/scripts/discord-bot.ts`, add a helper next to the other `fetch*` functions:

```typescript
interface NoteResponse {
  ok?: boolean;
  id?: string;
  episode?: string;
  error?: string;
}

async function submitNote(note: string, ep: string | null, submittedBy: string): Promise<NoteResponse> {
  const key = process.env.EH_BOT_KEY;
  if (!key) return { error: 'EH_BOT_KEY is not configured on the bot.' };

  const res = await fetch(`${baseUrl}/api/episode-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-eh-key': key },
    body: JSON.stringify({ note, submittedBy, ...(ep ? { episode: ep } : {}) }),
  });

  const data = (await res.json().catch(() => ({}))) as NoteResponse;
  if (!res.ok) return { error: data.error ?? `Request failed (${res.status})` };
  return data;
}
```

Then add the interaction branch next to the other `interaction.commandName ===` blocks:

```typescript
      if (interaction.commandName === 'pdc-note') {
        const note = interaction.options.getString('note', true);
        const ep = interaction.options.getString('ep');
        await interaction.deferReply({ ephemeral: true });

        const result = await submitNote(note, ep, interaction.user.tag);
        if (result.error) {
          await interaction.editReply(`Could not save that note: ${result.error}`);
          return;
        }
        await interaction.editReply(
          `Noted for episode ${result.episode}. It goes to an admin for review before it reaches the sheet.`
        );
        return;
      }
```

The reply is ephemeral so the channel does not fill with confirmations. No role gate: collection is deliberately open to the channel, and the approval step is the gate.

- [ ] **Step 3: Document the new environment variable**

In `/opt/projects/transcript-bot/CLAUDE.md`, add to the Environment Variables list:

```markdown
- `EH_BOT_KEY` — external API key (from the app's `EH_EXTERNAL_KEYS`) used by `/pdc-note` to submit Notable Moment nominations
```

And add `/pdc-note` to the Commands section of that file.

- [ ] **Step 4: Verify**

From `/opt/projects/transcript-bot`:

Run: `npx tsc --noEmit`
Expected: no errors

The command cannot be exercised without a live Discord connection and a running app. Do not attempt to start the bot. State in your report that verification was limited to type-checking, and that registering the command (`npm run register`) and setting `EH_BOT_KEY` on Railway are deployment steps a human performs.

- [ ] **Step 5: Commit (in the transcript-bot repo)**

```bash
cd /opt/projects/transcript-bot
git add scripts/discord-register.ts scripts/discord-bot.ts CLAUDE.md
git commit -m "feat: add /pdc-note for Notable Moment nominations"
```

---

### Task 6: Notes review tab

**Files:**
- Modify: `src/app/review/submissions/page.tsx`

**Interfaces:**
- Consumes: `GET /api/episode-notes?status=pending` and `POST /api/episode-notes/resolve` (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Add notes state and loading**

In `src/app/review/submissions/page.tsx`, add alongside the existing report state:

```tsx
interface EpisodeNoteView {
  id: string;
  episode: string;
  note: string;
  submittedBy: string;
  createdAt: string;
}

const [tab, setTab] = useState<'reports' | 'notes'>('reports');
const [notes, setNotes] = useState<EpisodeNoteView[]>([]);
const [edited, setEdited] = useState<Record<string, string>>({});
const [notesError, setNotesError] = useState<string | null>(null);
```

Add a loader next to the existing `load` callback:

```tsx
const loadNotes = useCallback(() => {
  fetch('/api/episode-notes?status=pending')
    .then((r) => r.json())
    .then((d) => {
      setNotes(d.notes ?? []);
      setNotesError(null);
    })
    .catch(() => setNotesError('Failed to load notes. Refresh to try again.'));
}, []);

useEffect(() => {
  loadNotes();
}, [loadNotes]);
```

- [ ] **Step 2: Add the resolve handler**

```tsx
async function resolveNotes(decisions: Array<{ id: string; status: 'approved' | 'rejected' }>) {
  const withEdits = decisions.map((d) =>
    d.status === 'approved' && edited[d.id] ? { ...d, note: edited[d.id] } : d
  );
  const res = await fetch('/api/episode-notes/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisions: withEdits }),
  });
  const data = await res.json();
  const failed = (data.results ?? []).filter(
    (r: { outcome: string }) => r.outcome !== 'appended' && r.outcome !== 'rejected' && r.outcome !== 'duplicate'
  );
  if (failed.length > 0) {
    setNotesError(
      `${failed.length} note(s) could not be applied: ${failed.map((f: { outcome: string }) => f.outcome).join(', ')}. They remain pending.`
    );
  }
  loadNotes();
}
```

An outcome of `no_sheet_row` or `append_failed` leaves the note pending, so it can be retried once the sheet row exists — the message says so rather than silently dropping it.

- [ ] **Step 3: Render the tab**

Add a tab switcher above the existing content:

```tsx
<div className="mb-4 flex gap-2">
  <button
    onClick={() => setTab('reports')}
    style={{ fontWeight: tab === 'reports' ? 600 : 400 }}
  >
    Transcription reports
  </button>
  <button
    onClick={() => setTab('notes')}
    style={{ fontWeight: tab === 'notes' ? 600 : 400 }}
  >
    Notable Moments ({notes.length})
  </button>
</div>
```

Wrap the existing reports markup in `{tab === 'reports' && ( ... )}` and add the notes panel:

```tsx
{tab === 'notes' && (
  <div>
    {notesError && <p style={{ color: '#b91c1c' }}>{notesError}</p>}
    {notes.length === 0 && <p>No notes awaiting review.</p>}
    {notes.map((n) => (
      <div key={n.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
          Ep {n.episode} · {n.submittedBy} · {new Date(n.createdAt).toLocaleString()}
        </div>
        <textarea
          value={edited[n.id] ?? n.note}
          onChange={(e) => setEdited((prev) => ({ ...prev, [n.id]: e.target.value }))}
          rows={2}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => resolveNotes([{ id: n.id, status: 'approved' }])}>Approve</button>
          <button onClick={() => resolveNotes([{ id: n.id, status: 'rejected' }])}>Reject</button>
        </div>
      </div>
    ))}
    {notes.length > 1 && (
      <button
        onClick={() => resolveNotes(notes.map((n) => ({ id: n.id, status: 'approved' as const })))}
      >
        Approve all {notes.length}
      </button>
    )}
  </div>
)}
```

The textarea makes edit-then-approve the default interaction — an admin fixes a note's wording before it reaches the sheet rather than rejecting it outright.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run build:local` — Expected: build succeeds

Then manually: `npm run dev`, open `/review/submissions`, confirm the tab switcher works and the reports tab still behaves exactly as before. With a note in Blob, confirm Approve appends a bullet to that episode's `Notable_Moments` and the note disappears from the pending list.

- [ ] **Step 5: Commit**

```bash
git add src/app/review/submissions/page.tsx
git commit -m "feat(notes): review Notable Moment nominations"
```

---

## Verification after all tasks

- [ ] `npx tsc --noEmit` — no errors (both repos)
- [ ] `npm run test:pdc && npm run test:notes && npm run test:notify && npm run test:reports` — all passing
- [ ] `npm run build:local` — succeeds
- [ ] `/review/submissions` reports tab behaves exactly as before the change
- [ ] A note submitted through the API appears in the notes tab, and approving it appends a `- ` bullet to that episode's `Notable_Moments` without disturbing existing content
- [ ] Approving a note for an episode with no sheet row reports `no_sheet_row` and leaves the note pending
- [ ] `grep -n "GatewayIntentBits" /opt/projects/transcript-bot/scripts/discord-bot.ts` still shows only `Guilds`

## Deployment steps for a human

1. Create an incoming webhook on the `#engineers` Discord channel and add its URL as the repo secret `DISCORD_ENGINEERS_WEBHOOK_URL`. Without it the announcement is skipped, not failed.
2. Mint an external key (added to the app's `EH_EXTERNAL_KEYS`) and set it as `EH_BOT_KEY` on Railway for the bot.
3. Run `npm run register` in `transcript-bot` to register `/pdc-note` with Discord.
