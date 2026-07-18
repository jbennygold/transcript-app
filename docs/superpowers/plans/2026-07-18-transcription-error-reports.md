# Transcription Error Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Matt's `explore.escapehatchpod.com` app file transcription-error reports to us via an authenticated API, land them in a Blob-backed review queue, and give Jason a `/review/reports` page where he can — and only he can — apply each fix to the transcript.

**Architecture:** A new external ingest endpoint (reusing the existing `x-eh-key` auth + rate-limit chain) and an internal file endpoint both write a `TranscriptionReport` to Vercel Blob and fire a Discord ping. A review page lists pending reports; a resolve endpoint re-resolves each report's text+timestamp anchor against the *current* transcript server-side and, only on explicit approval, writes the corrected turn and triggers a rebuild. Reports anchor on text+timestamp (never a raw index) so a report that goes stale between filing and approval can never corrupt a transcript.

**Tech Stack:** Next.js App Router (route handlers), TypeScript, Vercel Blob (`@vercel/blob`), `node:test` + `node:assert/strict` for unit tests (run via `node --import tsx --test`), existing `@anthropic-ai/sdk`-free path (no LLM in this feature).

## Global Constraints

- **Hard invariant:** No transcript is ever written without an explicit per-report **Approve & apply** action. No batch/auto apply. The ingest endpoints, the list endpoint, and the Discord ping are strictly read-only w.r.t. transcripts. Copied verbatim from the spec.
- **Location pinning:** Reports carry `anchor.{startTs,endTs?,speaker,originalText}` — never a dialogue-turn index. The turn index is resolved server-side at apply time.
- **Apply is server-authoritative:** The resolve endpoint re-runs the anchor resolver against the freshly loaded transcript; a client's view is never trusted.
- **Correction shape maps 1:1 onto `CleanupChange`:** `type ∈ {sample,spelling,speaker,voicemailer}`, `field ∈ {name,text}`, applying sets `dialogue[index][field] = newValue` (whole-field replacement).
- **Auth reuse:** External ingest uses `validateExternalKey(x-eh-key)` against `EH_EXTERNAL_KEYS` + `checkRateLimit(keyId)`. Internal endpoints under `/review` and `/api/transcription-reports` are unauthenticated (internal tool), matching the rest of `/review`.
- **Test convention:** Tests are `*.test.ts` next to the code, using `import { test } from 'node:test'` and `import assert from 'node:assert/strict'`. Add npm scripts of the form `node --import tsx --test <file>`.
- **Retained audit trail:** Resolved reports (`applied`/`dismissed`/`stale`) stay in Blob; nothing is deleted.

---

## File structure

**New files:**
- `src/lib/transcription-report.ts` — `TranscriptionReport` + related types, pure `validateReportInput()` and `buildReport()`, and thin Blob store helpers (`saveTranscriptionReport`, `listTranscriptionReports`, `loadTranscriptionReport`, `writeReport`).
- `src/lib/transcription-report.test.ts` — unit tests for `validateReportInput` + `buildReport`.
- `src/lib/resolve-report-anchor.ts` — pure `resolveReportAnchor(transcript, report)`.
- `src/lib/resolve-report-anchor.test.ts` — unit tests for the resolver.
- `src/lib/discord-notify.ts` — self-contained `notifyNewReport(report)` + pure `buildReportMessage(report)`.
- `src/lib/discord-notify.test.ts` — unit tests for `buildReportMessage`.
- `src/lib/trigger-rebuild.ts` — `triggerRebuild(episode)` (extracted GitHub workflow dispatch).
- `src/app/api/external/transcription-error/route.ts` — external ingest (auth + rate limit).
- `src/app/api/transcription-reports/route.ts` — internal `POST` (file) + `GET` (list).
- `src/app/api/transcription-reports/[id]/resolve/route.ts` — `POST { action: 'apply' | 'dismiss' }`.
- `src/app/review/reports/page.tsx` — the review UI.
- `src/components/ReportCard.tsx` — one report card (anchor context, red→green diff, actions).

**Modified files:**
- `src/app/api/rebuild/route.ts` — refactor to call `triggerRebuild()`.
- `src/app/page.tsx` — repoint the two `/api/transcription-error` callers (~L769, ~L976) to `/api/transcription-reports`.
- `package.json` — add test scripts.

**Retired:**
- `src/app/api/transcription-error/route.ts` — deleted after `page.tsx` is repointed (Task 9).

---

## Task 1: Report types, validation, and Blob store

**Files:**
- Create: `src/lib/transcription-report.ts`
- Test: `src/lib/transcription-report.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing (leaf module besides `@vercel/blob`).
- Produces:
  - Types `ReportStatus`, `CorrectionType`, `CorrectionField`, `ReportAnchor`, `ReportCorrection`, `ReportInput`, `TranscriptionReport`.
  - `validateReportInput(body: unknown): { ok: true; value: ReportInput } | { ok: false; error: string }`
  - `buildReport(input: ReportInput, meta: { id: string; createdAt: string; source: string }): TranscriptionReport`
  - `newReportId(now: number, rand: string): string`
  - `saveTranscriptionReport(report: TranscriptionReport): Promise<void>`
  - `listTranscriptionReports(status?: ReportStatus | 'all'): Promise<TranscriptionReport[]>`
  - `loadTranscriptionReport(id: string): Promise<TranscriptionReport | null>`
  - `writeReport(report: TranscriptionReport): Promise<void>` (overwrites in place; used for status transitions)

- [ ] **Step 1: Write the failing test**

Create `src/lib/transcription-report.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReportInput,
  buildReport,
  newReportId,
  type ReportInput,
} from './transcription-report.ts';

const goodBody = {
  episode: 119,
  anchor: {
    startTs: '01:12:04',
    endTs: '01:12:31',
    speaker: 'Jason Goldman',
    originalText: 'and then the ship jumped to lightspeed',
  },
  correction: { type: 'sample', field: 'name', newValue: 'Movie Sample' },
  note: 'Galaxy Quest clip',
  reporterName: 'matt-explore',
};

test('validateReportInput: accepts a well-formed body', () => {
  const r = validateReportInput(goodBody);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.episodeNumber, 119);
    assert.equal(r.value.correction.type, 'sample');
    assert.equal(r.value.anchor.speaker, 'Jason Goldman');
  }
});

test('validateReportInput: rejects missing episode', () => {
  const r = validateReportInput({ ...goodBody, episode: undefined });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects non-integer episode', () => {
  const r = validateReportInput({ ...goodBody, episode: 3.5 });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects bad correction type', () => {
  const r = validateReportInput({
    ...goodBody,
    correction: { type: 'bogus', field: 'name', newValue: 'x' },
  });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects empty originalText', () => {
  const r = validateReportInput({
    ...goodBody,
    anchor: { ...goodBody.anchor, originalText: '   ' },
  });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects newValue equal to speaker for field=name', () => {
  const r = validateReportInput({
    ...goodBody,
    correction: { type: 'sample', field: 'name', newValue: 'Jason Goldman' },
  });
  assert.equal(r.ok, false);
});

test('validateReportInput: rejects newValue equal to originalText for field=text', () => {
  const r = validateReportInput({
    ...goodBody,
    correction: {
      type: 'spelling',
      field: 'text',
      newValue: goodBody.anchor.originalText,
    },
  });
  assert.equal(r.ok, false);
});

test('buildReport: composes a pending report from input + meta', () => {
  const input = validateReportInput(goodBody);
  assert.equal(input.ok, true);
  if (!input.ok) return;
  const report = buildReport(input.value, {
    id: 'tr_1_abc',
    createdAt: '2026-07-18T00:00:00.000Z',
    source: 'explore',
  });
  assert.equal(report.status, 'pending');
  assert.equal(report.source, 'explore');
  assert.equal(report.id, 'tr_1_abc');
  assert.equal(report.episodeNumber, 119);
  assert.equal(report.resolvedTurnIndex, undefined);
});

test('newReportId: is deterministic given now + rand', () => {
  assert.equal(newReportId(1000, 'abcd'), 'tr_1000_abcd');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/lib/transcription-report.test.ts`
Expected: FAIL — `Cannot find module './transcription-report.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/transcription-report.ts`:

```ts
import { put, list } from '@vercel/blob';

export type ReportStatus = 'pending' | 'applied' | 'dismissed' | 'stale';
export type CorrectionType = 'sample' | 'spelling' | 'speaker' | 'voicemailer';
export type CorrectionField = 'name' | 'text';

export interface ReportAnchor {
  startTs: string;
  endTs?: string;
  speaker: string;
  originalText: string;
}

export interface ReportCorrection {
  type: CorrectionType;
  field: CorrectionField;
  newValue: string;
}

export interface ReportInput {
  episodeNumber: number;
  anchor: ReportAnchor;
  correction: ReportCorrection;
  note?: string;
  reporterName?: string;
}

export interface TranscriptionReport extends ReportInput {
  id: string;
  createdAt: string;
  source: string; // keyId ('explore') or 'internal'
  status: ReportStatus;
  resolvedAt?: string;
  resolvedTurnIndex?: number;
}

const PREFIX = 'transcription-reports/';
const TYPES: CorrectionType[] = ['sample', 'spelling', 'speaker', 'voicemailer'];
const FIELDS: CorrectionField[] = ['name', 'text'];

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateReportInput(
  body: unknown,
): { ok: true; value: ReportInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body must be an object' };
  }
  const b = body as Record<string, unknown>;

  const episode = b.episode;
  if (typeof episode !== 'number' || !Number.isInteger(episode) || episode <= 0) {
    return { ok: false, error: 'episode must be a positive integer' };
  }

  const anchor = b.anchor as Record<string, unknown> | undefined;
  if (!anchor || typeof anchor !== 'object') {
    return { ok: false, error: 'anchor is required' };
  }
  if (!nonEmptyString(anchor.startTs)) {
    return { ok: false, error: 'anchor.startTs is required' };
  }
  if (!nonEmptyString(anchor.speaker)) {
    return { ok: false, error: 'anchor.speaker is required' };
  }
  if (!nonEmptyString(anchor.originalText)) {
    return { ok: false, error: 'anchor.originalText is required' };
  }
  if (anchor.endTs !== undefined && typeof anchor.endTs !== 'string') {
    return { ok: false, error: 'anchor.endTs must be a string' };
  }

  const correction = b.correction as Record<string, unknown> | undefined;
  if (!correction || typeof correction !== 'object') {
    return { ok: false, error: 'correction is required' };
  }
  if (!TYPES.includes(correction.type as CorrectionType)) {
    return { ok: false, error: `correction.type must be one of ${TYPES.join(', ')}` };
  }
  if (!FIELDS.includes(correction.field as CorrectionField)) {
    return { ok: false, error: `correction.field must be one of ${FIELDS.join(', ')}` };
  }
  if (!nonEmptyString(correction.newValue)) {
    return { ok: false, error: 'correction.newValue is required' };
  }

  const field = correction.field as CorrectionField;
  const newValue = (correction.newValue as string).trim();
  const compareTo = field === 'name'
    ? (anchor.speaker as string).trim()
    : (anchor.originalText as string).trim();
  if (newValue === compareTo) {
    return { ok: false, error: 'correction.newValue must differ from the current value' };
  }

  if (b.note !== undefined && typeof b.note !== 'string') {
    return { ok: false, error: 'note must be a string' };
  }
  if (b.reporterName !== undefined && typeof b.reporterName !== 'string') {
    return { ok: false, error: 'reporterName must be a string' };
  }

  return {
    ok: true,
    value: {
      episodeNumber: episode,
      anchor: {
        startTs: (anchor.startTs as string).trim(),
        endTs: anchor.endTs as string | undefined,
        speaker: (anchor.speaker as string).trim(),
        originalText: (anchor.originalText as string).trim(),
      },
      correction: { type: correction.type as CorrectionType, field, newValue },
      note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : undefined,
      reporterName:
        typeof b.reporterName === 'string' && b.reporterName.trim()
          ? b.reporterName.trim()
          : undefined,
    },
  };
}

export function newReportId(now: number, rand: string): string {
  return `tr_${now}_${rand}`;
}

export function buildReport(
  input: ReportInput,
  meta: { id: string; createdAt: string; source: string },
): TranscriptionReport {
  return {
    ...input,
    id: meta.id,
    createdAt: meta.createdAt,
    source: meta.source,
    status: 'pending',
  };
}

export async function saveTranscriptionReport(report: TranscriptionReport): Promise<void> {
  await writeReport(report);
}

// Overwrites the same Blob object in place (status transitions reuse the id).
export async function writeReport(report: TranscriptionReport): Promise<void> {
  await put(`${PREFIX}${report.id}.json`, JSON.stringify(report, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function listTranscriptionReports(
  status: ReportStatus | 'all' = 'all',
): Promise<TranscriptionReport[]> {
  const { blobs } = await list({ prefix: PREFIX });
  const reports: TranscriptionReport[] = [];
  for (const blob of blobs) {
    if (!blob.pathname.endsWith('.json')) continue;
    try {
      const resp = await fetch(blob.url, { cache: 'no-store' });
      if (resp.ok) reports.push(await resp.json());
    } catch {
      // skip corrupt entries
    }
  }
  const filtered = status === 'all' ? reports : reports.filter((r) => r.status === status);
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadTranscriptionReport(id: string): Promise<TranscriptionReport | null> {
  const { blobs } = await list({ prefix: `${PREFIX}${id}.json` });
  const match = blobs.find((b) => b.pathname === `${PREFIX}${id}.json`);
  if (!match) return null;
  try {
    const resp = await fetch(match.url, { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add the test script to `package.json`**

In the `"scripts"` block, alongside `"test:notify"`, add:

```json
    "test:reports": "node --import tsx --test src/lib/transcription-report.test.ts src/lib/resolve-report-anchor.test.ts src/lib/discord-notify.test.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test src/lib/transcription-report.test.ts`
Expected: PASS — all `validateReportInput` / `buildReport` / `newReportId` tests green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/transcription-report.ts src/lib/transcription-report.test.ts package.json
git commit -m "feat(reports): report types, input validation, and Blob store"
```

---

## Task 2: Anchor resolver

**Files:**
- Create: `src/lib/resolve-report-anchor.ts`
- Test: `src/lib/resolve-report-anchor.test.ts`

**Interfaces:**
- Consumes: `Transcript`, `DialogueEntry` from `@/types/transcript`; `TranscriptionReport` from `./transcription-report`.
- Produces:
  - `type AnchorResolution = { status: 'match'; index: number } | { status: 'already_fixed' } | { status: 'not_found' } | { status: 'ambiguous'; indexes: number[] }`
  - `resolveReportAnchor(transcript: Transcript, report: Pick<TranscriptionReport, 'anchor' | 'correction'>): AnchorResolution`

- [ ] **Step 1: Write the failing test**

Create `src/lib/resolve-report-anchor.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReportAnchor } from './resolve-report-anchor.ts';
import type { Transcript } from '@/types/transcript';

function tx(dialogues: { name: string; timestamp: string; text: string }[]): Transcript {
  return { episode_number: 119, episode_name: 'Galaxy Quest', dialogues };
}

const sampleReport = {
  anchor: { startTs: '01:12:04', speaker: 'Jason Goldman', originalText: 'jumped to lightspeed' },
  correction: { type: 'sample' as const, field: 'name' as const, newValue: 'Movie Sample' },
};

test('exact single text match → match with that index', () => {
  const t = tx([
    { name: 'Matt Haitch', timestamp: '01:11:00', text: 'here comes the clip' },
    { name: 'Jason Goldman', timestamp: '01:12:04', text: 'jumped to lightspeed' },
  ]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'match', index: 1 });
});

test('whitespace/case differences still match', () => {
  const t = tx([{ name: 'Jason Goldman', timestamp: '01:12:04', text: '  Jumped   to LIGHTSPEED ' }]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'match', index: 0 });
});

test('already fixed (name already Movie Sample) → already_fixed', () => {
  const t = tx([{ name: 'Movie Sample', timestamp: '01:12:04', text: 'totally different words now' }]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'already_fixed' });
});

test('text not present anywhere → not_found', () => {
  const t = tx([{ name: 'Jason Goldman', timestamp: '00:01:00', text: 'welcome to escape hatch' }]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'not_found' });
});

test('duplicate text at different timestamps → ambiguous (both indexes)', () => {
  const t = tx([
    { name: 'Jason Goldman', timestamp: '00:05:00', text: 'jumped to lightspeed' },
    { name: 'Jason Goldman', timestamp: '01:30:00', text: 'jumped to lightspeed' },
  ]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'ambiguous', indexes: [0, 1] });
});

test('duplicate text but startTs disambiguates → match', () => {
  const t = tx([
    { name: 'Jason Goldman', timestamp: '00:05:00', text: 'jumped to lightspeed' },
    { name: 'Jason Goldman', timestamp: '01:12:04', text: 'jumped to lightspeed' },
  ]);
  assert.deepEqual(resolveReportAnchor(t, sampleReport), { status: 'match', index: 1 });
});

test('field=text already fixed (turn text equals newValue) → already_fixed', () => {
  const textReport = {
    anchor: { startTs: '00:10:00', speaker: 'Jason Goldman', originalText: 'jo esther house wrote it' },
    correction: { type: 'spelling' as const, field: 'text' as const, newValue: 'Joe Eszterhas wrote it' },
  };
  const t = tx([{ name: 'Jason Goldman', timestamp: '00:10:00', text: 'Joe Eszterhas wrote it' }]);
  assert.deepEqual(resolveReportAnchor(t, textReport), { status: 'already_fixed' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/lib/resolve-report-anchor.test.ts`
Expected: FAIL — `Cannot find module './resolve-report-anchor.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/resolve-report-anchor.ts`:

```ts
import type { Transcript } from '@/types/transcript';
import type { TranscriptionReport } from './transcription-report';

export type AnchorResolution =
  | { status: 'match'; index: number }
  | { status: 'already_fixed' }
  | { status: 'not_found' }
  | { status: 'ambiguous'; indexes: number[] };

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function resolveReportAnchor(
  transcript: Transcript,
  report: Pick<TranscriptionReport, 'anchor' | 'correction'>,
): AnchorResolution {
  const { anchor, correction } = report;
  const dialogues = transcript.dialogues ?? [];
  const targetText = norm(anchor.originalText);
  const targetNewValue = norm(correction.newValue);

  const textMatches: number[] = [];
  for (let i = 0; i < dialogues.length; i++) {
    if (norm(dialogues[i].text) === targetText) textMatches.push(i);
  }

  if (textMatches.length === 1) return { status: 'match', index: textMatches[0] };

  if (textMatches.length > 1) {
    const byTs = textMatches.filter((i) => dialogues[i].timestamp === anchor.startTs);
    if (byTs.length === 1) return { status: 'match', index: byTs[0] };
    return { status: 'ambiguous', indexes: textMatches };
  }

  // Zero text matches — the turn may already carry the correction.
  const alreadyFixed = dialogues.some((d) => {
    if (correction.field === 'name') {
      return norm(d.name) === targetNewValue && d.timestamp === anchor.startTs;
    }
    return norm(d.text) === targetNewValue;
  });
  if (alreadyFixed) return { status: 'already_fixed' };

  return { status: 'not_found' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/lib/resolve-report-anchor.test.ts`
Expected: PASS — all 7 resolver cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/resolve-report-anchor.ts src/lib/resolve-report-anchor.test.ts
git commit -m "feat(reports): text+timestamp anchor resolver with stale detection"
```

---

## Task 3: Discord notification helper

**Files:**
- Create: `src/lib/discord-notify.ts`
- Test: `src/lib/discord-notify.test.ts`

**Interfaces:**
- Consumes: `TranscriptionReport` from `./transcription-report`.
- Produces:
  - `interface DiscordEmbed { title: string; description?: string; color: number; fields?: { name: string; value: string; inline?: boolean }[] }`
  - `interface WebhookPayload { content?: string; embeds: DiscordEmbed[] }`
  - `buildReportMessage(report: TranscriptionReport): WebhookPayload`
  - `notifyNewReport(report: TranscriptionReport): Promise<void>` — no-ops when `DISCORD_PDC_WEBHOOK_URL` is unset.

Note: this module is intentionally self-contained (its own tiny `postToDiscord`) rather than importing the CLI script `scripts/notify-discord.ts`, which has argv-driven behavior. The ~10-line fetch wrapper is duplicated on purpose.

- [ ] **Step 1: Write the failing test**

Create `src/lib/discord-notify.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportMessage } from './discord-notify.ts';
import type { TranscriptionReport } from './transcription-report.ts';

const report: TranscriptionReport = {
  id: 'tr_1_abc',
  createdAt: '2026-07-18T00:00:00.000Z',
  source: 'explore',
  status: 'pending',
  episodeNumber: 119,
  anchor: { startTs: '01:12:04', speaker: 'Jason Goldman', originalText: 'jumped to lightspeed' },
  correction: { type: 'sample', field: 'name', newValue: 'Movie Sample' },
  note: 'Galaxy Quest clip',
};

test('buildReportMessage: amber embed naming episode, type, and source', () => {
  const payload = buildReportMessage(report);
  assert.equal(payload.embeds.length, 1);
  const embed = payload.embeds[0];
  assert.equal(embed.color, 0xf59e0b);
  assert.match(embed.title, /119/);
  const fieldText = JSON.stringify(embed.fields);
  assert.match(fieldText, /sample/);
  assert.match(fieldText, /Jason Goldman/);
  assert.match(fieldText, /Movie Sample/);
  assert.match(fieldText, /explore/);
});

test('buildReportMessage: content mentions a new report is waiting', () => {
  const payload = buildReportMessage(report);
  assert.match(payload.content ?? '', /report/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/lib/discord-notify.test.ts`
Expected: FAIL — `Cannot find module './discord-notify.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/discord-notify.ts`:

```ts
import type { TranscriptionReport } from './transcription-report';

const AMBER = 0xf59e0b;

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface WebhookPayload {
  content?: string;
  embeds: DiscordEmbed[];
}

export function buildReportMessage(report: TranscriptionReport): WebhookPayload {
  const oldValue =
    report.correction.field === 'name' ? report.anchor.speaker : report.anchor.originalText;
  const fields = [
    { name: 'Type', value: report.correction.type, inline: true },
    { name: 'Source', value: report.source, inline: true },
    { name: 'Timestamp', value: report.anchor.startTs, inline: true },
    { name: 'Change', value: `\`${oldValue}\` → \`${report.correction.newValue}\`` },
  ];
  if (report.note) fields.push({ name: 'Note', value: report.note });
  return {
    content: '📝 New transcription error report to review',
    embeds: [
      {
        title: `Ep ${report.episodeNumber} · transcription report`,
        color: AMBER,
        fields,
      },
    ],
  };
}

async function postToDiscord(webhookUrl: string, payload: WebhookPayload): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status}: ${await res.text()}`);
  }
}

export async function notifyNewReport(report: TranscriptionReport): Promise<void> {
  const webhookUrl = process.env.DISCORD_PDC_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[discord-notify] DISCORD_PDC_WEBHOOK_URL not set — skipping.');
    return;
  }
  try {
    await postToDiscord(webhookUrl, buildReportMessage(report));
  } catch (err) {
    console.error('[discord-notify] failed to post report notification:', err);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/lib/discord-notify.test.ts`
Expected: PASS — both `buildReportMessage` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord-notify.ts src/lib/discord-notify.test.ts
git commit -m "feat(reports): discord ping for new transcription reports"
```

---

## Task 4: Extract `triggerRebuild` and refactor the rebuild route

**Files:**
- Create: `src/lib/trigger-rebuild.ts`
- Modify: `src/app/api/rebuild/route.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `triggerRebuild(episode: number | string): Promise<{ ok: boolean; error?: string; status?: number }>`

- [ ] **Step 1: Create the helper**

Create `src/lib/trigger-rebuild.ts`:

```ts
const GITHUB_REPO = 'jbennygold/transcript-app';
const WORKFLOW_FILE = 'ingest-episode.yml';

/**
 * Dispatch the ingest-episode GitHub Actions workflow for one episode.
 * Returns { ok: false } (never throws) when the token is missing or GitHub rejects.
 */
export async function triggerRebuild(
  episode: number | string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const githubToken = process.env.GITHUB_PAT;
  if (!githubToken) return { ok: false, error: 'GITHUB_PAT not configured' };

  const ep = String(episode);
  if (!ep || ep === 'undefined') return { ok: false, error: 'Missing episode number' };

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: 'master', inputs: { episode: ep } }),
      },
    );
    if (!response.ok) {
      return { ok: false, error: await response.text(), status: response.status };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
```

- [ ] **Step 2: Refactor the rebuild route to use it**

Replace the body of `POST` in `src/app/api/rebuild/route.ts` so the GitHub-dispatch block delegates to `triggerRebuild`. The final file:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { triggerRebuild } from '@/lib/trigger-rebuild';

/**
 * POST /api/rebuild
 * Trigger the ingest-episode GitHub Actions workflow for a specific episode.
 * Body: { episode: number }
 */
export async function POST(request: NextRequest) {
  let episode: string;
  try {
    const body = await request.json();
    episode = String(body.episode);
    if (!episode || episode === 'undefined') {
      return NextResponse.json(
        { error: 'Missing episode number in request body' },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body — expected { episode: number }' },
      { status: 400 },
    );
  }

  const result = await triggerRebuild(episode);
  if (!result.ok) {
    const status = result.error === 'GITHUB_PAT not configured' ? 500 : (result.status ?? 500);
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ success: true, episode });
}
```

Note: if `src/app/api/rebuild/route.ts` currently has a `GET` handler or other exports below the section shown in the plan's research, preserve them — only the `POST` handler and the top imports change. Open the file and confirm before overwriting.

- [ ] **Step 3: Verify the rebuild route still compiles**

Run: `npx tsc --noEmit`
Expected: no new type errors from `rebuild/route.ts` or `trigger-rebuild.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/trigger-rebuild.ts src/app/api/rebuild/route.ts
git commit -m "refactor(rebuild): extract triggerRebuild for reuse by resolve endpoint"
```

---

## Task 5: External ingest endpoint

**Files:**
- Create: `src/app/api/external/transcription-error/route.ts`

**Interfaces:**
- Consumes: `validateExternalKey` (`@/lib/external-auth`), `checkRateLimit` (`@/lib/external-rate-limit`), `getEpisodeByNumber` (`@/lib/metadata-store`), `validateReportInput`/`buildReport`/`newReportId`/`saveTranscriptionReport` (`@/lib/transcription-report`), `notifyNewReport` (`@/lib/discord-notify`).
- Produces: `POST` handler returning `{ id }` on success.

- [ ] **Step 1: Write the route**

Create `src/app/api/external/transcription-error/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { validateExternalKey } from '@/lib/external-auth';
import { checkRateLimit } from '@/lib/external-rate-limit';
import { getEpisodeByNumber } from '@/lib/metadata-store';
import {
  validateReportInput,
  buildReport,
  newReportId,
  saveTranscriptionReport,
} from '@/lib/transcription-report';
import { notifyNewReport } from '@/lib/discord-notify';

export async function POST(request: NextRequest) {
  const auth = validateExternalKey(request.headers.get('x-eh-key'));
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.reason === 'missing' ? 'Missing x-eh-key header' : 'Invalid key' },
      { status: 401 },
    );
  }

  const rl = checkRateLimit(auth.keyId);
  if (!rl.allowed) {
    const headers: Record<string, string> = {};
    if (rl.retryAfterSec) headers['Retry-After'] = String(rl.retryAfterSec);
    return NextResponse.json(
      { error: `Rate limit exceeded (${rl.scope})`, retryAfterSec: rl.retryAfterSec },
      { status: 429, headers },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = validateReportInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  if (!getEpisodeByNumber(parsed.value.episodeNumber)) {
    return NextResponse.json(
      { error: `Unknown episode ${parsed.value.episodeNumber}` },
      { status: 400 },
    );
  }

  const report = buildReport(parsed.value, {
    id: newReportId(Date.now(), Math.random().toString(36).slice(2, 11)),
    createdAt: new Date().toISOString(),
    source: auth.keyId,
  });

  try {
    await saveTranscriptionReport(report);
  } catch (err) {
    console.error('Failed to save transcription report:', err, { keyId: auth.keyId });
    return NextResponse.json({ error: 'Failed to store report' }, { status: 500 });
  }

  await notifyNewReport(report);

  return NextResponse.json({ id: report.id }, { status: 201 });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 3: Manual smoke test (local dev)**

Start dev server (`npm run dev`) in one shell. In another, with a valid key exported (`EH_EXTERNAL_KEYS=explore:eh_test` in `.env.local`):

```bash
curl -s -X POST http://localhost:3000/api/external/transcription-error \
  -H 'x-eh-key: eh_test' -H 'Content-Type: application/json' \
  -d '{"episode":119,"anchor":{"startTs":"01:12:04","speaker":"Jason Goldman","originalText":"<paste an exact line from ep 119>"},"correction":{"type":"sample","field":"name","newValue":"Movie Sample"},"note":"smoke test"}'
```

Expected: `{"id":"tr_..."}` with HTTP 201. A wrong/missing `x-eh-key` returns 401; a bad `type` returns 400.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/external/transcription-error/route.ts
git commit -m "feat(reports): external ingest endpoint with auth + rate limit"
```

---

## Task 6: Internal file + list endpoint

**Files:**
- Create: `src/app/api/transcription-reports/route.ts`

**Interfaces:**
- Consumes: `validateReportInput`/`buildReport`/`newReportId`/`saveTranscriptionReport`/`listTranscriptionReports` (`@/lib/transcription-report`), `getEpisodeByNumber` (`@/lib/metadata-store`), `notifyNewReport` (`@/lib/discord-notify`).
- Produces:
  - `POST` (internal, no auth) → files a report with `source: 'internal'`, returns `{ id }`.
  - `GET ?status=pending|applied|dismissed|stale|all&episode=N` → `{ total, reports }`.

- [ ] **Step 1: Write the route**

Create `src/app/api/transcription-reports/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import {
  validateReportInput,
  buildReport,
  newReportId,
  saveTranscriptionReport,
  listTranscriptionReports,
  type ReportStatus,
} from '@/lib/transcription-report';
import { getEpisodeByNumber } from '@/lib/metadata-store';
import { notifyNewReport } from '@/lib/discord-notify';

const STATUSES: (ReportStatus | 'all')[] = ['pending', 'applied', 'dismissed', 'stale', 'all'];

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = validateReportInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  if (!getEpisodeByNumber(parsed.value.episodeNumber)) {
    return NextResponse.json(
      { error: `Unknown episode ${parsed.value.episodeNumber}` },
      { status: 400 },
    );
  }

  const report = buildReport(parsed.value, {
    id: newReportId(Date.now(), Math.random().toString(36).slice(2, 11)),
    createdAt: new Date().toISOString(),
    source: 'internal',
  });

  try {
    await saveTranscriptionReport(report);
  } catch (err) {
    console.error('Failed to save internal transcription report:', err);
    return NextResponse.json({ error: 'Failed to store report' }, { status: 500 });
  }

  await notifyNewReport(report);
  return NextResponse.json({ id: report.id }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const statusParam = (searchParams.get('status') ?? 'pending') as ReportStatus | 'all';
  const status = STATUSES.includes(statusParam) ? statusParam : 'pending';
  const episodeParam = searchParams.get('episode');

  try {
    let reports = await listTranscriptionReports(status);
    if (episodeParam) {
      const epNum = parseInt(episodeParam, 10);
      reports = reports.filter((r) => r.episodeNumber === epNum);
    }
    return NextResponse.json({ total: reports.length, reports });
  } catch (err) {
    console.error('Failed to list transcription reports:', err);
    return NextResponse.json({ error: 'Failed to list reports' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 3: Manual smoke test**

With dev server running and the Task 5 report already filed:

```bash
curl -s 'http://localhost:3000/api/transcription-reports?status=pending' | head -c 500
```

Expected: JSON `{ "total": <n>, "reports": [ { "id": "tr_...", "status": "pending", ... } ] }`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/transcription-reports/route.ts
git commit -m "feat(reports): internal file + list endpoint"
```

---

## Task 7: Resolve endpoint (apply / dismiss)

**Files:**
- Create: `src/app/api/transcription-reports/[id]/resolve/route.ts`

**Interfaces:**
- Consumes: `loadTranscriptionReport`/`writeReport` (`@/lib/transcription-report`), `resolveReportAnchor` (`@/lib/resolve-report-anchor`), `loadTranscript`/`saveTranscript` (`@/lib/blob-storage`), `triggerRebuild` (`@/lib/trigger-rebuild`).
- Produces: `POST` handler; body `{ action: 'apply' | 'dismiss' }`; returns the updated report + outcome.

- [ ] **Step 1: Write the route**

Create `src/app/api/transcription-reports/[id]/resolve/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import {
  loadTranscriptionReport,
  writeReport,
  type TranscriptionReport,
} from '@/lib/transcription-report';
import { resolveReportAnchor } from '@/lib/resolve-report-anchor';
import { loadTranscript, saveTranscript } from '@/lib/blob-storage';
import { triggerRebuild } from '@/lib/trigger-rebuild';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let action: unknown;
  try {
    action = (await request.json())?.action;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (action !== 'apply' && action !== 'dismiss') {
    return NextResponse.json({ error: "action must be 'apply' or 'dismiss'" }, { status: 400 });
  }

  const report = await loadTranscriptionReport(id);
  if (!report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  }
  if (report.status !== 'pending') {
    return NextResponse.json(
      { error: `Report already ${report.status}` },
      { status: 409 },
    );
  }

  if (action === 'dismiss') {
    const updated: TranscriptionReport = {
      ...report,
      status: 'dismissed',
      resolvedAt: new Date().toISOString(),
    };
    await writeReport(updated);
    return NextResponse.json({ status: 'dismissed', report: updated });
  }

  // action === 'apply' — re-resolve against the CURRENT transcript, authoritatively.
  const transcript = await loadTranscript(report.episodeNumber);
  if (!transcript) {
    const updated: TranscriptionReport = {
      ...report,
      status: 'stale',
      resolvedAt: new Date().toISOString(),
    };
    await writeReport(updated);
    return NextResponse.json(
      { status: 'stale', reason: 'transcript not found', report: updated },
    );
  }

  const resolution = resolveReportAnchor(transcript, report);
  if (resolution.status !== 'match') {
    const updated: TranscriptionReport = {
      ...report,
      status: 'stale',
      resolvedAt: new Date().toISOString(),
    };
    await writeReport(updated);
    return NextResponse.json({ status: 'stale', reason: resolution.status, report: updated });
  }

  // Apply the whole-field replacement to the resolved turn.
  transcript.dialogues[resolution.index][report.correction.field] = report.correction.newValue;
  await saveTranscript(transcript);

  const rebuild = await triggerRebuild(report.episodeNumber);

  const updated: TranscriptionReport = {
    ...report,
    status: 'applied',
    resolvedAt: new Date().toISOString(),
    resolvedTurnIndex: resolution.index,
  };
  await writeReport(updated);

  return NextResponse.json({
    status: 'applied',
    turnIndex: resolution.index,
    rebuildTriggered: rebuild.ok,
    rebuildError: rebuild.ok ? undefined : rebuild.error,
    report: updated,
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new type errors. (`DialogueEntry[report.correction.field]` is a valid index into `{ name; timestamp; text }` since `field` is `'name' | 'text'`.)

- [ ] **Step 3: Manual smoke test — dismiss path**

With dev server running and a pending report id from Task 6:

```bash
curl -s -X POST http://localhost:3000/api/transcription-reports/<id>/resolve \
  -H 'Content-Type: application/json' -d '{"action":"dismiss"}'
```

Expected: `{"status":"dismissed", ...}`. A second call returns HTTP 409 `Report already dismissed`.

- [ ] **Step 4: Manual smoke test — stale path**

File a report whose `originalText` does not exist in the transcript, then `apply`:

Expected: `{"status":"stale","reason":"not_found", ...}` and **no transcript change**.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/transcription-reports/[id]/resolve/route.ts"
git commit -m "feat(reports): resolve endpoint — server-authoritative apply/dismiss"
```

---

## Task 8: Review UI — `/review/reports`

**Files:**
- Create: `src/app/review/reports/page.tsx`
- Create: `src/components/ReportCard.tsx`

**Interfaces:**
- Consumes: `GET /api/transcription-reports`, `POST /api/transcription-reports/[id]/resolve`. Types re-declared client-side (route responses are JSON).
- Produces: a client page rendering pending reports grouped by episode with per-card Approve & apply / Dismiss.

Note: the page does NOT decide stale-ness — it optimistically enables **Approve & apply**, and the resolve endpoint is authoritative. If the response comes back `status: 'stale'`, the card shows the STALE badge and the reason. This keeps the invariant (server decides) without duplicating the resolver in the client.

- [ ] **Step 1: Write the ReportCard component**

Create `src/components/ReportCard.tsx`:

```tsx
'use client';

import { useState } from 'react';

export interface ReportCardData {
  id: string;
  createdAt: string;
  source: string;
  status: string;
  episodeNumber: number;
  anchor: { startTs: string; endTs?: string; speaker: string; originalText: string };
  correction: { type: string; field: string; newValue: string };
  note?: string;
  reporterName?: string;
}

export function ReportCard({
  report,
  onResolved,
}: {
  report: ReportCardData;
  onResolved: (id: string, outcome: string, reason?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ status: string; reason?: string } | null>(null);

  const oldValue =
    report.correction.field === 'name' ? report.anchor.speaker : report.anchor.originalText;

  async function resolve(action: 'apply' | 'dismiss') {
    setBusy(true);
    try {
      const resp = await fetch(`/api/transcription-reports/${report.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await resp.json();
      setOutcome({ status: data.status, reason: data.reason });
      onResolved(report.id, data.status, data.reason);
    } catch {
      setOutcome({ status: 'error', reason: 'request failed' });
    } finally {
      setBusy(false);
    }
  }

  const isStale = outcome?.status === 'stale';

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#6b7280' }}>
        <span>
          {report.anchor.speaker} · {report.anchor.startTs}
          {report.anchor.endTs ? `–${report.anchor.endTs}` : ''} · {report.correction.type}
        </span>
        <span>from {report.source}{report.reporterName ? ` (${report.reporterName})` : ''}</span>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: 8, fontSize: 14 }}>
          − {oldValue}
        </div>
        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: 8, fontSize: 14, marginTop: 6 }}>
          + {report.correction.newValue}
        </div>
      </div>

      {report.note && (
        <p style={{ marginTop: 8, fontSize: 13, color: '#374151' }}>Note: {report.note}</p>
      )}

      {outcome ? (
        <p style={{ marginTop: 12, fontWeight: 600, color: isStale ? '#b45309' : '#16a34a' }}>
          {isStale ? `⚠ STALE (${outcome.reason}) — not applied` : `✓ ${outcome.status}`}
        </p>
      ) : (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={() => resolve('apply')} disabled={busy}
            style={{ padding: '6px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            Approve &amp; apply
          </button>
          <button onClick={() => resolve('dismiss')} disabled={busy}
            style={{ padding: '6px 12px', background: '#f3f4f6', color: '#111', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write the page**

Create `src/app/review/reports/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { ReportCard, type ReportCardData } from '@/components/ReportCard';

export default function ReportsReviewPage() {
  const [reports, setReports] = useState<ReportCardData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/transcription-reports?status=pending')
      .then((r) => r.json())
      .then((d) => setReports(d.reports ?? []))
      .finally(() => setLoading(false));
  }, []);

  function handleResolved(id: string, outcome: string) {
    // Applied/dismissed cards drop out of the pending list on next load;
    // keep stale cards visible so the reason stays on screen.
    if (outcome === 'applied' || outcome === 'dismissed') {
      setTimeout(() => setReports((prev) => prev.filter((r) => r.id !== id)), 1500);
    }
  }

  const byEpisode = reports.reduce<Record<number, ReportCardData[]>>((acc, r) => {
    (acc[r.episodeNumber] ??= []).push(r);
    return acc;
  }, {});

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Transcription error reports</h1>
      <p style={{ color: '#6b7280', fontSize: 14 }}>
        Nothing is changed until you click <strong>Approve &amp; apply</strong> on a report.
      </p>

      {loading ? (
        <p>Loading…</p>
      ) : reports.length === 0 ? (
        <p style={{ marginTop: 24 }}>No pending reports. 🎉</p>
      ) : (
        Object.entries(byEpisode).map(([ep, list]) => (
          <section key={ep} style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Episode {ep}</h2>
            {list.map((r) => (
              <ReportCard key={r.id} report={r} onResolved={handleResolved} />
            ))}
          </section>
        ))
      )}
    </main>
  );
}
```

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors for the two new files.

- [ ] **Step 4: Manual end-to-end test (agent-browser)**

With dev server running and at least one pending report filed:

```bash
agent-browser open http://localhost:3000/review/reports
agent-browser snapshot
```

Expected: the report card renders with the red/green diff and both buttons. Click **Approve & apply** on a report whose text exists → card shows `✓ applied`; re-loading `/api/transcript...` for that episode shows the corrected turn. File a report with non-existent text, apply → card shows `⚠ STALE (not_found) — not applied` and the transcript is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/app/review/reports/page.tsx src/components/ReportCard.tsx
git commit -m "feat(reports): /review/reports queue with per-report apply/dismiss"
```

---

## Task 9: Repoint the internal report button + retire the Resend route

**Files:**
- Modify: `src/app/page.tsx` (two `handleSubmit` callers near L769 and L976)
- Delete: `src/app/api/transcription-error/route.ts`

**Interfaces:**
- Consumes: `POST /api/transcription-reports`.
- Produces: no new exports.

Both callers currently POST `{ episodeTitle, episodeNumber, startTimestamp, endTimestamp, speakers, originalText, selectedText, correctedText, reporterName }` to `/api/transcription-error`. Remap to the new report shape. Because the new apply does whole-field replacement, compute the full corrected turn text (`originalText` with the first occurrence of `selectedText` replaced by `correctedText`) as `correction.newValue`, and anchor on the full turn text.

- [ ] **Step 1: Update the first caller (~L769)**

Replace the `fetch('/api/transcription-error', {...})` call in the first `handleSubmit` with:

```tsx
      const fullOriginal = source.text;
      const fullCorrected = fullOriginal.replace(selectedText.trim(), correctedText.trim());
      const response = await fetch('/api/transcription-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episode: Number(source.episodeNumber),
          anchor: {
            startTs: source.startTimestamp,
            endTs: source.endTimestamp,
            speaker: source.speakers,
            originalText: fullOriginal,
          },
          correction: {
            type: 'spelling',
            field: 'text',
            newValue: fullCorrected,
          },
          reporterName: reporterName.trim() || undefined,
        }),
      });
```

- [ ] **Step 2: Update the second caller (~L976)**

Replace the `fetch('/api/transcription-error', {...})` call in the second `handleSubmit` with:

```tsx
      const fullOriginal = result.answer;
      const fullCorrected = fullOriginal.replace(selectedText.trim(), correctedText.trim());
      const response = await fetch('/api/transcription-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episode: Number(episodeNumber),
          anchor: {
            startTs: startTimestamp,
            endTs: endTimestamp,
            speaker: speakers,
            originalText: fullOriginal,
          },
          correction: {
            type: 'spelling',
            field: 'text',
            newValue: fullCorrected,
          },
          reporterName: reporterName.trim() || undefined,
        }),
      });
```

Note: if `episodeNumber` / `source.episodeNumber` can be a non-numeric string in these components, `Number(...)` yields `NaN`, which the endpoint rejects with 400 — acceptable (the button already required a real episode). Confirm the surrounding variable names (`source`, `result`, `episodeNumber`, `speakers`, `startTimestamp`, `endTimestamp`, `selectedText`, `correctedText`, `reporterName`) match each component's scope when editing; they are read directly from the existing bodies shown in research.

- [ ] **Step 3: Delete the retired route**

```bash
git rm src/app/api/transcription-error/route.ts
```

- [ ] **Step 4: Type-check + lint + grep for stragglers**

Run:
```bash
npx tsc --noEmit && npm run lint
grep -rn "api/transcription-error" src/ || echo "no references remain"
```
Expected: no type/lint errors; grep prints `no references remain`.

- [ ] **Step 5: Manual test**

With dev server running, use the in-app "report error" flow on a search result. Submit a correction. Then check:

```bash
curl -s 'http://localhost:3000/api/transcription-reports?status=pending' | grep -o '"source":"internal"'
```
Expected: at least one `"source":"internal"` entry; it appears on `/review/reports`.

- [ ] **Step 6: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(reports): route internal report button to unified queue; retire Resend route"
```

---

## Task 10: Full run-through + push

**Files:** none (verification only)

- [ ] **Step 1: Run the whole unit suite**

Run: `npm run test:reports && npm run test:notify`
Expected: all report + resolver + discord tests pass; existing notify tests still pass.

- [ ] **Step 2: Full type-check + lint + build**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: End-to-end on local dev (both sources)**

1. External: `curl` a report with the `explore` key (Task 5 Step 3) → 201.
2. Internal: use the in-app report button (Task 9 Step 5) → appears in queue.
3. `/review/reports`: approve a valid one (transcript updates, rebuild dispatched), dismiss one, and confirm a stale one refuses to apply.

- [ ] **Step 4: Push to master**

```bash
git push origin master
```

- [ ] **Step 5: Post-deploy prod smoke (after Vercel deploy)**

Confirm `EH_EXTERNAL_KEYS` (with Matt's `explore` key) and `DISCORD_PDC_WEBHOOK_URL` are set in Vercel. File one external report against prod with the real key; confirm it appears at `https://search.escapehatchpod.com/review/reports` and a Discord ping lands in #pod-data-central. Share the endpoint + key usage with Matt:

```
POST https://search.escapehatchpod.com/api/external/transcription-error
Header: x-eh-key: <explore key>
Body: { episode, anchor:{startTs,endTs?,speaker,originalText}, correction:{type,field,newValue}, note?, reporterName? }
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** ingest endpoint (Task 5), Blob queue + shape (Task 1), anchor+stale resolver (Task 2), review page (Task 8), server-authoritative resolve (Task 7), Discord ping + unify internal button + retire Resend (Tasks 3, 9), testing (Tasks 1–2, 8, 10). Hard invariant enforced in Task 7 (server re-resolve) and reflected in the UI copy (Task 8).
- **Env/secrets required:** `EH_EXTERNAL_KEYS` (already set for external search), `DISCORD_PDC_WEBHOOK_URL` (already set), `GITHUB_PAT` (already set for rebuild), `BLOB_READ_WRITE_TOKEN` (already set for Blob).
- **Not built (YAGNI, per spec):** bulk apply, report editing, per-reporter analytics, callback to Matt's app.
