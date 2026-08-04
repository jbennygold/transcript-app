# PDC Tier 2 — Staged Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive `MMM_Count`, `Thats_Great_Count`, `Kevs_Question`, the four `Tilda*` columns, and a canonical `Film` title from a speaker-mapped transcript, and stage them as proposals a human accepts or rejects in `/podreview` — never writing to the sheet automatically.

**Architecture:** A CLI runs after ingest (when the transcript is speaker-mapped) and writes a proposal document to Vercel Blob, mirroring the existing `transcription-report` store. Counting is deterministic and pure; Kev/Tilda extraction is a Haiku call whose prompt-building and response-parsing are pure and unit-tested while the network call is a thin wrapper. `/podreview` gains a proposals banner offering per-field accept/reject, and accepting calls the existing `update-pdc` route.

**Tech Stack:** TypeScript (strict, ES modules), Next.js App Router, `@vercel/blob`, `@anthropic-ai/sdk` (Haiku), `node:test` + `node:assert/strict` via `node --import tsx --test`, GitHub Actions.

## Global Constraints

- **Tier 2 never writes to the sheet.** It writes proposals to Blob. The only sheet write is a human accepting a proposal in `/podreview`, which goes through the existing `POST /api/podreview/update-pdc` with mode `overwrite`.
- Tier 2 runs **after** ingest, because `TildaH` vs `TildaJason` depends on correct speaker attribution and an unmapped transcript has placeholder speakers.
- `MMM_Count` and `Thats_Great_Count` ship in **measure-only mode** behind `TIER2_COUNTERS_ENABLED` (default `false`). They record a derived count for comparison but produce no proposal until accuracy is measured against the ~300 hand-counted historical rows and accepted.
- Fields Tier 2 may propose, and no others: `Film`, `MMM_Count`, `Thats_Great_Count`, `Kevs_Question`, `TildaH`, `TildaJason`, `TildaGuest`, `TildaCorey`.
- `H_Flex`, `J_Flex`, `Chuckle_Hut_Favorites`, `Notable_Moments`, `Reviewer`, `Release_Date`, `Guest`, `Length*`, and the four link columns are **never** touched by Tier 2.
- `TildaGuest` and `TildaCorey` are frequently absent and must be allowed to come back null. A null is not a failure.
- Model id is `claude-haiku-4-5-20251001` — the id already used throughout this repo. Do not substitute another.
- Tests are pure-function only. No network, no Blob, no Anthropic, no credentialed fixtures.
- Test files import source **without** a `.ts` extension. `tsconfig.json` does not set `allowImportingTsExtensions`.
- `npm run lint` is non-functional in this repo (Next 16 removed `next lint`, no ESLint config). Use `npx tsc --noEmit`.
- Scripts run under `node --import tsx` and guard their entrypoint with `if (process.argv[1] === __filename)` where `__filename` comes from `fileURLToPath(import.meta.url)`.

## Out of scope

- Plan C — Engineers Notes (`Notable_Moments`, `/pdc-note`, the `#engineers` webhook).
- Backfilling Tier 2 across the archive. Like Tier 1, this is go-forward only.
- The `Reviewer: 'auto'` sentinel. It was dropped from Tier 1's constraints and is worth reopening, but not here.

---

### Task 1: Proposal store

**Files:**
- Create: `src/lib/pdc-proposals.ts`
- Create: `src/lib/pdc-proposals.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PdcColumnKey` from `src/lib/pdc-sheet.ts`; `EpisodeId` from `src/lib/episode-format.ts`.
- Produces:
  - `type ProposalStatus = 'pending' | 'accepted' | 'rejected'`
  - `type ProposalConfidence = 'high' | 'low'`
  - `interface FieldProposal { column: Tier2Column; proposed: string; current: string | null; confidence: ProposalConfidence; evidence?: string; status: ProposalStatus }`
  - `type Tier2Column` — union of the eight proposable columns
  - `interface EpisodeProposals { episode: string; film: string; createdAt: string; proposals: FieldProposal[] }`
  - `TIER2_COLUMNS: readonly Tier2Column[]`
  - `isTier2Column(key: string): key is Tier2Column`
  - `buildProposals(episode: string, film: string, createdAt: string, fields: Array<Omit<FieldProposal, 'status'>>): EpisodeProposals`
  - `applyDecisions(doc: EpisodeProposals, decisions: Record<string, ProposalStatus>): EpisodeProposals`
  - `acceptedRow(doc: EpisodeProposals): Partial<Record<Tier2Column, string>>`
  - `saveProposals(doc: EpisodeProposals): Promise<void>`
  - `loadProposals(episode: string): Promise<EpisodeProposals | null>`
  - `listPendingProposals(): Promise<EpisodeProposals[]>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/pdc-proposals.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIER2_COLUMNS,
  isTier2Column,
  buildProposals,
  applyDecisions,
  acceptedRow,
} from './pdc-proposals';

const FIELDS = [
  { column: 'Kevs_Question' as const, proposed: 'What is your favourite?', current: null, confidence: 'high' as const },
  { column: 'TildaH' as const, proposed: 'Audrey', current: 'N/A', confidence: 'low' as const },
];

test('TIER2_COLUMNS contains exactly the eight proposable columns', () => {
  assert.deepEqual([...TIER2_COLUMNS].sort(), [
    'Film', 'Kevs_Question', 'MMM_Count', 'Thats_Great_Count',
    'TildaCorey', 'TildaGuest', 'TildaH', 'TildaJason',
  ]);
});

test('isTier2Column rejects columns Tier 2 must never touch', () => {
  assert.equal(isTier2Column('Kevs_Question'), true);
  assert.equal(isTier2Column('Notable_Moments'), false);
  assert.equal(isTier2Column('H_Flex'), false);
  assert.equal(isTier2Column('Reviewer'), false);
  assert.equal(isTier2Column('Length'), false);
});

test('buildProposals stamps every field pending', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  assert.equal(doc.episode, '317');
  assert.equal(doc.film, 'Barton Fink (1991)');
  assert.equal(doc.createdAt, '2026-08-03T00:00:00.000Z');
  assert.equal(doc.proposals.length, 2);
  assert.ok(doc.proposals.every(p => p.status === 'pending'));
});

test('applyDecisions updates only the named columns', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  const next = applyDecisions(doc, { Kevs_Question: 'accepted' });
  assert.equal(next.proposals.find(p => p.column === 'Kevs_Question')?.status, 'accepted');
  assert.equal(next.proposals.find(p => p.column === 'TildaH')?.status, 'pending');
});

test('applyDecisions does not mutate the input document', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  applyDecisions(doc, { Kevs_Question: 'rejected' });
  assert.equal(doc.proposals[0].status, 'pending');
});

test('applyDecisions ignores a column not present in the document', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  const next = applyDecisions(doc, { MMM_Count: 'accepted' });
  assert.equal(next.proposals.length, 2);
});

test('acceptedRow returns only accepted fields', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  const decided = applyDecisions(doc, { Kevs_Question: 'accepted', TildaH: 'rejected' });
  assert.deepEqual(acceptedRow(decided), { Kevs_Question: 'What is your favourite?' });
});

test('acceptedRow is empty when nothing was accepted', () => {
  const doc = buildProposals('317', 'Barton Fink (1991)', '2026-08-03T00:00:00.000Z', FIELDS);
  assert.deepEqual(acceptedRow(doc), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/pdc-proposals.test.ts`
Expected: FAIL — `Cannot find module './pdc-proposals'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/pdc-proposals.ts`:

```typescript
/**
 * Tier 2 proposal store.
 *
 * Tier 2 never writes to the sheet. It writes a proposal document to Blob;
 * a human accepts or rejects each field in /podreview, and only that
 * acceptance produces a sheet write.
 *
 * Pure helpers are separated from the Blob I/O so they can be unit-tested
 * without credentials, matching src/lib/transcription-report.ts.
 */
import { put, list } from '@vercel/blob';

const PREFIX = 'pdc-proposals/';

export type ProposalStatus = 'pending' | 'accepted' | 'rejected';
export type ProposalConfidence = 'high' | 'low';

/** The only columns Tier 2 is permitted to propose. */
export const TIER2_COLUMNS = [
  'Film',
  'MMM_Count',
  'Thats_Great_Count',
  'Kevs_Question',
  'TildaH',
  'TildaJason',
  'TildaGuest',
  'TildaCorey',
] as const;

export type Tier2Column = (typeof TIER2_COLUMNS)[number];

export function isTier2Column(key: string): key is Tier2Column {
  return (TIER2_COLUMNS as readonly string[]).includes(key);
}

export interface FieldProposal {
  column: Tier2Column;
  /** The value Tier 2 derived. */
  proposed: string;
  /** The sheet's value at proposal time, for side-by-side display. */
  current: string | null;
  confidence: ProposalConfidence;
  /** A quote or turn reference backing the value, shown to the reviewer. */
  evidence?: string;
  status: ProposalStatus;
}

export interface EpisodeProposals {
  episode: string;
  film: string;
  createdAt: string;
  proposals: FieldProposal[];
}

export function buildProposals(
  episode: string,
  film: string,
  createdAt: string,
  fields: Array<Omit<FieldProposal, 'status'>>
): EpisodeProposals {
  return {
    episode,
    film,
    createdAt,
    proposals: fields.map(f => ({ ...f, status: 'pending' as ProposalStatus })),
  };
}

/** Return a copy with the named columns' statuses updated. Never mutates. */
export function applyDecisions(
  doc: EpisodeProposals,
  decisions: Record<string, ProposalStatus>
): EpisodeProposals {
  return {
    ...doc,
    proposals: doc.proposals.map(p =>
      decisions[p.column] ? { ...p, status: decisions[p.column] } : { ...p }
    ),
  };
}

/** The sheet row implied by the accepted proposals. */
export function acceptedRow(doc: EpisodeProposals): Partial<Record<Tier2Column, string>> {
  const row: Partial<Record<Tier2Column, string>> = {};
  for (const p of doc.proposals) {
    if (p.status === 'accepted') row[p.column] = p.proposed;
  }
  return row;
}

// ── Blob I/O ──

/**
 * One document per episode, not per run.
 *
 * The spec sketched `ep{N}_{timestamp}.json`, but ingest re-runs on every
 * cleanup pass, and a timestamped key would accumulate duplicate proposal sets
 * for the same episode. Overwriting keeps re-ingest idempotent.
 */
function keyFor(episode: string): string {
  return `${PREFIX}ep${episode}.json`;
}

export async function saveProposals(doc: EpisodeProposals): Promise<void> {
  await put(keyFor(doc.episode), JSON.stringify(doc, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function loadProposals(episode: string): Promise<EpisodeProposals | null> {
  const key = keyFor(episode);
  const { blobs } = await list({ prefix: key });
  const match = blobs.find(b => b.pathname === key);
  if (!match) return null;
  try {
    const resp = await fetch(match.url, { cache: 'no-store' });
    if (!resp.ok) return null;
    return (await resp.json()) as EpisodeProposals;
  } catch {
    return null;
  }
}

/** Every document that still has at least one pending field, newest first. */
export async function listPendingProposals(): Promise<EpisodeProposals[]> {
  const { blobs } = await list({ prefix: PREFIX });
  const docs: EpisodeProposals[] = [];
  for (const blob of blobs) {
    if (!blob.pathname.endsWith('.json')) continue;
    try {
      const resp = await fetch(blob.url, { cache: 'no-store' });
      if (resp.ok) docs.push((await resp.json()) as EpisodeProposals);
    } catch {
      // skip corrupt entries
    }
  }
  return docs
    .filter(d => d.proposals.some(p => p.status === 'pending'))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/pdc-proposals.test.ts`
Expected: PASS — 8 tests passing

- [ ] **Step 5: Add the test script and verify**

In `package.json`, add to `"scripts"` after `"test:pdc"`:

```json
"test:tier2": "node --import tsx --test src/lib/pdc-proposals.test.ts",
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:tier2` — Expected: 8 tests passing

- [ ] **Step 6: Commit**

```bash
git add src/lib/pdc-proposals.ts src/lib/pdc-proposals.test.ts package.json
git commit -m "feat(tier2): add proposal store"
```

---

### Task 2: Deterministic counters

`MMM_Count` and `Thats_Great_Count` are countable without a model. This task builds the counting rule and makes it explicit and testable. It does **not** wire the counters into proposals — Task 3 measures their accuracy first.

**Files:**
- Create: `src/lib/tier2-counters.ts`
- Create: `src/lib/tier2-counters.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `DialogueEntry` from `src/types/transcript.ts` (shape: `{ name: string; timestamp: string; text: string }`).
- Produces:
  - `interface CountResult { total: number; bySpeaker: Record<string, number> }`
  - `countMmm(dialogues: DialogueEntry[]): CountResult`
  - `countThatsGreat(dialogues: DialogueEntry[]): CountResult`
  - `MMM_PATTERN: RegExp` and `THATS_GREAT_PATTERN: RegExp` (exported so the calibration report can print the rule it measured)

- [ ] **Step 1: Write the failing test**

Create `src/lib/tier2-counters.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countMmm, countThatsGreat } from './tier2-counters';

const turn = (name: string, text: string) => ({ name, timestamp: '00:00', text });

test('countMmm counts standalone mm/mmm/mmmm', () => {
  const r = countMmm([turn('Jason', 'Mmm. That shot. Mm.')]);
  assert.equal(r.total, 2);
});

test('countMmm does not match m inside a word', () => {
  const r = countMmm([turn('Jason', 'Communism and mammoth summer')]);
  assert.equal(r.total, 0);
});

test('countMmm does not match hmm or mm-hmm', () => {
  // "hmm" is a different vocalisation and "mm-hmm" is assent, not the bit.
  const r = countMmm([turn('Jason', 'Hmm, mm-hmm, hmmm')]);
  assert.equal(r.total, 0);
});

test('countMmm is case insensitive and counts repeats within one turn', () => {
  const r = countMmm([turn('Haitch', 'mmm MMM Mmmm')]);
  assert.equal(r.total, 3);
});

test('countMmm attributes per speaker', () => {
  const r = countMmm([turn('Jason', 'Mmm'), turn('Haitch', 'Mmm mmm')]);
  assert.equal(r.total, 3);
  assert.deepEqual(r.bySpeaker, { Jason: 1, Haitch: 2 });
});

test('countMmm returns zero for an empty transcript', () => {
  const r = countMmm([]);
  assert.equal(r.total, 0);
  assert.deepEqual(r.bySpeaker, {});
});

test("countThatsGreat matches straight and curly apostrophes and bare thats", () => {
  const r = countThatsGreat([
    turn('Jason', "That's great."),
    turn('Jason', 'That’s great!'),
    turn('Jason', 'Thats great'),
  ]);
  assert.equal(r.total, 3);
});

test('countThatsGreat tolerates extra whitespace between the words', () => {
  const r = countThatsGreat([turn('Jason', "that's   great")]);
  assert.equal(r.total, 1);
});

test('countThatsGreat does not match a longer word starting with great', () => {
  const r = countThatsGreat([turn('Jason', "That's greatness itself")]);
  assert.equal(r.total, 0);
});

test('countThatsGreat attributes per speaker', () => {
  const r = countThatsGreat([turn('Haitch', "That's great"), turn('Jason', "that's great, that's great")]);
  assert.equal(r.total, 3);
  assert.deepEqual(r.bySpeaker, { Haitch: 1, Jason: 2 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/tier2-counters.test.ts`
Expected: FAIL — `Cannot find module './tier2-counters'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/tier2-counters.ts`:

```typescript
/**
 * Deterministic counts for the two recurring-tic columns.
 *
 * These are not LLM calls — the rule is a regex, so it must be written down,
 * testable, and measurable against the ~300 hand-counted historical rows
 * before anyone trusts it. See scripts/calibrate-counters.ts.
 *
 * Known ambiguity, deliberately not resolved in code:
 *  - ASR renders the tic as "mm", "mmm", "mmmm", and sometimes "hmm". We count
 *    only bare m-runs, because "hmm" is a different vocalisation and "mm-hmm"
 *    is assent rather than the bit. If calibration shows we undercount, widen
 *    the pattern here and re-measure — do not special-case at the call site.
 *  - "that's great" has a literal sense as well as the catchphrase sense. We
 *    count both; calibration reveals the bias.
 */
import type { DialogueEntry } from '@/types/transcript';

/** Bare runs of two or more m's, as a whole word. Excludes hmm and mm-hmm. */
export const MMM_PATTERN = /(?<![a-z-])m{2,}(?![a-z-])/gi;

/** "that's great" / "thats great" / curly apostrophe, any inter-word spacing. */
export const THATS_GREAT_PATTERN = /\bthat[’']?s\s+great\b/gi;

export interface CountResult {
  total: number;
  bySpeaker: Record<string, number>;
}

function countWith(dialogues: DialogueEntry[], pattern: RegExp): CountResult {
  const bySpeaker: Record<string, number> = {};
  let total = 0;

  for (const turn of dialogues) {
    // Fresh lastIndex per turn: the pattern is global and stateful.
    const matches = String(turn.text ?? '').match(new RegExp(pattern.source, pattern.flags));
    const n = matches ? matches.length : 0;
    if (n === 0) continue;
    total += n;
    bySpeaker[turn.name] = (bySpeaker[turn.name] ?? 0) + n;
  }

  return { total, bySpeaker };
}

export function countMmm(dialogues: DialogueEntry[]): CountResult {
  return countWith(dialogues, MMM_PATTERN);
}

export function countThatsGreat(dialogues: DialogueEntry[]): CountResult {
  return countWith(dialogues, THATS_GREAT_PATTERN);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/tier2-counters.test.ts`
Expected: PASS — 10 tests passing

If `countMmm` matches `hmm`, the lookbehind is wrong: `(?<![a-z-])` must reject the `h`. Fix the pattern, not the test.

- [ ] **Step 5: Extend the test script and verify**

In `package.json`, change `"test:tier2"` to:

```json
"test:tier2": "node --import tsx --test src/lib/pdc-proposals.test.ts src/lib/tier2-counters.test.ts",
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:tier2` — Expected: 18 tests passing

- [ ] **Step 6: Commit**

```bash
git add src/lib/tier2-counters.ts src/lib/tier2-counters.test.ts package.json
git commit -m "feat(tier2): add deterministic MMM and That's Great counters"
```

---

### Task 3: Counter calibration

The gate. Runs the Task 2 counters over every transcript that has a hand-entered count and reports how close they are. Until this is run and its output accepted, the counters produce no proposals.

**Files:**
- Create: `scripts/calibrate-counters.ts`
- Create: `scripts/calibrate-counters.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `countMmm`, `countThatsGreat`, `CountResult` (Task 2); `loadEpisodeMetadata` from `src/lib/metadata-store`; `Transcript` from `src/types/transcript`.
- Produces: `summarise(rows: CalibrationRow[]): CalibrationSummary` and the two interfaces below.

- [ ] **Step 1: Write the failing test**

Create `scripts/calibrate-counters.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise } from './calibrate-counters';

const rows = [
  { episode: '1', field: 'MMM_Count', expected: 10, actual: 10 },
  { episode: '2', field: 'MMM_Count', expected: 10, actual: 12 },
  { episode: '3', field: 'MMM_Count', expected: 10, actual: 7 },
];

test('summarise reports count, exact matches, and mean absolute error', () => {
  const s = summarise(rows);
  assert.equal(s.n, 3);
  assert.equal(s.exact, 1);
  assert.equal(s.meanAbsoluteError, (0 + 2 + 3) / 3);
});

test('summarise reports mean signed error so bias direction is visible', () => {
  // +2 and -3 cancel to -1/3: the rule undercounts slightly on average.
  assert.equal(summarise(rows).meanSignedError, (0 + 2 - 3) / 3);
});

test('summarise reports the share within a tolerance of 2', () => {
  const s = summarise(rows);
  assert.equal(s.withinTwo, 2 / 3);
});

test('summarise handles an empty set without dividing by zero', () => {
  const s = summarise([]);
  assert.equal(s.n, 0);
  assert.equal(s.meanAbsoluteError, 0);
  assert.equal(s.meanSignedError, 0);
  assert.equal(s.withinTwo, 0);
});

test('summarise treats a perfect rule as exact for every row', () => {
  const s = summarise([
    { episode: '1', field: 'MMM_Count', expected: 4, actual: 4 },
    { episode: '2', field: 'MMM_Count', expected: 9, actual: 9 },
  ]);
  assert.equal(s.exact, 2);
  assert.equal(s.meanAbsoluteError, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/calibrate-counters.test.ts`
Expected: FAIL — `Cannot find module './calibrate-counters'`

- [ ] **Step 3: Write the implementation**

Create `scripts/calibrate-counters.ts`:

```typescript
#!/usr/bin/env node
/**
 * calibrate-counters.ts — measure the Tier 2 counters against hand-entered history.
 *
 * The counters do not propose anything until this has been run and its output
 * accepted. ~300 episodes carry a human count; that is the eval set.
 *
 * Usage:
 *   npm run calibrate-counters
 *   npm run calibrate-counters -- --field=MMM_Count
 *   npm run calibrate-counters -- --worst=20
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import { countMmm, countThatsGreat } from '../src/lib/tier2-counters';
import type { Transcript } from '../src/types/transcript';

const __filename = fileURLToPath(import.meta.url);

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

export interface CalibrationRow {
  episode: string;
  field: 'MMM_Count' | 'Thats_Great_Count' | string;
  expected: number;
  actual: number;
}

export interface CalibrationSummary {
  n: number;
  exact: number;
  meanAbsoluteError: number;
  meanSignedError: number;
  /** Share of rows within +/- 2 of the human count. */
  withinTwo: number;
}

export function summarise(rows: CalibrationRow[]): CalibrationSummary {
  if (rows.length === 0) {
    return { n: 0, exact: 0, meanAbsoluteError: 0, meanSignedError: 0, withinTwo: 0 };
  }
  let exact = 0;
  let absSum = 0;
  let signedSum = 0;
  let within = 0;
  for (const r of rows) {
    const d = r.actual - r.expected;
    if (d === 0) exact++;
    if (Math.abs(d) <= 2) within++;
    absSum += Math.abs(d);
    signedSum += d;
  }
  return {
    n: rows.length,
    exact,
    meanAbsoluteError: absSum / rows.length,
    meanSignedError: signedSum / rows.length,
    withinTwo: within / rows.length,
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const hit = args.find(a => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const only = getArg(args, '--field');
  const worstN = parseInt(getArg(args, '--worst') ?? '15', 10);

  const { loadEpisodeMetadata } = await import('../src/lib/metadata-store');
  const metadata = loadEpisodeMetadata();
  const transcriptsDir = path.resolve(__dirname, '..', 'transcripts');

  const rows: CalibrationRow[] = [];
  let missingTranscripts = 0;

  for (const ep of metadata) {
    const file = path.join(transcriptsDir, `episode_${ep.episode}.json`);
    if (!fs.existsSync(file)) {
      missingTranscripts++;
      continue;
    }
    let transcript: Transcript;
    try {
      transcript = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const dialogues = transcript.dialogues ?? [];

    if ((!only || only === 'MMM_Count') && ep.mmmCount > 0) {
      rows.push({
        episode: String(ep.episode),
        field: 'MMM_Count',
        expected: ep.mmmCount,
        actual: countMmm(dialogues).total,
      });
    }
    if ((!only || only === 'Thats_Great_Count') && ep.thatsGreatCount > 0) {
      rows.push({
        episode: String(ep.episode),
        field: 'Thats_Great_Count',
        expected: ep.thatsGreatCount,
        actual: countThatsGreat(dialogues).total,
      });
    }
  }

  console.log(`Transcripts missing on disk (skipped): ${missingTranscripts}`);
  console.log(`Rows with a human count: ${rows.length}\n`);

  for (const field of ['MMM_Count', 'Thats_Great_Count']) {
    const subset = rows.filter(r => r.field === field);
    if (subset.length === 0) continue;
    const s = summarise(subset);
    console.log(`--- ${field} ---`);
    console.log(`  episodes measured : ${s.n}`);
    console.log(`  exact matches     : ${s.exact} (${((s.exact / s.n) * 100).toFixed(1)}%)`);
    console.log(`  within +/-2       : ${(s.withinTwo * 100).toFixed(1)}%`);
    console.log(`  mean abs error    : ${s.meanAbsoluteError.toFixed(2)}`);
    console.log(`  mean signed error : ${s.meanSignedError.toFixed(2)} (negative = undercounting)`);

    const worst = [...subset]
      .sort((a, b) => Math.abs(b.actual - b.expected) - Math.abs(a.actual - a.expected))
      .slice(0, worstN);
    console.log(`  worst ${worst.length}:`);
    for (const r of worst) {
      console.log(`    ep ${r.episode.padStart(5)}  human ${String(r.expected).padStart(4)}  derived ${String(r.actual).padStart(4)}  diff ${r.actual - r.expected > 0 ? '+' : ''}${r.actual - r.expected}`);
    }
    console.log();
  }
}

if (process.argv[1] === __filename) {
  main().catch(err => {
    console.error('[calibrate-counters] Fatal error:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test scripts/calibrate-counters.test.ts`
Expected: PASS — 5 tests passing

- [ ] **Step 5: Run the calibration and record the result**

In `package.json`, add to `"scripts"`:

```json
"calibrate-counters": "node --import tsx ./scripts/calibrate-counters.ts",
```

Run: `npm run calibrate-counters`

This reads only local files — no network, no credentials, no writes. Capture the full output in your task report. **Do not tune the patterns to improve the numbers in this task.** The purpose is an honest first measurement; changing the rule to fit is a separate, deliberate decision the human makes after seeing it.

- [ ] **Step 6: Extend the test script and verify**

In `package.json`, change `"test:tier2"` to:

```json
"test:tier2": "node --import tsx --test src/lib/pdc-proposals.test.ts src/lib/tier2-counters.test.ts scripts/calibrate-counters.test.ts",
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:tier2` — Expected: 23 tests passing

- [ ] **Step 7: Commit**

```bash
git add scripts/calibrate-counters.ts scripts/calibrate-counters.test.ts package.json
git commit -m "feat(tier2): add counter calibration against hand-entered history"
```

---

### Task 4: Kev and Tilda extraction

**Files:**
- Create: `src/lib/tier2-extract.ts`
- Create: `src/lib/tier2-extract.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `DialogueEntry`, `Transcript` from `src/types/transcript.ts`.
- Produces:
  - `interface KevExtraction { question: string | null; evidence: string | null }`
  - `interface TildaExtraction { tildaH: string | null; tildaJason: string | null; tildaGuest: string | null; tildaCorey: string | null }`
  - `KEV_SPEAKER_NAMES: readonly string[]`
  - `findKevSegment(dialogues: DialogueEntry[]): DialogueEntry[]`
  - `renderTranscriptForPrompt(dialogues: DialogueEntry[], maxChars?: number): string`
  - `parseKevResponse(raw: string): KevExtraction`
  - `parseTildaResponse(raw: string): TildaExtraction`
  - `extractKevQuestion(transcript: Transcript): Promise<KevExtraction>`
  - `extractTildaPicks(transcript: Transcript): Promise<TildaExtraction>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/tier2-extract.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findKevSegment,
  renderTranscriptForPrompt,
  parseKevResponse,
  parseTildaResponse,
} from './tier2-extract';

const turn = (name: string, text: string, timestamp = '00:00') => ({ name, timestamp, text });

test('findKevSegment returns the Kev turns plus following context', () => {
  const dialogues = [
    turn('Jason', 'Before'),
    turn('Kev', 'Hey fellas, my question this week'),
    turn('Haitch', 'Good question Kev'),
    turn('Jason', 'I would say Walken'),
  ];
  const seg = findKevSegment(dialogues);
  assert.ok(seg.length >= 2);
  assert.equal(seg[0].name, 'Kev');
  assert.ok(seg.some(t => t.text.includes('Walken')));
});

test('findKevSegment matches the mapped voicemail speaker label', () => {
  const seg = findKevSegment([turn('kev voicemail', 'My question is')]);
  assert.equal(seg.length, 1);
});

test('findKevSegment is case insensitive on the speaker name', () => {
  assert.equal(findKevSegment([turn('KEV', 'question')]).length, 1);
});

test('findKevSegment returns empty when Kev never speaks', () => {
  assert.deepEqual(findKevSegment([turn('Jason', 'no kev here')]), []);
});

test('findKevSegment does not match a host who merely says the word kev', () => {
  assert.deepEqual(findKevSegment([turn('Jason', 'Kev asked us something')]), []);
});

test('renderTranscriptForPrompt labels each turn with speaker and timestamp', () => {
  const out = renderTranscriptForPrompt([turn('Jason', 'Hello', '12:45')]);
  assert.match(out, /\[12:45\] Jason: Hello/);
});

test('renderTranscriptForPrompt truncates at a turn boundary, not mid-turn', () => {
  const dialogues = [turn('A', 'x'.repeat(50)), turn('B', 'y'.repeat(50))];
  const out = renderTranscriptForPrompt(dialogues, 60);
  assert.ok(out.includes('x'.repeat(50)));
  assert.ok(!out.includes('y'.repeat(50)));
});

test('parseKevResponse reads a well-formed JSON object', () => {
  const r = parseKevResponse('{"question":"What is your favourite?","evidence":"Kev at 12:45"}');
  assert.equal(r.question, 'What is your favourite?');
  assert.equal(r.evidence, 'Kev at 12:45');
});

test('parseKevResponse tolerates a fenced code block', () => {
  const r = parseKevResponse('```json\n{"question":"Q","evidence":null}\n```');
  assert.equal(r.question, 'Q');
  assert.equal(r.evidence, null);
});

test('parseKevResponse returns nulls on unparseable output rather than throwing', () => {
  const r = parseKevResponse('I could not find a question.');
  assert.equal(r.question, null);
  assert.equal(r.evidence, null);
});

test('parseKevResponse treats an empty or N/A question as null', () => {
  assert.equal(parseKevResponse('{"question":"","evidence":null}').question, null);
  assert.equal(parseKevResponse('{"question":"N/A","evidence":null}').question, null);
});

test('parseTildaResponse maps all four roles', () => {
  const r = parseTildaResponse('{"tildaH":"Audrey","tildaJason":"Barton","tildaGuest":null,"tildaCorey":null}');
  assert.equal(r.tildaH, 'Audrey');
  assert.equal(r.tildaJason, 'Barton');
  assert.equal(r.tildaGuest, null);
  assert.equal(r.tildaCorey, null);
});

test('parseTildaResponse treats missing keys as null rather than undefined', () => {
  const r = parseTildaResponse('{"tildaH":"Audrey"}');
  assert.equal(r.tildaJason, null);
  assert.equal(r.tildaGuest, null);
  assert.equal(r.tildaCorey, null);
});

test('parseTildaResponse returns all nulls on unparseable output', () => {
  const r = parseTildaResponse('no json here');
  assert.deepEqual(r, { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/tier2-extract.test.ts`
Expected: FAIL — `Cannot find module './tier2-extract'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/tier2-extract.ts`:

```typescript
/**
 * Tier 2 LLM extraction: Kev's question and the Tilda picks.
 *
 * Prompt construction and response parsing are pure and unit-tested; the
 * Anthropic call is a thin wrapper around them. A model that returns garbage
 * must yield nulls, never an exception — a missing proposal is fine, a crashed
 * ingest step is not.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DialogueEntry, Transcript } from '@/types/transcript';

const MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_CHARS = 120_000;

/** Speaker labels the Kev voicemail segment appears under after speaker mapping. */
export const KEV_SPEAKER_NAMES = ['kev voicemail', 'kev'] as const;

/** Turns to keep after Kev stops speaking, so the hosts' answers are in context. */
const KEV_TRAILING_TURNS = 12;

export interface KevExtraction {
  question: string | null;
  evidence: string | null;
}

export interface TildaExtraction {
  tildaH: string | null;
  tildaJason: string | null;
  tildaGuest: string | null;
  tildaCorey: string | null;
}

// ── Pure helpers ──

function isKevSpeaker(name: string): boolean {
  return (KEV_SPEAKER_NAMES as readonly string[]).includes(String(name ?? '').trim().toLowerCase());
}

/**
 * The Kev voicemail segment: from Kev's first turn through the following
 * discussion. Matches on the SPEAKER label only — a host saying the word
 * "Kev" is not the segment.
 */
export function findKevSegment(dialogues: DialogueEntry[]): DialogueEntry[] {
  const first = dialogues.findIndex(t => isKevSpeaker(t.name));
  if (first === -1) return [];
  let last = first;
  for (let i = first; i < dialogues.length; i++) {
    if (isKevSpeaker(dialogues[i].name)) last = i;
  }
  return dialogues.slice(first, Math.min(dialogues.length, last + 1 + KEV_TRAILING_TURNS));
}

/** Render turns for a prompt, truncating at a turn boundary. */
export function renderTranscriptForPrompt(
  dialogues: DialogueEntry[],
  maxChars = DEFAULT_MAX_CHARS
): string {
  const lines: string[] = [];
  let used = 0;
  for (const t of dialogues) {
    const line = `[${t.timestamp}] ${t.name}: ${t.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cleanValue(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '' || t.toUpperCase() === 'N/A' || t.toLowerCase() === 'null') return null;
  return t;
}

export function parseKevResponse(raw: string): KevExtraction {
  const obj = extractJson(raw);
  if (!obj) return { question: null, evidence: null };
  return { question: cleanValue(obj.question), evidence: cleanValue(obj.evidence) };
}

export function parseTildaResponse(raw: string): TildaExtraction {
  const obj = extractJson(raw);
  if (!obj) return { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null };
  return {
    tildaH: cleanValue(obj.tildaH),
    tildaJason: cleanValue(obj.tildaJason),
    tildaGuest: cleanValue(obj.tildaGuest),
    tildaCorey: cleanValue(obj.tildaCorey),
  };
}

// ── Anthropic calls ──

async function ask(prompt: string): Promise<string> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = message.content[0];
  return block && block.type === 'text' ? block.text : '';
}

export async function extractKevQuestion(transcript: Transcript): Promise<KevExtraction> {
  const segment = findKevSegment(transcript.dialogues ?? []);
  if (segment.length === 0) return { question: null, evidence: null };

  const prompt = `"Kev" is a listener of the Escape Hatch podcast who leaves a voicemail with one quirky question for the hosts each week. Below is the portion of an episode transcript containing his voicemail and the hosts' reaction.

Extract the single question Kev asked. Return the question as he phrased it, lightly cleaned of transcription artefacts. Do not answer it, summarise the hosts' responses, or invent a question.

If Kev left a voicemail but did not actually ask a question, return null.

Respond with JSON only, no prose:
{"question": "<the question, or null>", "evidence": "<a short quote from Kev's voicemail, or null>"}

Transcript:
${renderTranscriptForPrompt(segment)}`;

  try {
    return parseKevResponse(await ask(prompt));
  } catch {
    return { question: null, evidence: null };
  }
}

export async function extractTildaPicks(transcript: Transcript): Promise<TildaExtraction> {
  const dialogues = transcript.dialogues ?? [];
  if (dialogues.length === 0) {
    return { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null };
  }

  const prompt = `The Escape Hatch podcast has a recurring bit: each participant names which role in the week's film Tilda Swinton should have played. The hosts are Haitch and Jason. Some episodes also have a guest, and some have a listener named Corey.

Read the transcript below and extract each participant's Tilda pick — the role or character they named, in their own words.

Rules:
- Only report a pick that was actually stated. If someone did not give one, return null for them.
- A guest or Corey is often absent. Null is the correct answer then, not a guess.
- Do not merge two people's picks or attribute a pick to the wrong speaker.

Respond with JSON only, no prose:
{"tildaH": "<Haitch's pick or null>", "tildaJason": "<Jason's pick or null>", "tildaGuest": "<the guest's pick or null>", "tildaCorey": "<Corey's pick or null>"}

Transcript:
${renderTranscriptForPrompt(dialogues)}`;

  try {
    return parseTildaResponse(await ask(prompt));
  } catch {
    return { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/tier2-extract.test.ts`
Expected: PASS — 14 tests passing

- [ ] **Step 5: Extend the test script and verify**

In `package.json`, change `"test:tier2"` to:

```json
"test:tier2": "node --import tsx --test src/lib/pdc-proposals.test.ts src/lib/tier2-counters.test.ts src/lib/tier2-extract.test.ts scripts/calibrate-counters.test.ts",
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:tier2` — Expected: 37 tests passing

- [ ] **Step 6: Commit**

```bash
git add src/lib/tier2-extract.ts src/lib/tier2-extract.test.ts package.json
git commit -m "feat(tier2): add Kev and Tilda extraction"
```

---

### Task 5: Proposal generation and workflow wiring

**Files:**
- Create: `scripts/generate-proposals.ts`
- Create: `scripts/generate-proposals.test.ts`
- Modify: `.github/workflows/ingest-episode.yml` (add a step after "Upload updated search index")
- Modify: `scripts/notify-discord.ts` (add a `proposals-ready` event)
- Modify: `package.json`

**Interfaces:**
- Consumes: `buildProposals`, `saveProposals`, `FieldProposal`, `Tier2Column` (Task 1); `countMmm`, `countThatsGreat` (Task 2); `extractKevQuestion`, `extractTildaPicks` (Task 4); `loadTranscript` from `src/lib/blob-storage`; `getEpisodeByNumber` from `src/lib/metadata-store`; `parseEpisodeId` from `src/lib/episode-format`; `searchTmdb`, `fetchTmdbDetails` from `src/lib/episode-sources`; `pickTmdbMatch` from `scripts/populate-tier1.ts` (exported there by Tier 1's final-review fix); `WebhookPayload`, `AMBER` from `scripts/notify-discord.ts`.
- Produces:
  - `buildProposalFields(input: ProposalInput): Array<Omit<FieldProposal, 'status'>>`
  - `interface ProposalInput { current: CurrentValues; kev: KevExtraction; tilda: TildaExtraction; mmm: number | null; thatsGreat: number | null; canonicalFilm: string | null }`
  - `interface CurrentValues { film: string; kevsQuestion: string; tildaH: string; tildaJason: string; tildaGuest: string | null; tildaCorey: string | null; mmmCount: number; thatsGreatCount: number }`
  - `buildProposalsReadyMessage(episode: string, film: string, count: number, baseUrl: string): WebhookPayload` (in `scripts/notify-discord.ts`)

- [ ] **Step 1: Write the failing test**

Create `scripts/generate-proposals.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProposalFields } from './generate-proposals';

const CURRENT = {
  film: 'Barton Fink (1991)',
  kevsQuestion: 'N/A',
  tildaH: 'N/A',
  tildaJason: 'N/A',
  tildaGuest: null,
  tildaCorey: null,
  mmmCount: 0,
  thatsGreatCount: 0,
};

const EMPTY_TILDA = { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null };

test('a Kev question becomes a high-confidence proposal carrying its evidence', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: 'What is your favourite?', evidence: 'Kev at 12:45' },
    tilda: EMPTY_TILDA,
    mmm: null,
    thatsGreat: null,
    canonicalFilm: null,
  });
  const kev = f.find(p => p.column === 'Kevs_Question');
  assert.equal(kev?.proposed, 'What is your favourite?');
  assert.equal(kev?.confidence, 'high');
  assert.equal(kev?.evidence, 'Kev at 12:45');
  assert.equal(kev?.current, null, 'sheet "N/A" is surfaced as null, not the literal string');
});

test('a null extraction produces no proposal for that column', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: null, evidence: null },
    tilda: EMPTY_TILDA,
    mmm: null,
    thatsGreat: null,
    canonicalFilm: null,
  });
  assert.equal(f.length, 0);
});

test('Tilda guest and Corey are low confidence; hosts are high', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: null, evidence: null },
    tilda: { tildaH: 'Audrey', tildaJason: 'Barton', tildaGuest: 'Charlie', tildaCorey: null },
    mmm: null,
    thatsGreat: null,
    canonicalFilm: null,
  });
  assert.equal(f.find(p => p.column === 'TildaH')?.confidence, 'high');
  assert.equal(f.find(p => p.column === 'TildaJason')?.confidence, 'high');
  assert.equal(f.find(p => p.column === 'TildaGuest')?.confidence, 'low');
  assert.equal(f.find(p => p.column === 'TildaCorey'), undefined);
});

test('counters produce no proposal when null (measure-only mode)', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: null, evidence: null },
    tilda: EMPTY_TILDA,
    mmm: null,
    thatsGreat: null,
    canonicalFilm: null,
  });
  assert.equal(f.find(p => p.column === 'MMM_Count'), undefined);
});

test('counters propose as low confidence when enabled', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: null, evidence: null },
    tilda: EMPTY_TILDA,
    mmm: 7,
    thatsGreat: 3,
    canonicalFilm: null,
  });
  assert.equal(f.find(p => p.column === 'MMM_Count')?.proposed, '7');
  assert.equal(f.find(p => p.column === 'MMM_Count')?.confidence, 'low');
  assert.equal(f.find(p => p.column === 'Thats_Great_Count')?.proposed, '3');
});

test('a canonical film title matching the sheet produces no proposal', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: null, evidence: null },
    tilda: EMPTY_TILDA,
    mmm: null,
    thatsGreat: null,
    canonicalFilm: 'Barton Fink (1991)',
  });
  assert.equal(f.find(p => p.column === 'Film'), undefined);
});

test('a differing canonical film title proposes the correction with the current value', () => {
  const f = buildProposalFields({
    current: { ...CURRENT, film: 'Barton Fink' },
    kev: { question: null, evidence: null },
    tilda: EMPTY_TILDA,
    mmm: null,
    thatsGreat: null,
    canonicalFilm: 'Barton Fink (1991)',
  });
  const film = f.find(p => p.column === 'Film');
  assert.equal(film?.proposed, 'Barton Fink (1991)');
  assert.equal(film?.current, 'Barton Fink');
});

test('an extraction identical to the existing sheet value produces no proposal', () => {
  const f = buildProposalFields({
    current: { ...CURRENT, kevsQuestion: 'What is your favourite?' },
    kev: { question: 'What is your favourite?', evidence: null },
    tilda: EMPTY_TILDA,
    mmm: null,
    thatsGreat: null,
    canonicalFilm: null,
  });
  assert.equal(f.find(p => p.column === 'Kevs_Question'), undefined);
});

test('every proposed column is one Tier 2 is permitted to touch', () => {
  const f = buildProposalFields({
    current: CURRENT,
    kev: { question: 'Q', evidence: null },
    tilda: { tildaH: 'A', tildaJason: 'B', tildaGuest: 'C', tildaCorey: 'D' },
    mmm: 1,
    thatsGreat: 2,
    canonicalFilm: 'Different (2000)',
  });
  const allowed = ['Film', 'MMM_Count', 'Thats_Great_Count', 'Kevs_Question', 'TildaH', 'TildaJason', 'TildaGuest', 'TildaCorey'];
  for (const p of f) assert.ok(allowed.includes(p.column), `${p.column} is not a Tier 2 column`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/generate-proposals.test.ts`
Expected: FAIL — `Cannot find module './generate-proposals'`

- [ ] **Step 3: Write the implementation**

Create `scripts/generate-proposals.ts`:

```typescript
#!/usr/bin/env node
/**
 * generate-proposals.ts — build Tier 2 proposals for one episode.
 *
 * Runs after ingest, so the transcript is speaker-mapped. Writes proposals to
 * Blob; NEVER writes to the sheet. A human accepts or rejects each field in
 * /podreview and that acceptance is the only thing that touches the sheet.
 *
 * Usage:
 *   npm run generate-proposals -- --episode=317
 *   npm run generate-proposals -- --episode=317 --dry-run
 */
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import {
  buildProposals,
  saveProposals,
  type FieldProposal,
} from '../src/lib/pdc-proposals';
import { countMmm, countThatsGreat } from '../src/lib/tier2-counters';
import {
  extractKevQuestion,
  extractTildaPicks,
  type KevExtraction,
  type TildaExtraction,
} from '../src/lib/tier2-extract';
import { parseEpisodeId } from '../src/lib/episode-format';
import { searchTmdb, fetchTmdbDetails } from '../src/lib/episode-sources';
import { pickTmdbMatch } from './populate-tier1';

const __filename = fileURLToPath(import.meta.url);

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

/** Counters propose only once calibration has been run and accepted. */
const COUNTERS_ENABLED = process.env.TIER2_COUNTERS_ENABLED === 'true';

function log(msg: string) {
  console.log(`[generate-proposals] ${msg}`);
}

export interface CurrentValues {
  film: string;
  kevsQuestion: string;
  tildaH: string;
  tildaJason: string;
  tildaGuest: string | null;
  tildaCorey: string | null;
  mmmCount: number;
  thatsGreatCount: number;
}

export interface ProposalInput {
  current: CurrentValues;
  kev: KevExtraction;
  tilda: TildaExtraction;
  /** null means measure-only mode: record but do not propose. */
  mmm: number | null;
  thatsGreat: number | null;
  canonicalFilm: string | null;
}

/** The sheet stores "N/A" for an unanswered field; surface that as null. */
function normaliseCurrent(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t === '' || t.toUpperCase() === 'N/A' ? null : t;
}

export function buildProposalFields(
  input: ProposalInput
): Array<Omit<FieldProposal, 'status'>> {
  const out: Array<Omit<FieldProposal, 'status'>> = [];

  const add = (
    column: FieldProposal['column'],
    proposed: string | null,
    current: string | null,
    confidence: FieldProposal['confidence'],
    evidence?: string | null
  ) => {
    if (proposed === null || proposed.trim() === '') return;
    const cur = normaliseCurrent(current);
    if (cur !== null && cur === proposed.trim()) return; // already correct
    out.push({
      column,
      proposed: proposed.trim(),
      current: cur,
      confidence,
      ...(evidence ? { evidence } : {}),
    });
  };

  if (input.canonicalFilm && input.canonicalFilm !== input.current.film) {
    add('Film', input.canonicalFilm, input.current.film, 'low');
  }

  add('Kevs_Question', input.kev.question, input.current.kevsQuestion, 'high', input.kev.evidence);

  add('TildaH', input.tilda.tildaH, input.current.tildaH, 'high');
  add('TildaJason', input.tilda.tildaJason, input.current.tildaJason, 'high');
  add('TildaGuest', input.tilda.tildaGuest, input.current.tildaGuest, 'low');
  add('TildaCorey', input.tilda.tildaCorey, input.current.tildaCorey, 'low');

  if (input.mmm !== null) {
    add('MMM_Count', String(input.mmm), String(input.current.mmmCount || ''), 'low');
  }
  if (input.thatsGreat !== null) {
    add('Thats_Great_Count', String(input.thatsGreat), String(input.current.thatsGreatCount || ''), 'low');
  }

  return out;
}

/**
 * The canonical `Title (YYYY)` form TMDB knows the film by, or null.
 *
 * Title mismatch is a known failure mode in this codebase: findFilmFromQuery()
 * matches against canonical titles with year suffixes, and normalizeEpisodeTitle()
 * exists solely to reconcile the two forms. Proposing the canonical form keeps
 * retrieval working; it is staged rather than written because Film is never blank.
 */
async function resolveCanonicalFilm(film: string, filmYear: number | null): Promise<string | null> {
  const results = await searchTmdb(film.replace(/\s*\(\d{4}\)\s*$/, ''));
  if (!results) return null;
  const hit = pickTmdbMatch(results, filmYear);
  if (!hit) return null;
  const details = await fetchTmdbDetails(hit.id);
  if (!details || !details.title) return null;
  return details.year ? `${details.title} (${details.year})` : details.title;
}

function getArg(args: string[], flag: string): string | undefined {
  const hit = args.find(a => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const raw = getArg(args, '--episode');
  if (!raw) {
    log('Nothing to do — pass --episode=<id>.');
    return;
  }
  // The ingest workflow passes the app's identifier ("episode_317"); strip it.
  const episode = raw.replace(/^episode_/, '').trim();

  const { getEpisodeByNumber } = await import('../src/lib/metadata-store');
  const { loadTranscript } = await import('../src/lib/blob-storage');

  const meta = getEpisodeByNumber(parseEpisodeId(episode));
  if (!meta) {
    log(`Episode ${episode}: no matching row in metadata — skipping.`);
    return;
  }

  const epNum = Number(episode);
  if (!Number.isFinite(epNum)) {
    log(`Episode ${episode}: transcripts are keyed by number; bonus ids are not supported — skipping.`);
    return;
  }
  const transcript = await loadTranscript(epNum);
  if (!transcript) {
    log(`Episode ${episode}: no transcript in Blob — skipping.`);
    return;
  }

  const dialogues = transcript.dialogues ?? [];
  const mmmDerived = countMmm(dialogues).total;
  const tgDerived = countThatsGreat(dialogues).total;
  log(`Derived counts (measure-only=${!COUNTERS_ENABLED}): MMM=${mmmDerived}, That's Great=${tgDerived}`);

  // TMDB canonical title. Reuses Tier 1's year-verified selection, so a remake
  // cannot masquerade as the episode's film. A null year or no year-agreeing
  // result yields no proposal rather than a guess.
  const canonicalFilm = await resolveCanonicalFilm(meta.film, meta.filmYear).catch(() => null);

  const [kev, tilda] = await Promise.all([
    extractKevQuestion(transcript).catch(() => ({ question: null, evidence: null })),
    extractTildaPicks(transcript).catch(() => ({
      tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null,
    })),
  ]);

  const fields = buildProposalFields({
    current: {
      film: meta.film,
      kevsQuestion: meta.kevsQuestion,
      tildaH: meta.tildaH,
      tildaJason: meta.tildaJason,
      tildaGuest: meta.tildaGuest,
      tildaCorey: meta.tildaCorey,
      mmmCount: meta.mmmCount,
      thatsGreatCount: meta.thatsGreatCount,
    },
    kev,
    tilda,
    mmm: COUNTERS_ENABLED ? mmmDerived : null,
    thatsGreat: COUNTERS_ENABLED ? tgDerived : null,
    canonicalFilm,
  });

  if (fields.length === 0) {
    log(`Episode ${episode}: nothing to propose.`);
    return;
  }

  const doc = buildProposals(episode, meta.film, new Date().toISOString(), fields);

  if (dryRun) {
    log(`Would save ${fields.length} proposal(s): ${JSON.stringify(doc, null, 2)}`);
    return;
  }

  await saveProposals(doc);
  log(`Episode ${episode}: saved ${fields.length} proposal(s) — ${fields.map(f => f.column).join(', ')}`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      const fs = await import('node:fs');
      fs.appendFileSync(
        summaryPath,
        `\nTier 2: ${fields.length} proposal(s) for episode ${episode} — review at /podreview\n`
      );
    } catch {
      // never fatal
    }
  }
}

if (process.argv[1] === __filename) {
  main().catch(err => {
    console.error('[generate-proposals] Fatal error:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test scripts/generate-proposals.test.ts`
Expected: PASS — 9 tests passing

- [ ] **Step 5: Add the Discord event**

In `scripts/notify-discord.ts`, add this exported builder next to the other `build*Message` functions:

```typescript
export function buildProposalsReadyMessage(
  episode: string,
  film: string,
  count: number,
  baseUrl: string
): WebhookPayload {
  return {
    content: `📝 ${count} metadata proposal${count === 1 ? '' : 's'} ready to review`,
    embeds: [
      {
        title: `Ep ${episode} · ${film}`,
        url: `${baseUrl}/podreview`,
        description: 'Extracted from the transcript. Accept or reject each field in /podreview — nothing is written to the sheet until you do.',
        color: AMBER,
      },
    ],
  };
}
```

Then add a branch in `main()`, after the `drive-unresolved` branch and before the `else` that warns about unknown events:

```typescript
  } else if (event === 'proposals-ready') {
    const episode = getArg(args, 'episode')?.replace(/^episode_/, '').trim();
    const film = getArg(args, 'film') ?? '';
    const count = parseInt(getArg(args, 'count') ?? '0', 10);
    if (!episode || count <= 0) {
      console.warn('[notify-discord] proposals-ready needs --episode and a positive --count — skipping.');
      return;
    }
    payload = buildProposalsReadyMessage(episode, film, count, baseUrl);
```

Update the unknown-event warning to list it:

```typescript
    console.warn(`[notify-discord] Unknown --event "${event}" — expected needs-mapping, ingested, no-new-episodes, drive-unresolved, or proposals-ready.`);
```

- [ ] **Step 6: Write the Discord builder test**

Create `scripts/notify-proposals-ready.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProposalsReadyMessage, AMBER } from './notify-discord.ts';

test('proposals-ready: singular content and a /podreview link', () => {
  const p = buildProposalsReadyMessage('317', 'Barton Fink (1991)', 1, 'https://search.escapehatchpod.com');
  assert.equal(p.content, '📝 1 metadata proposal ready to review');
  assert.equal(p.embeds[0].title, 'Ep 317 · Barton Fink (1991)');
  assert.equal(p.embeds[0].url, 'https://search.escapehatchpod.com/podreview');
  assert.equal(p.embeds[0].color, AMBER);
});

test('proposals-ready: plural content', () => {
  const p = buildProposalsReadyMessage('317', 'Barton Fink (1991)', 4, 'https://x.test');
  assert.equal(p.content, '📝 4 metadata proposals ready to review');
});

test('proposals-ready: says nothing is written until the human acts', () => {
  const p = buildProposalsReadyMessage('317', 'F', 2, 'https://x.test');
  assert.match(p.embeds[0].description ?? '', /nothing is written to the sheet until you do/);
});
```

- [ ] **Step 7: Wire into the ingest workflow**

In `.github/workflows/ingest-episode.yml`, insert after the "Upload updated search index" step and before "Notify Discord — episode ingested":

```yaml
      # Tier 2: derive metadata proposals from the now speaker-mapped transcript.
      # Writes proposals to Blob only — never to the sheet. Non-fatal.
      - name: Generate Tier 2 proposals
        continue-on-error: true
        env:
          BLOB_READ_WRITE_TOKEN: ${{ secrets.BLOB_READ_WRITE_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          TIER2_COUNTERS_ENABLED: ${{ vars.TIER2_COUNTERS_ENABLED }}
          EPISODE: ${{ inputs.episode }}
        run: node --import tsx ./scripts/generate-proposals.ts --episode="$EPISODE"
```

`TIER2_COUNTERS_ENABLED` is a repository **variable**, not a secret, and is absent until calibration is accepted — an absent value is not `'true'`, so counters stay measure-only by default.

- [ ] **Step 8: Add the npm scripts and verify**

In `package.json`, add to `"scripts"`:

```json
"generate-proposals": "node --import tsx ./scripts/generate-proposals.ts",
```

Change `"test:notify"` to include the new file:

```json
"test:notify": "node --import tsx --test scripts/notify-discord.test.ts scripts/notify-drive-unresolved.test.ts scripts/notify-proposals-ready.test.ts",
```

Change `"test:tier2"` to:

```json
"test:tier2": "node --import tsx --test src/lib/pdc-proposals.test.ts src/lib/tier2-counters.test.ts src/lib/tier2-extract.test.ts scripts/calibrate-counters.test.ts scripts/generate-proposals.test.ts",
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:tier2` — Expected: 46 tests passing
Run: `npm run test:notify` — Expected: existing tests plus 3 new, all passing

- [ ] **Step 9: Dry-run against a real episode**

Run: `npm run generate-proposals -- --episode=317 --dry-run`

Requires `BLOB_READ_WRITE_TOKEN` and `ANTHROPIC_API_KEY` in `.env.local`. `--dry-run` prints the proposal document and writes nothing to Blob or the sheet. Capture the output in your report and say whether the Kev and Tilda values look right for that episode.

- [ ] **Step 10: Commit**

```bash
git add scripts/generate-proposals.ts scripts/generate-proposals.test.ts \
        scripts/notify-discord.ts scripts/notify-proposals-ready.test.ts \
        .github/workflows/ingest-episode.yml package.json
git commit -m "feat(tier2): generate proposals after ingest"
```

---

### Task 6: Review UI

**Files:**
- Create: `src/app/api/pdc-proposals/route.ts`
- Modify: `src/app/podreview/page.tsx`

**Interfaces:**
- Consumes: `loadProposals`, `listPendingProposals`, `saveProposals`, `applyDecisions`, `acceptedRow`, `isTier2Column`, `EpisodeProposals`, `ProposalStatus` (Task 1); `checkAuth` from `src/lib/podreview-auth`.
- Produces: `GET /api/pdc-proposals?episode=N` → `{ proposals: EpisodeProposals | null }`; `GET /api/pdc-proposals` → `{ pending: EpisodeProposals[] }`; `POST /api/pdc-proposals` with `{ episode, decisions }` → `{ ok: true, accepted: string[] }`.

- [ ] **Step 1: Write the API route**

Create `src/app/api/pdc-proposals/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import {
  loadProposals,
  listPendingProposals,
  saveProposals,
  applyDecisions,
  acceptedRow,
  isTier2Column,
  type ProposalStatus,
} from '@/lib/pdc-proposals';

const VALID: ProposalStatus[] = ['pending', 'accepted', 'rejected'];

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const episode = request.nextUrl.searchParams.get('episode');
  try {
    if (episode) {
      return NextResponse.json({ proposals: await loadProposals(episode.trim()) });
    }
    return NextResponse.json({ pending: await listPendingProposals() });
  } catch {
    return NextResponse.json({ error: 'Failed to load proposals' }, { status: 500 });
  }
}

/**
 * Record accept/reject decisions. Returns the accepted values so the client can
 * apply them to its form — this route deliberately does NOT write to the sheet.
 * The sheet write happens when the human saves in /podreview, through the
 * existing update-pdc route, so there is exactly one sheet writer.
 */
export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { episode, decisions } = await request.json();
  if (!episode || typeof decisions !== 'object' || decisions === null) {
    return NextResponse.json({ error: 'episode and decisions are required' }, { status: 400 });
  }

  const clean: Record<string, ProposalStatus> = {};
  for (const [k, v] of Object.entries(decisions as Record<string, unknown>)) {
    if (!isTier2Column(k)) {
      return NextResponse.json({ error: `Not a Tier 2 column: ${k}` }, { status: 400 });
    }
    if (typeof v !== 'string' || !VALID.includes(v as ProposalStatus)) {
      return NextResponse.json({ error: `Invalid status for ${k}` }, { status: 400 });
    }
    clean[k] = v as ProposalStatus;
  }

  const doc = await loadProposals(String(episode).trim());
  if (!doc) {
    return NextResponse.json({ error: `No proposals for episode ${episode}` }, { status: 404 });
  }

  const next = applyDecisions(doc, clean);
  await saveProposals(next);

  return NextResponse.json({ ok: true, accepted: acceptedRow(next) });
}
```

- [ ] **Step 2: Verify the route compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Add the proposals banner to /podreview**

In `src/app/podreview/page.tsx`, add this component at the bottom of the file, next to the existing `Field` component:

```tsx
function ProposalsBanner({
  proposals,
  onAccept,
  onReject,
}: {
  proposals: Array<{ column: string; proposed: string; current: string | null; confidence: string; evidence?: string }>;
  onAccept: (column: string, value: string) => void;
  onReject: (column: string) => void;
}) {
  if (proposals.length === 0) return null;
  return (
    <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h3 className="mb-1 text-sm font-semibold text-amber-900">
        {proposals.length} proposal{proposals.length === 1 ? '' : 's'} from the transcript
      </h3>
      <p className="mb-3 text-xs text-amber-800">
        Nothing is written to the sheet until you accept and save.
      </p>
      <div className="space-y-3">
        {proposals.map((p) => (
          <div key={p.column} className="rounded border border-amber-200 bg-white p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-xs font-semibold">{p.column}</span>
              {p.confidence === 'low' && (
                <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] uppercase text-gray-700">
                  low confidence
                </span>
              )}
            </div>
            <div className="mb-1 text-sm">
              <span className="text-gray-500">now: </span>
              <span className="text-gray-700">{p.current ?? '(blank)'}</span>
            </div>
            <div className="mb-2 text-sm">
              <span className="text-gray-500">proposed: </span>
              <span className="font-medium text-gray-900">{p.proposed}</span>
            </div>
            {p.evidence && (
              <div className="mb-2 border-l-2 border-gray-200 pl-2 text-xs italic text-gray-600">
                {p.evidence}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onAccept(p.column, p.proposed)}
                className="rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => onReject(p.column)}
                className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the banner into the page**

Inside the main `PodReview` component, add state next to the other `useState` declarations:

```tsx
  const [proposals, setProposals] = useState<
    Array<{ column: string; proposed: string; current: string | null; confidence: string; evidence?: string }>
  >([]);
```

At the end of `loadEpisode(epId)` — after the existing auto-fill `await Promise.all(promises)` block — fetch any pending proposals:

```tsx
      try {
        const pr = await fetch(`/api/pdc-proposals?episode=${encodeURIComponent(epId)}`, { headers });
        const pd = await pr.json();
        setProposals(
          (pd.proposals?.proposals ?? []).filter((p: { status: string }) => p.status === 'pending')
        );
      } catch {
        setProposals([]);
      }
```

Add the accept/reject handlers next to the other handlers:

```tsx
  const PROPOSAL_SETTERS: Record<string, (v: string) => void> = {
    Film: updateFilm,
    Kevs_Question: updateKevQ,
    TildaH: updateTildaH,
    TildaJason: updateTildaJ,
    TildaGuest: updateTildaGuest,
    TildaCorey: updateTildaCorey,
  };

  async function decideProposal(column: string, status: 'accepted' | 'rejected', value?: string) {
    if (status === 'accepted' && value !== undefined) {
      if (column === 'MMM_Count') {
        setMmmCount(Number(value)); store('podreview_mmm', value);
      } else if (column === 'Thats_Great_Count') {
        setTgCount(Number(value)); store('podreview_tg', value);
      } else {
        PROPOSAL_SETTERS[column]?.(value);
      }
    }
    setProposals(prev => prev.filter(p => p.column !== column));
    try {
      await fetch('/api/pdc-proposals', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ episode, decisions: { [column]: status } }),
      });
    } catch {
      showToast('Could not record that decision', 'error');
    }
  }
```

Render the banner immediately above the first form section in the returned JSX:

```tsx
        <ProposalsBanner
          proposals={proposals}
          onAccept={(c, v) => decideProposal(c, 'accepted', v)}
          onReject={(c) => decideProposal(c, 'rejected')}
        />
```

Accepting fills the form field but does **not** save. The human still presses the existing save button, which goes through `update-pdc` — keeping one sheet writer.

Match the names of the existing setter functions in this file exactly (`updateFilm`, `updateKevQ`, `updateTildaH`, `updateTildaJ`, `updateTildaGuest`, `updateTildaCorey`, `setMmmCount`, `setTgCount`, `store`, `showToast`, `headers`). If any differs, use the file's actual name rather than renaming the existing one.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run build:local` — Expected: build succeeds
Run: `npm run test:tier2 && npm run test:notify && npm run test:pdc` — Expected: all passing

Then manually: start `npm run dev`, open `/podreview`, load an episode that has proposals in Blob (generate one first with `npm run generate-proposals -- --episode=317`), and confirm the banner appears, Accept fills the matching field, Reject removes the card, and pressing save still writes through `update-pdc`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pdc-proposals/route.ts src/app/podreview/page.tsx
git commit -m "feat(tier2): review proposals in /podreview"
```

---

## Verification after all tasks

- [ ] `npx tsc --noEmit` — no errors
- [ ] `npm run test:tier2 && npm run test:notify && npm run test:pdc && npm run test:reports` — all passing
- [ ] `npm run build:local` — succeeds
- [ ] `npm run calibrate-counters` — output reviewed by a human; `TIER2_COUNTERS_ENABLED` stays unset until that review accepts the accuracy
- [ ] `npm run generate-proposals -- --episode=<recent> --dry-run` — proposals look right for a known episode
- [ ] `/podreview` shows the banner, Accept fills the field, save still writes through `update-pdc`
- [ ] Confirmed that no Tier 2 code path calls `upsertEpisodeRow` — `grep -rn "upsertEpisodeRow" src scripts` should show only `update-pdc/route.ts` and `populate-tier1.ts`

## Secrets and variables

- `ANTHROPIC_API_KEY` — already a repo secret (used by `ingest-episode.yml`).
- `BLOB_READ_WRITE_TOKEN` — already a repo secret.
- `TIER2_COUNTERS_ENABLED` — a new repository **variable**, deliberately left unset. Set it to `true` only after `calibrate-counters` output has been reviewed and accepted.
