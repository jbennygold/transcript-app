# PDC Sheet Automation — Foundation + Tier 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically fill the six deterministic columns of the Pod Data Central Google Sheet (Length, Length_minutes, Show_Link, Artwork_Link, Letterboxd_Link, IMDB_Link) during the existing new-episode run, without ever overwriting a human-entered value.

**Architecture:** Sheet-write logic and third-party lookups currently live inside Next.js route handlers, where CI cannot reach them. Both move to `src/lib/` modules split into pure functions (testable with `node:test`, no network) and thin I/O wrappers. A new CLI script composes them and is invoked from `check-new-episodes.ts`. Writes use a new `fill-empty` mode that skips any cell already containing a value.

**Tech Stack:** TypeScript (strict, ES modules), Next.js App Router, `googleapis` Sheets v4, `node:test` + `node:assert/strict` run via `node --import tsx --test`, GitHub Actions.

## Global Constraints

- Sheet ID `1RbtWP966CxA57PatyMcbJ6_ylg9tmCvDSLNxjmQ4bvk`, tab `Pod Data Detail`.
- Tier 1 writes are **always** `fill-empty`. A Tier 1 pass must never change a non-blank cell.
- Machine-written rows use `Reviewer` sentinel `auto`. Tier 1 never sets `Reviewer` — it only fills the six columns listed in the Goal.
- `scripts/sync-metadata.ts` stays on the `spreadsheets.readonly` scope. Only the new write path requests `spreadsheets`.
- Existing behaviour of `POST /api/podreview/update-pdc` must be preserved exactly (mode `overwrite`).
- `H_Flex`, `J_Flex`, `Chuckle_Hut_Favorites`, and `Notable_Moments` are never written by this plan.
- Tests are pure-function only. No network, no Google API, no fixtures requiring credentials.
- Scripts run under `node --import tsx`. Follow the existing `if (process.argv[1] === __filename)` guard so modules stay importable by tests.

## Out of scope (later plans)

- Plan B — Tier 2 staged extraction (Kev, Tilda, Film canonicalization, MMM/That's Great calibration).
- Plan C — Engineers Notes (`/pdc-note`, `#engineers` webhook, `appendToCell`, submissions tab).

---

### Task 1: Extract the sheet-write library

Behaviour-preserving extraction. `update-pdc` keeps working identically; the logic just becomes importable by CI.

**Files:**
- Create: `src/lib/pdc-sheet.ts`
- Create: `src/lib/pdc-sheet.test.ts`
- Modify: `src/app/api/podreview/update-pdc/route.ts` (replace lines 1–249 body with a wrapper)
- Modify: `package.json` (add test script)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `PDC_COLUMN_KEYS: readonly PdcColumnKey[]`
  - `type PdcColumnKey` — union of the 24 canonical column names
  - `type PdcRow = Partial<Record<PdcColumnKey, string>>`
  - `type WriteMode = 'fill-empty' | 'overwrite'`
  - `interface UpsertResult { action: 'inserted' | 'updated' | 'no_change'; changedFields: string[] }`
  - `mapHeaders(headerRow: string[]): Map<string, number>`
  - `mergeRow(existingRow: string[], rowData: PdcRow, headerMap: Map<string, number>, mode: WriteMode): { updatedRow: string[]; changedFields: string[] }`
  - `findRowIndexByEpisode(rows: string[][], epColIdx: number, episode: string): number`
  - `buildNewRow(rowData: PdcRow, headerMap: Map<string, number>): string[]`
  - `hasSheetCredentials(): boolean`
  - `upsertEpisodeRow(rowData: PdcRow, mode: WriteMode): Promise<UpsertResult>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/pdc-sheet.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapHeaders,
  mergeRow,
  findRowIndexByEpisode,
  buildNewRow,
} from './pdc-sheet.ts';

const HEADERS = ['Pod', 'Season', 'Ep', 'Film', 'Length', "Kev's Question", 'MMM Count'];

test('mapHeaders resolves canonical keys and aliases to column indexes', () => {
  const map = mapHeaders(HEADERS);
  assert.equal(map.get('Pod'), 0);
  assert.equal(map.get('Ep'), 2);
  assert.equal(map.get('Film'), 3);
  assert.equal(map.get('Kevs_Question'), 5);
  assert.equal(map.get('MMM_Count'), 6);
});

test('mapHeaders omits columns absent from the sheet', () => {
  const map = mapHeaders(HEADERS);
  assert.equal(map.has('TildaCorey'), false);
});

test('mapHeaders prefers the first alias that matches', () => {
  const map = mapHeaders(['Episode', 'Ep']);
  assert.equal(map.get('Ep'), 1, 'canonical "Ep" is listed first in HEADER_ALIASES');
});

test('mergeRow overwrite: writes changed values and reports them', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '', '', '0'];
  const { updatedRow, changedFields } = mergeRow(
    existing,
    { Length: '1:42:10', MMM_Count: '4' },
    map,
    'overwrite'
  );
  assert.equal(updatedRow[4], '1:42:10');
  assert.equal(updatedRow[6], '4');
  assert.deepEqual(changedFields.sort(), ['Length', 'MMM_Count']);
});

test('mergeRow overwrite: replaces an existing non-blank value', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:00:00', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'overwrite');
  assert.equal(updatedRow[4], '1:42:10');
  assert.deepEqual(changedFields, ['Length']);
});

test('mergeRow never writes a blank over an existing value', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:00:00', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '' }, map, 'overwrite');
  assert.equal(updatedRow[4], '1:00:00');
  assert.deepEqual(changedFields, []);
});

test('mergeRow reports no change when the value already matches', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:42:10', '', '0'];
  const { changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'overwrite');
  assert.deepEqual(changedFields, []);
});

test('mergeRow pads a short row out to the widest mapped column', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317'];
  const { updatedRow } = mergeRow(existing, { MMM_Count: '4' }, map, 'overwrite');
  assert.equal(updatedRow.length, 7);
  assert.equal(updatedRow[6], '4');
  assert.equal(updatedRow[4], '');
});

test('findRowIndexByEpisode matches case-insensitively and ignores surrounding space', () => {
  const rows = [HEADERS, ['EH', '9', '316', 'A'], ['EH', '9', ' 147B1 ', 'B']];
  assert.equal(findRowIndexByEpisode(rows, 2, '147b1'), 2);
  assert.equal(findRowIndexByEpisode(rows, 2, '316'), 1);
  assert.equal(findRowIndexByEpisode(rows, 2, '999'), -1);
});

test('buildNewRow places values at mapped indexes and blanks the rest', () => {
  const map = mapHeaders(HEADERS);
  const row = buildNewRow({ Pod: 'EH', Ep: '317', Film: 'Sorcerer (1977)' }, map);
  assert.deepEqual(row, ['EH', '', '317', 'Sorcerer (1977)', '', '', '']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/pdc-sheet.test.ts`
Expected: FAIL — `Cannot find module './pdc-sheet.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/pdc-sheet.ts`:

```typescript
/**
 * Read/write access to the canonical Pod Data Central Google Sheet.
 *
 * Pure helpers (mapHeaders, mergeRow, findRowIndexByEpisode, buildNewRow) are
 * separated from the Sheets I/O so they can be unit-tested without credentials.
 */
import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';

export const SHEET_ID = '1RbtWP966CxA57PatyMcbJ6_ylg9tmCvDSLNxjmQ4bvk';
export const SHEET_TAB = 'Pod Data Detail';

export const PDC_COLUMN_KEYS = [
  'Pod', 'Season', 'Ep', 'Film', 'Release_Date', 'Length', 'Length_minutes',
  'Reviewer', 'Guest', 'MMM_Count', 'Thats_Great_Count', 'Notable_Moments',
  'H_Flex', 'J_Flex', 'Kevs_Question', 'TildaH', 'TildaJason', 'TildaGuest',
  'TildaCorey', 'Chuckle_Hut_Favorites', 'Show_Link', 'Artwork_Link',
  'Letterboxd_Link', 'IMDB_Link',
] as const;

export type PdcColumnKey = (typeof PDC_COLUMN_KEYS)[number];
export type PdcRow = Partial<Record<PdcColumnKey, string>>;
export type WriteMode = 'fill-empty' | 'overwrite';

export interface UpsertResult {
  action: 'inserted' | 'updated' | 'no_change';
  changedFields: string[];
}

/** Header spellings the sheet has used over time, canonical form first. */
export const HEADER_ALIASES: Partial<Record<PdcColumnKey, string[]>> = {
  Ep: ['Ep', 'Episode'],
  Release_Date: ['Release_Date', 'Release Date', 'Timestamp'],
  Length_minutes: ['Length_minutes', 'Length minutes'],
  MMM_Count: ['MMM_Count', 'MMM Count'],
  Thats_Great_Count: ['Thats_Great_Count', "That's Great Count", 'Thats Great Count'],
  Notable_Moments: ['Notable_Moments', 'Notable Moments'],
  H_Flex: ['H_Flex', 'H Flex'],
  J_Flex: ['J_Flex', 'J Flex'],
  Kevs_Question: ['Kevs_Question', "Kev's Question", 'Kevs Question'],
  TildaH: ['TildaH', 'Tilda H', 'H Tilda'],
  TildaJason: ['TildaJason', 'Tilda Jason', 'J Tilda'],
  TildaGuest: ['TildaGuest', 'Tilda Guest', 'Guest Tilda'],
  TildaCorey: ['TildaCorey', 'Tilda Corey', 'Corey Tilda'],
  Chuckle_Hut_Favorites: ['Chuckle_Hut_Favorites', 'Chuckle Hut Favorites'],
  Show_Link: ['Show_Link', 'Show Link'],
  Artwork_Link: ['Artwork_Link', 'Artwork Link'],
  Letterboxd_Link: ['Letterboxd_Link', 'Letterboxd Link'],
  IMDB_Link: ['IMDB_Link', 'IMDB Link'],
};

/** Map each canonical column key to its zero-based index in the sheet header row. */
export function mapHeaders(headerRow: string[]): Map<string, number> {
  const headerToCol = new Map<string, number>();
  for (const key of PDC_COLUMN_KEYS) {
    const aliases = HEADER_ALIASES[key] ?? [key];
    for (const alias of aliases) {
      const idx = headerRow.findIndex(h => String(h).trim() === alias);
      if (idx !== -1) {
        headerToCol.set(key, idx);
        break;
      }
    }
  }
  return headerToCol;
}

/**
 * Apply rowData onto a copy of existingRow.
 *
 * Blank incoming values are always skipped, so a write can never erase a cell.
 * The `mode` parameter is accepted here but only 'overwrite' is implemented —
 * Task 2 adds the 'fill-empty' branch test-first.
 */
export function mergeRow(
  existingRow: string[],
  rowData: PdcRow,
  headerMap: Map<string, number>,
  mode: WriteMode
): { updatedRow: string[]; changedFields: string[] } {
  const indexes = Array.from(headerMap.values());
  const maxCol = indexes.length > 0 ? Math.max(...indexes) : -1;
  const updatedRow = [...existingRow];
  while (updatedRow.length <= maxCol) updatedRow.push('');

  const changedFields: string[] = [];
  for (const [key, colIdx] of headerMap) {
    const newVal = rowData[key as PdcColumnKey];
    if (newVal === undefined || newVal === null || newVal.trim() === '') continue;
    const oldVal = String(updatedRow[colIdx] ?? '').trim();
    if (oldVal === newVal.trim()) continue;
    updatedRow[colIdx] = newVal;
    changedFields.push(key);
  }

  return { updatedRow, changedFields };
}

/** Index into `rows` of the row whose Ep cell equals `episode`, or -1. */
export function findRowIndexByEpisode(
  rows: string[][],
  epColIdx: number,
  episode: string
): number {
  const target = String(episode).trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][epColIdx] ?? '').trim().toLowerCase() === target) return i;
  }
  return -1;
}

/** Build a full-width row for insertion, blank in every unmapped position. */
export function buildNewRow(rowData: PdcRow, headerMap: Map<string, number>): string[] {
  const indexes = Array.from(headerMap.values());
  const maxCol = indexes.length > 0 ? Math.max(...indexes) : -1;
  const newRow: string[] = new Array(maxCol + 1).fill('');
  for (const [key, colIdx] of headerMap) {
    newRow[colIdx] = rowData[key as PdcColumnKey] ?? '';
  }
  return newRow;
}

function getSheetsAuth() {
  const jsonKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  if (jsonKey) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(jsonKey),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (keyFile) {
    const keyPath = path.resolve(process.cwd(), keyFile);
    if (fs.existsSync(keyPath)) {
      return new google.auth.GoogleAuth({
        keyFile: keyPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    }
  }

  return null;
}

export function hasSheetCredentials(): boolean {
  return getSheetsAuth() !== null;
}

/** Insert or update the row for `rowData.Ep`. Requires an Ep value. */
export async function upsertEpisodeRow(rowData: PdcRow, mode: WriteMode): Promise<UpsertResult> {
  const episode = rowData.Ep;
  if (!episode) throw new Error('upsertEpisodeRow requires an Ep value');

  const auth = getSheetsAuth();
  if (!auth) {
    const hasJson = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
    const hasFile = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
    throw new Error(
      `Google Sheets credentials not configured (JSON: ${hasJson}, FILE: ${hasFile})`
    );
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'`,
  });

  const rows = (res.data.values as string[][] | undefined) ?? [];
  if (rows.length === 0) throw new Error('Sheet is empty or not found');

  const headerRow = rows[0].map(h => String(h).trim());
  const headerMap = mapHeaders(headerRow);
  const epColIdx = headerMap.get('Ep');
  if (epColIdx === undefined) throw new Error('Could not find Ep column in sheet');

  const matchRowIdx = findRowIndexByEpisode(rows, epColIdx, episode);

  if (matchRowIdx !== -1) {
    const { updatedRow, changedFields } = mergeRow(rows[matchRowIdx], rowData, headerMap, mode);
    if (changedFields.length === 0) return { action: 'no_change', changedFields: [] };

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TAB}'!A${matchRowIdx + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [updatedRow] },
    });
    return { action: 'updated', changedFields };
  }

  const newRow = buildNewRow(rowData, headerMap);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [newRow] },
  });

  return {
    action: 'inserted',
    changedFields: Object.keys(rowData).filter(k => (rowData[k as PdcColumnKey] ?? '') !== ''),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/pdc-sheet.test.ts`
Expected: PASS — 9 tests passing, 0 failing

- [ ] **Step 5: Refactor the route onto the library**

Replace the entire contents of `src/app/api/podreview/update-pdc/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import { upsertEpisodeRow, type PdcRow } from '@/lib/pdc-sheet';

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await request.json();

  const required = ['film', 'episode', 'pod', 'season', 'reviewer'];
  const missing = required.filter(f => !data[f] && data[f] !== 0);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(', ')}` },
      { status: 400 }
    );
  }

  const rowData: PdcRow = {
    Pod: data.pod || 'EH',
    Season: String(data.season ?? 0),
    Ep: String(data.episode),
    Film: data.film,
    Release_Date: data.releaseDate || '',
    Length: data.length || '',
    Length_minutes: data.lengthMinutes || '',
    Reviewer: data.reviewer || '',
    Guest: data.guest || '',
    MMM_Count: String(data.mmmCount ?? 0),
    Thats_Great_Count: String(data.thatsGreatCount ?? 0),
    Notable_Moments: data.notableMoments || '',
    H_Flex: data.hFlex || '',
    J_Flex: data.jFlex || '',
    Kevs_Question: data.kevsQuestion || '',
    TildaH: data.tildaH || '',
    TildaJason: data.tildaJason || '',
    TildaGuest: data.tildaGuest || '',
    TildaCorey: data.tildaCorey || '',
    Chuckle_Hut_Favorites: '',
    Show_Link: data.showLink || '',
    Artwork_Link: data.artworkLink || '',
    Letterboxd_Link: data.letterboxdLink || '',
    IMDB_Link: data.imdbLink || '',
  };

  try {
    const result = await upsertEpisodeRow(rowData, 'overwrite');

    if (result.action === 'no_change') {
      return NextResponse.json({
        ok: true,
        action: 'no_change',
        message: `Episode ${data.episode} — no fields changed.`,
      });
    }

    if (result.action === 'inserted') {
      return NextResponse.json({
        ok: true,
        action: 'inserted',
        message: `Inserted new row for episode ${data.episode}.`,
      });
    }

    const n = result.changedFields.length;
    return NextResponse.json({
      ok: true,
      action: 'updated',
      message: `Updated episode ${data.episode} (${n} field${n === 1 ? '' : 's'} changed: ${result.changedFields.join(', ')}).`,
    });
  } catch (err: unknown) {
    console.error('Google Sheets update error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.startsWith('Google Sheets credentials') ? 500 : 500;
    return NextResponse.json({ error: `Sheet update failed: ${message}` }, { status });
  }
}
```

- [ ] **Step 6: Add the test script and verify the build**

In `package.json`, add to `"scripts"` after `"test:reports"`:

```json
"test:pdc": "node --import tsx --test src/lib/pdc-sheet.test.ts"
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:pdc` — Expected: 9 tests passing

- [ ] **Step 7: Commit**

```bash
git add src/lib/pdc-sheet.ts src/lib/pdc-sheet.test.ts src/app/api/podreview/update-pdc/route.ts package.json
git commit -m "refactor(pdc): extract sheet upsert into src/lib/pdc-sheet.ts"
```

---

### Task 2: Add fill-empty write mode

Task 1 accepts a `mode` parameter but implements only `overwrite`. This task adds the `fill-empty`
branch, test-first. It is the safety property the whole Tier 1 design rests on: a machine pass must
never change a cell a human typed into.

**Files:**
- Modify: `src/lib/pdc-sheet.test.ts` (append tests)
- Modify: `src/lib/pdc-sheet.ts` (add one branch to `mergeRow`)

**Interfaces:**
- Consumes: `mapHeaders`, `mergeRow`, `WriteMode` from Task 1.
- Produces: no new exports — `mergeRow` gains its documented `fill-empty` behaviour.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/pdc-sheet.test.ts`:

```typescript
test('mergeRow fill-empty: fills a blank cell', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'fill-empty');
  assert.equal(updatedRow[4], '1:42:10');
  assert.deepEqual(changedFields, ['Length']);
});

test('mergeRow fill-empty: leaves a human-entered value alone', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:00:00', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'fill-empty');
  assert.equal(updatedRow[4], '1:00:00');
  assert.deepEqual(changedFields, []);
});

test('mergeRow fill-empty: treats a whitespace-only cell as blank', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '   ', '', '0'];
  const { updatedRow, changedFields } = mergeRow(existing, { Length: '1:42:10' }, map, 'fill-empty');
  assert.equal(updatedRow[4], '1:42:10');
  assert.deepEqual(changedFields, ['Length']);
});

test('mergeRow fill-empty: treats a missing trailing cell as blank', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)'];
  const { updatedRow, changedFields } = mergeRow(existing, { MMM_Count: '4' }, map, 'fill-empty');
  assert.equal(updatedRow[6], '4');
  assert.deepEqual(changedFields, ['MMM_Count']);
});

test('mergeRow fill-empty: mixed row fills only the blanks', () => {
  const map = mapHeaders(HEADERS);
  const existing = ['EH', '9', '317', 'Sorcerer (1977)', '1:00:00', '', ''];
  const { updatedRow, changedFields } = mergeRow(
    existing,
    { Length: '1:42:10', Kevs_Question: 'What is your favourite?', MMM_Count: '4' },
    map,
    'fill-empty'
  );
  assert.equal(updatedRow[4], '1:00:00', 'existing Length preserved');
  assert.equal(updatedRow[5], 'What is your favourite?');
  assert.equal(updatedRow[6], '4');
  assert.deepEqual(changedFields.sort(), ['Kevs_Question', 'MMM_Count']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:pdc`
Expected: FAIL — the four tests asserting that an existing value survives (`leaves a human-entered value alone`, and the `mixed row` case) fail, because `mergeRow` currently overwrites regardless of mode.

- [ ] **Step 3: Add the fill-empty branch**

In `src/lib/pdc-sheet.ts`, inside the `mergeRow` loop, add one line immediately after `const oldVal = ...` and before the equality check:

```typescript
    const oldVal = String(updatedRow[colIdx] ?? '').trim();
    if (mode === 'fill-empty' && oldVal !== '') continue;
    if (oldVal === newVal.trim()) continue;
```

Update the JSDoc on `mergeRow` to describe the now-implemented behaviour:

```typescript
/**
 * Apply rowData onto a copy of existingRow.
 *
 * Blank incoming values are always skipped, so a write can never erase a cell.
 * In 'fill-empty' mode a cell that already holds a value is left alone.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:pdc`
Expected: PASS — 14 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdc-sheet.ts src/lib/pdc-sheet.test.ts
git commit -m "feat(pdc): add fill-empty write mode"
```

---

### Task 3: Extract the third-party source lookups

Spotify, Patreon, and TMDB lookups currently only exist inside route handlers. CI needs them.

**Files:**
- Create: `src/lib/episode-sources.ts`
- Create: `src/lib/episode-sources.test.ts`
- Modify: `src/app/api/podreview/match-episode/route.ts`
- Modify: `src/app/api/podreview/tmdb-search/route.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface SpotifyMatch { title: string; duration: string; durationMinutes: string; releaseDate: string; artworkUrl: string; spotifyUrl: string }`
  - `interface PatreonMatch { title: string; publishedAt: string; showLink: string }`
  - `interface TmdbDetails { tmdbId: number; title: string; year: string | null; imdbId: string | null; imdbLink: string; letterboxdLink: string }`
  - `interface TmdbSearchResult { id: number; title: string; releaseDate: string; year: string | null; posterPath: string | null }`
  - `normalizeTitle(title: string): string`
  - `isVideoOrUncut(title: string): boolean`
  - `scoreMatch(query: string, candidate: string): number`
  - `formatDuration(ms: number): string`
  - `formatDurationMinutes(ms: number): string`
  - `letterboxdSlug(title: string): string`
  - `buildTmdbDetails(movie: Record<string, unknown>): TmdbDetails`
  - `fetchSpotifyMatch(query: string): Promise<SpotifyMatch | null>`
  - `fetchPatreonMatch(query: string): Promise<PatreonMatch | null>`
  - `searchTmdb(query: string): Promise<TmdbSearchResult[] | null>` — `null` means the upstream call failed, `[]` means no matches
  - `fetchTmdbDetails(tmdbId: number): Promise<TmdbDetails | null>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/episode-sources.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTitle,
  isVideoOrUncut,
  scoreMatch,
  formatDuration,
  formatDurationMinutes,
  letterboxdSlug,
  buildTmdbDetails,
} from './episode-sources.ts';

test('normalizeTitle strips year, punctuation, and collapses whitespace', () => {
  assert.equal(normalizeTitle('Sorcerer (1977)'), 'sorcerer');
  assert.equal(normalizeTitle("What's  Up,  Doc?"), 'whats up doc');
});

test('isVideoOrUncut flags video and uncut variants', () => {
  assert.equal(isVideoOrUncut('Sorcerer VIDEO'), true);
  assert.equal(isVideoOrUncut('Sorcerer — Uncut'), true);
  assert.equal(isVideoOrUncut('Sorcerer'), false);
});

test('scoreMatch returns 1.0 for an exact normalized match', () => {
  assert.equal(scoreMatch('Sorcerer (1977)', 'Sorcerer'), 1.0);
});

test('scoreMatch returns 0.8 when one title contains the other', () => {
  assert.equal(scoreMatch('Sorcerer', 'Escape Hatch: Sorcerer'), 0.8);
});

test('scoreMatch falls back to word overlap', () => {
  assert.equal(scoreMatch('The French Connection', 'French Connection II Redux'), 2 / 3);
});

test('scoreMatch returns 0 when nothing overlaps', () => {
  assert.equal(scoreMatch('Sorcerer', 'Jaws'), 0);
});

test('formatDuration renders H:MM:SS with zero padding', () => {
  assert.equal(formatDuration(6130000), '1:42:10');
  assert.equal(formatDuration(605000), '0:10:05');
});

test('formatDurationMinutes rounds to the nearest minute', () => {
  assert.equal(formatDurationMinutes(6130000), '102');
  assert.equal(formatDurationMinutes(29000), '0');
});

test('letterboxdSlug lowercases and hyphenates', () => {
  assert.equal(letterboxdSlug('The French Connection'), 'the-french-connection');
  assert.equal(letterboxdSlug("What's Up, Doc?"), 'whats-up-doc');
});

test('buildTmdbDetails composes imdb and letterboxd links', () => {
  const details = buildTmdbDetails({
    id: 11423,
    title: 'Sorcerer',
    release_date: '1977-06-24',
    imdb_id: 'tt0076740',
  });
  assert.equal(details.tmdbId, 11423);
  assert.equal(details.year, '1977');
  assert.equal(details.imdbLink, 'https://www.imdb.com/title/tt0076740/');
  assert.equal(details.letterboxdLink, 'https://letterboxd.com/film/sorcerer/');
});

test('buildTmdbDetails leaves imdbLink blank when there is no imdb id', () => {
  const details = buildTmdbDetails({ id: 1, title: 'Sorcerer', release_date: '', imdb_id: null });
  assert.equal(details.imdbLink, '');
  assert.equal(details.year, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/episode-sources.test.ts`
Expected: FAIL — `Cannot find module './episode-sources.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/episode-sources.ts`:

```typescript
/**
 * Third-party lookups for episode metadata: Spotify (length, artwork),
 * Patreon (show link), TMDB (IMDB + Letterboxd links).
 *
 * Pure scoring/formatting helpers are exported separately from the network
 * calls so they can be unit-tested without credentials.
 */

const SPOTIFY_SHOW_ID = '6qd41W3ueh2NLdKu9Xwt5G';
const PATREON_CAMPAIGN_ID = '10527831';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

export interface SpotifyMatch {
  title: string;
  duration: string;
  durationMinutes: string;
  releaseDate: string;
  artworkUrl: string;
  spotifyUrl: string;
}

export interface PatreonMatch {
  title: string;
  publishedAt: string;
  showLink: string;
}

export interface TmdbDetails {
  tmdbId: number;
  title: string;
  year: string | null;
  imdbId: string | null;
  imdbLink: string;
  letterboxdLink: string;
}

export interface TmdbSearchResult {
  id: number;
  title: string;
  releaseDate: string;
  year: string | null;
  posterPath: string | null;
}

// ── Pure helpers ──

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\(\d{4}\)\s*/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isVideoOrUncut(title: string): boolean {
  const upper = title.toUpperCase();
  return upper.includes('VIDEO') || upper.includes('UNCUT');
}

export function scoreMatch(query: string, candidate: string): number {
  const q = normalizeTitle(query);
  const c = normalizeTitle(candidate);
  if (q === c) return 1.0;
  if (c.includes(q) || q.includes(c)) return 0.8;
  const qWords = q.split(' ').filter(Boolean);
  const cWords = new Set(c.split(' ').filter(Boolean));
  const overlap = qWords.filter(w => cWords.has(w)).length;
  return overlap / Math.max(qWords.length, 1);
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDurationMinutes(ms: number): string {
  return String(Math.round(ms / 60000));
}

export function letterboxdSlug(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

export function buildTmdbDetails(movie: Record<string, unknown>): TmdbDetails {
  const imdbId = (movie.imdb_id as string | null) || null;
  const slug = letterboxdSlug(String(movie.title ?? ''));
  const releaseDate = movie.release_date ? String(movie.release_date) : '';
  return {
    tmdbId: Number(movie.id),
    title: String(movie.title ?? ''),
    year: releaseDate ? releaseDate.slice(0, 4) : null,
    imdbId,
    imdbLink: imdbId ? `https://www.imdb.com/title/${imdbId}/` : '',
    letterboxdLink: slug ? `https://letterboxd.com/film/${slug}/` : '',
  };
}

// ── Spotify ──

let showArtworkUrl: string | null = null;

async function getSpotifyToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || null;
}

async function getShowArtworkUrl(token: string): Promise<string | null> {
  if (showArtworkUrl) return showArtworkUrl;
  const res = await fetch(`https://api.spotify.com/v1/shows/${SPOTIFY_SHOW_ID}?fields=images`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  showArtworkUrl = data.images?.[0]?.url || null;
  return showArtworkUrl;
}

export async function fetchSpotifyMatch(query: string): Promise<SpotifyMatch | null> {
  const token = await getSpotifyToken();
  if (!token) return null;

  const params = new URLSearchParams({
    q: `${query} show:Escape Hatch`,
    type: 'episode',
    limit: '10',
  });

  const res = await fetch(`https://api.spotify.com/v1/search?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const episodes = (data.episodes?.items || []) as Array<{
    name: string;
    duration_ms: number;
    release_date: string;
    images?: Array<{ url: string }>;
    external_urls?: { spotify?: string };
  }>;

  let bestScore = 0.5;
  let bestEp: (typeof episodes)[number] | null = null;
  for (const ep of episodes) {
    if (isVideoOrUncut(ep.name)) continue;
    const score = scoreMatch(query, ep.name);
    if (score > bestScore) {
      bestScore = score;
      bestEp = ep;
    }
  }
  if (!bestEp) return null;

  // Suppress the show's generic cover — it means no episode art exists yet.
  let artworkUrl = bestEp.images?.[0]?.url || '';
  if (artworkUrl) {
    const showArt = await getShowArtworkUrl(token);
    if (showArt && artworkUrl === showArt) artworkUrl = '';
  }

  return {
    title: bestEp.name,
    duration: formatDuration(bestEp.duration_ms),
    durationMinutes: formatDurationMinutes(bestEp.duration_ms),
    releaseDate: bestEp.release_date,
    artworkUrl,
    spotifyUrl: bestEp.external_urls?.spotify || '',
  };
}

// ── Patreon ──

export async function fetchPatreonMatch(query: string): Promise<PatreonMatch | null> {
  const token = process.env.PATREON_CREATOR_TOKEN;
  if (!token) return null;

  let bestScore = 0.5;
  let best: PatreonMatch | null = null;

  let nextUrl: string | null =
    `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/posts?fields%5Bpost%5D=title,published_at,url&page%5Bcount%5D=50`;

  let pages = 0;
  const maxPages = 8;

  while (nextUrl && pages < maxPages) {
    const res: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) break;
    const data = await res.json();

    for (const post of data.data || []) {
      const title = post.attributes?.title || '';
      if (isVideoOrUncut(title)) continue;
      const score = scoreMatch(query, title);
      if (score > bestScore) {
        bestScore = score;
        best = {
          title,
          publishedAt: post.attributes.published_at || '',
          showLink: `https://www.patreon.com${post.attributes.url || ''}`,
        };
        if (score >= 1.0) return best;
      }
    }

    nextUrl = data.links?.next || null;
    pages++;
  }

  return best;
}

// ── TMDB ──

/** Returns null when the upstream call fails, [] when it succeeds with no matches. */
export async function searchTmdb(query: string): Promise<TmdbSearchResult[] | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || query.trim().length < 2) return [];

  const params = new URLSearchParams({ api_key: apiKey, query: query.trim() });
  const res = await fetch(`${TMDB_BASE_URL}/search/movie?${params}`);
  if (!res.ok) return null;

  const data = await res.json();
  return ((data.results || []) as Array<Record<string, unknown>>).slice(0, 8).map(r => ({
    id: Number(r.id),
    title: String(r.title ?? ''),
    releaseDate: r.release_date ? String(r.release_date) : '',
    year: r.release_date ? String(r.release_date).slice(0, 4) : null,
    posterPath: r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : null,
  }));
}

export async function fetchTmdbDetails(tmdbId: number): Promise<TmdbDetails | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  const res = await fetch(
    `${TMDB_BASE_URL}/movie/${tmdbId}?api_key=${apiKey}&append_to_response=external_ids`
  );
  if (!res.ok) return null;

  return buildTmdbDetails(await res.json());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/episode-sources.test.ts`
Expected: PASS — 11 tests passing

- [ ] **Step 5: Refactor match-episode onto the library**

Replace the entire contents of `src/app/api/podreview/match-episode/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import { fetchSpotifyMatch, fetchPatreonMatch } from '@/lib/episode-sources';

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get('q');
  if (!query || query.trim().length < 2) {
    return NextResponse.json({ error: 'Query too short' }, { status: 400 });
  }

  const [spotify, patreon] = await Promise.all([
    fetchSpotifyMatch(query),
    fetchPatreonMatch(query),
  ]);

  return NextResponse.json({ spotify, patreon });
}
```

- [ ] **Step 6: Refactor tmdb-search onto the library**

Replace the entire contents of `src/app/api/podreview/tmdb-search/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import { searchTmdb, fetchTmdbDetails } from '@/lib/episode-sources';

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get('q');
  if (!query || query.trim().length < 2) {
    return NextResponse.json({ results: [] });
  }

  if (!process.env.TMDB_API_KEY) {
    return NextResponse.json({ error: 'TMDB_API_KEY not configured' }, { status: 500 });
  }

  const results = await searchTmdb(query);
  if (results === null) {
    return NextResponse.json({ error: 'TMDB search failed' }, { status: 502 });
  }
  return NextResponse.json({ results });
}

// Fetch details for a selected movie (IMDB ID, Letterboxd slug).
export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { tmdbId } = await request.json();
  if (!tmdbId) {
    return NextResponse.json({ error: 'tmdbId required' }, { status: 400 });
  }

  if (!process.env.TMDB_API_KEY) {
    return NextResponse.json({ error: 'TMDB_API_KEY not configured' }, { status: 500 });
  }

  const details = await fetchTmdbDetails(Number(tmdbId));
  if (!details) {
    return NextResponse.json({ error: 'TMDB fetch failed' }, { status: 502 });
  }

  return NextResponse.json(details);
}
```

The `/podreview` page reads `data.spotify.duration`, `data.spotify.artworkUrl`, `data.spotify.releaseDate`, `data.patreon.showLink`, `data.patreon.publishedAt`, `details.imdbLink`, and `details.letterboxdLink` — every one of those field names is preserved above, so no client change is needed.

- [ ] **Step 7: Extend the test script and verify**

In `package.json`, change `"test:pdc"` to:

```json
"test:pdc": "node --import tsx --test src/lib/pdc-sheet.test.ts src/lib/episode-sources.test.ts"
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:pdc` — Expected: 25 tests passing

- [ ] **Step 8: Commit**

```bash
git add src/lib/episode-sources.ts src/lib/episode-sources.test.ts \
        src/app/api/podreview/match-episode/route.ts \
        src/app/api/podreview/tmdb-search/route.ts package.json
git commit -m "refactor(pdc): extract Spotify/Patreon/TMDB lookups into episode-sources"
```

---

### Task 4: Tier 1 population script

**Files:**
- Create: `scripts/populate-tier1.ts`
- Create: `scripts/populate-tier1.test.ts`
- Modify: `scripts/check-new-episodes.ts` (insert before the no-new-episodes early exit, around line 270)
- Modify: `.github/workflows/new-episodes.yml:30-38` (add source-API secrets)
- Modify: `package.json`

**Interfaces:**
- Consumes: `upsertEpisodeRow`, `hasSheetCredentials`, `PdcRow` (Task 1); `fetchSpotifyMatch`, `fetchPatreonMatch`, `searchTmdb`, `fetchTmdbDetails`, `SpotifyMatch`, `PatreonMatch`, `TmdbDetails` (Task 3); `getEpisodeByNumber` from `src/lib/metadata-store`.
- Produces: `buildTier1Row(episode: string, spotify: SpotifyMatch | null, patreon: PatreonMatch | null, tmdb: TmdbDetails | null): PdcRow`

- [ ] **Step 1: Write the failing test**

Create `scripts/populate-tier1.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTier1Row } from './populate-tier1.ts';

const SPOTIFY = {
  title: 'Sorcerer',
  duration: '1:42:10',
  durationMinutes: '102',
  releaseDate: '2026-08-01',
  artworkUrl: 'https://i.scdn.co/image/abc',
  spotifyUrl: 'https://open.spotify.com/episode/abc',
};

const PATREON = {
  title: 'Sorcerer',
  publishedAt: '2026-08-01T12:00:00.000Z',
  showLink: 'https://www.patreon.com/posts/sorcerer-123',
};

const TMDB = {
  tmdbId: 11423,
  title: 'Sorcerer',
  year: '1977',
  imdbId: 'tt0076740',
  imdbLink: 'https://www.imdb.com/title/tt0076740/',
  letterboxdLink: 'https://letterboxd.com/film/sorcerer/',
};

test('buildTier1Row maps all six deterministic columns', () => {
  const row = buildTier1Row('317', SPOTIFY, PATREON, TMDB);
  assert.deepEqual(row, {
    Ep: '317',
    Length: '1:42:10',
    Length_minutes: '102',
    Artwork_Link: 'https://i.scdn.co/image/abc',
    Show_Link: 'https://www.patreon.com/posts/sorcerer-123',
    IMDB_Link: 'https://www.imdb.com/title/tt0076740/',
    Letterboxd_Link: 'https://letterboxd.com/film/sorcerer/',
  });
});

test('buildTier1Row omits keys whose source returned nothing', () => {
  const row = buildTier1Row('317', null, null, null);
  assert.deepEqual(row, { Ep: '317' });
});

test('buildTier1Row omits blank artwork rather than writing an empty string', () => {
  const row = buildTier1Row('317', { ...SPOTIFY, artworkUrl: '' }, null, null);
  assert.equal('Artwork_Link' in row, false);
  assert.equal(row.Length, '1:42:10');
});

test('buildTier1Row never emits Release_Date, Film, or Reviewer', () => {
  const row = buildTier1Row('317', SPOTIFY, PATREON, TMDB);
  assert.equal('Release_Date' in row, false, 'Release_Date is Matt’s to enter');
  assert.equal('Film' in row, false);
  assert.equal('Reviewer' in row, false);
});

test('buildTier1Row omits a blank IMDB link', () => {
  const row = buildTier1Row('317', null, null, { ...TMDB, imdbId: null, imdbLink: '' });
  assert.equal('IMDB_Link' in row, false);
  assert.equal(row.Letterboxd_Link, 'https://letterboxd.com/film/sorcerer/');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test scripts/populate-tier1.test.ts`
Expected: FAIL — `Cannot find module './populate-tier1.ts'`

- [ ] **Step 3: Write the implementation**

Create `scripts/populate-tier1.ts`:

```typescript
#!/usr/bin/env node
/**
 * populate-tier1.ts — fill the deterministic Pod Data Central columns.
 *
 * Fills Length, Length_minutes, Show_Link, Artwork_Link, Letterboxd_Link and
 * IMDB_Link from Spotify, Patreon and TMDB. Writes in 'fill-empty' mode, so a
 * cell somebody already typed into is never touched. Safe to re-run.
 *
 * Usage:
 *   npm run populate-tier1 -- --episodes=317,318
 *   npm run populate-tier1 -- --fill-gaps          # 15 most recent rows with holes
 *   npm run populate-tier1 -- --episodes=317 --dry-run
 */
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import {
  upsertEpisodeRow,
  hasSheetCredentials,
  type PdcRow,
} from '../src/lib/pdc-sheet';
import {
  fetchSpotifyMatch,
  fetchPatreonMatch,
  searchTmdb,
  fetchTmdbDetails,
  type SpotifyMatch,
  type PatreonMatch,
  type TmdbDetails,
} from '../src/lib/episode-sources';
import { episodeSortKey } from '../src/lib/episode-format';

// Match the module-scope pattern already used by scripts/notify-discord.ts so
// the entrypoint guard below works under tsx.
const __filename = fileURLToPath(import.meta.url);

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

/** Upper bound on episodes touched per --fill-gaps run, to cap API fan-out. */
const GAP_LIMIT = 15;

function log(msg: string) {
  console.log(`[populate-tier1] ${msg}`);
}

/** Assemble the sheet row from whatever the sources returned. Blank values are omitted. */
export function buildTier1Row(
  episode: string,
  spotify: SpotifyMatch | null,
  patreon: PatreonMatch | null,
  tmdb: TmdbDetails | null
): PdcRow {
  const row: PdcRow = { Ep: episode };
  const set = (key: keyof PdcRow, value: string | undefined | null) => {
    if (value && value.trim() !== '') row[key] = value;
  };

  set('Length', spotify?.duration);
  set('Length_minutes', spotify?.durationMinutes);
  set('Artwork_Link', spotify?.artworkUrl);
  set('Show_Link', patreon?.showLink);
  set('IMDB_Link', tmdb?.imdbLink);
  set('Letterboxd_Link', tmdb?.letterboxdLink);

  return row;
}

async function resolveTmdb(film: string, tmdbId?: number): Promise<TmdbDetails | null> {
  if (tmdbId) return fetchTmdbDetails(tmdbId);
  const results = await searchTmdb(film);
  return results && results.length > 0 ? fetchTmdbDetails(results[0].id) : null;
}

function getArgValue(args: string[], flag: string): string | undefined {
  const hit = args.find(a => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fillGaps = args.includes('--fill-gaps');
  const episodesArg = getArgValue(args, '--episodes');

  if (!hasSheetCredentials()) {
    log('No Google Sheets credentials — skipping.');
    return;
  }

  const { loadEpisodeMetadata, getEpisodeByNumber } = await import('../src/lib/metadata-store');

  let targets: string[];
  if (episodesArg) {
    targets = episodesArg.split(',').map(s => s.trim()).filter(Boolean);
  } else if (fillGaps) {
    targets = loadEpisodeMetadata()
      .filter(ep => !ep.length || !ep.showLink || !ep.artworkLink || !ep.imdbLink || !ep.letterboxdLink)
      .sort((a, b) => episodeSortKey(b.episode) - episodeSortKey(a.episode))
      .slice(0, GAP_LIMIT)
      .map(ep => String(ep.episode));
    log(`--fill-gaps selected ${targets.length} episode(s) (cap ${GAP_LIMIT}).`);
  } else {
    log('Nothing to do — pass --episodes=<list> or --fill-gaps.');
    return;
  }

  for (const episode of targets) {
    const meta = getEpisodeByNumber(episode);
    if (!meta || !meta.film) {
      log(`Episode ${episode}: no film title in metadata — skipping.`);
      continue;
    }

    const [spotify, patreon, tmdb] = await Promise.all([
      fetchSpotifyMatch(meta.film).catch(() => null),
      fetchPatreonMatch(meta.film).catch(() => null),
      resolveTmdb(meta.film, meta.tmdbId).catch(() => null),
    ]);

    const row = buildTier1Row(episode, spotify, patreon, tmdb);
    const fieldCount = Object.keys(row).length - 1; // minus Ep
    if (fieldCount === 0) {
      log(`Episode ${episode} (${meta.film}): no source data found.`);
      continue;
    }

    if (dryRun) {
      log(`Episode ${episode} (${meta.film}) would fill: ${JSON.stringify(row)}`);
      continue;
    }

    try {
      const result = await upsertEpisodeRow(row, 'fill-empty');
      if (result.action === 'no_change') {
        log(`Episode ${episode} (${meta.film}): already complete.`);
      } else {
        log(`Episode ${episode} (${meta.film}): filled ${result.changedFields.join(', ')}.`);
      }
    } catch (err) {
      log(`Episode ${episode}: write failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

if (process.argv[1] === __filename) {
  main().catch(err => {
    console.error('[populate-tier1] Fatal error:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test scripts/populate-tier1.test.ts`
Expected: PASS — 5 tests passing

- [ ] **Step 5: Wire into check-new-episodes**

Tier 1 needs no transcript, so it runs at detection time — and it must run even when no new
episodes were found, so that scheduled passes keep filling rows whose Spotify/Patreon entries did
not exist yet when the episode was first detected.

In `scripts/check-new-episodes.ts`, insert immediately after the `log(\`Found ${episodes.length} new episode(s)\`)` line and **before** the `if (episodes.length === 0)` early exit:

```typescript
  // Tier 1: fill deterministic sheet columns. Runs before the no-new-episodes
  // early exit so scheduled passes keep filling rows whose Spotify/Patreon
  // entries did not exist yet at first detection. Non-fatal by design — a
  // source-API outage must never fail the run.
  if (!dryRun) {
    run('npm run populate-tier1 -- --fill-gaps', 'populate-tier1 (--fill-gaps)');
  }
```

A newly detected episode is by definition a row with blank Tier 1 columns, and `--fill-gaps` sorts
by descending episode, so new episodes are always at the front of the selection. One call covers
both the new episode and the backlog.

The selection is capped (see `GAP_LIMIT` below) so a single run cannot fan out into hundreds of
API calls. The cap is logged every run, and because the workflow is on a daily cron, a backlog
larger than the cap drains over successive days rather than being silently dropped.

- [ ] **Step 6: Add the npm script**

In `package.json`, add to `"scripts"` after `"check-new-episodes"`:

```json
"populate-tier1": "node --import tsx ./scripts/populate-tier1.ts",
```

And extend the test script:

```json
"test:pdc": "node --import tsx --test src/lib/pdc-sheet.test.ts src/lib/episode-sources.test.ts scripts/populate-tier1.test.ts"
```

- [ ] **Step 7: Add the source secrets to CI**

In `.github/workflows/new-episodes.yml`, in the `env:` block of the "Check for new episodes" step (currently lines 31–36), add four entries after `BLOB_READ_WRITE_TOKEN`:

```yaml
          SPOTIFY_CLIENT_ID: ${{ secrets.SPOTIFY_CLIENT_ID }}
          SPOTIFY_CLIENT_SECRET: ${{ secrets.SPOTIFY_CLIENT_SECRET }}
          PATREON_CREATOR_TOKEN: ${{ secrets.PATREON_CREATOR_TOKEN }}
          TMDB_API_KEY: ${{ secrets.TMDB_API_KEY }}
```

- [ ] **Step 8: Verify end to end against the real sheet**

Pick an episode whose Tier 1 columns are already filled, so a bug cannot damage data:

Run: `npm run populate-tier1 -- --episodes=316 --dry-run`
Expected: a `would fill:` line naming episode 316 and its film. Nothing is written.

Then confirm fill-empty protects existing values:

Run: `npm run populate-tier1 -- --episodes=316`
Expected: `Episode 316 (<film>): already complete.` — action `no_change`, because every target cell already holds a value.

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:pdc` — Expected: 30 tests passing

- [ ] **Step 9: Commit**

```bash
git add scripts/populate-tier1.ts scripts/populate-tier1.test.ts \
        scripts/check-new-episodes.ts .github/workflows/new-episodes.yml package.json
git commit -m "feat(pdc): fill deterministic sheet columns during new-episode runs"
```

---

### Task 5: Surface unresolved episodes in Discord

When Matt's `Film` title does not match a Drive folder, the run reports "Audio not found in Drive" in a job summary nobody opens. This posts the miss to `#pod-data-central` with the closest folder names, so the typo is fixable at a glance.

**Files:**
- Create: `src/lib/drive-match.ts`
- Create: `src/lib/drive-match.test.ts`
- Modify: `scripts/download-drive-audio.ts` (replace the local matching helpers at lines 261–348; write the report file near line 490)
- Modify: `scripts/notify-discord.ts` (add a `drive-unresolved` event)
- Modify: `.github/workflows/new-episodes.yml` (add a notify step)
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `normalizeFolderName(name: string): string`
  - `extractYear(name: string): number | null`
  - `scoreFolderAgainstFilm(folderName: string, film: string): number`
  - `nameSimilarity(a: string, b: string): number` — 0..1 edit-distance similarity
  - `suggestFolders(film: string, folderNames: string[], limit?: number): string[]`
  - `interface UnresolvedEpisode { episode: string; film: string; suggestions: string[] }`
  - `buildDriveUnresolvedMessage(unresolved: UnresolvedEpisode[]): WebhookPayload` (in `notify-discord.ts`)

- [ ] **Step 1: Write the failing test**

Create `src/lib/drive-match.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFolderName,
  extractYear,
  scoreFolderAgainstFilm,
  nameSimilarity,
  suggestFolders,
} from './drive-match.ts';

test('normalizeFolderName strips articles, punctuation, year, and boilerplate', () => {
  assert.equal(normalizeFolderName('The Sorcerer (1977)'), 'sorcerer');
  assert.equal(normalizeFolderName('Episode 42: Jaws'), 'jaws');
  assert.equal(normalizeFolderName('BONUS Civil War'), 'civil war');
});

test('extractYear reads a parenthesised or bare year', () => {
  assert.equal(extractYear('Sorcerer (1977)'), 1977);
  assert.equal(extractYear('Sorcerer 1977'), 1977);
  assert.equal(extractYear('Sorcerer'), null);
});

test('scoreFolderAgainstFilm gives an exact normalized match the top score', () => {
  assert.equal(scoreFolderAgainstFilm('Sorcerer', 'Sorcerer (1977)'), 100);
});

test('scoreFolderAgainstFilm adds a bonus when both years agree', () => {
  assert.equal(scoreFolderAgainstFilm('Sorcerer (1977)', 'Sorcerer (1977)'), 110);
});

test('scoreFolderAgainstFilm zeroes out when the years disagree', () => {
  assert.equal(scoreFolderAgainstFilm('Sorcerer (1977)', 'Sorcerer (1985)'), 0);
});

test('scoreFolderAgainstFilm rejects a short substring collision', () => {
  assert.equal(scoreFolderAgainstFilm('Her', 'The Godfather'), 0);
});

test('scoreFolderAgainstFilm scores substantial word overlap between 50 and 80', () => {
  const score = scoreFolderAgainstFilm('French Connection II', 'The French Connection');
  assert.ok(score >= 50 && score <= 80, `expected 50..80, got ${score}`);
});

test('nameSimilarity scores a one-character typo close to 1', () => {
  assert.ok(nameSimilarity('sorceror', 'sorcerer') > 0.8);
});

test('nameSimilarity scores unrelated names near 0', () => {
  assert.ok(nameSimilarity('jaws', 'sorcerer') < 0.3);
});

test('suggestFolders surfaces a misspelled folder that word overlap cannot see', () => {
  // The motivating case: word-overlap scoring rates these 0, because
  // "sorceror" and "sorcerer" share no whole word.
  assert.equal(scoreFolderAgainstFilm('Sorceror', 'Sorcerer (1977)'), 0);

  const folders = ['Jaws', 'Sorceror', 'The Thing', 'Alien'];
  const suggestions = suggestFolders('Sorcerer (1977)', folders, 3);
  assert.equal(suggestions[0], 'Sorceror');
  assert.ok(!suggestions.includes('Alien'));
});

test('suggestFolders returns an empty list when nothing is close', () => {
  assert.deepEqual(suggestFolders('Sorcerer (1977)', ['Alien', 'Jaws']), []);
});

test('suggestFolders honours the limit', () => {
  const folders = ['Sorceror', 'Sorcerer', 'Sorcerers', 'Sorcerar'];
  assert.equal(suggestFolders('Sorcerer (1977)', folders, 2).length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/drive-match.test.ts`
Expected: FAIL — `Cannot find module './drive-match.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/drive-match.ts`:

```typescript
/**
 * Fuzzy matching between Google Drive folder names and sheet film titles.
 *
 * Extracted from scripts/download-drive-audio.ts so the scoring can be unit
 * tested and reused to suggest near-misses when a title does not match.
 */

export interface UnresolvedEpisode {
  episode: string;
  film: string;
  suggestions: string[];
}

/** Minimum score download-drive-audio accepts as a real match. */
export const MATCH_THRESHOLD = 50;

/**
 * Lowest score worth showing a human as a possible near-miss.
 *
 * Only gates the typo path: scoreFolderAgainstFilm returns either 0 or >= 68,
 * so no real match score falls in the filtered band.
 */
const SUGGESTION_THRESHOLD = 60;

export function normalizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/\(\d{4}\)/g, '')
    .replace(/\d{4}$/g, '')
    .replace(/bonus\s*/gi, '')
    .replace(/episode\s*\d+\s*:?\s*/gi, '')
    .replace(/best\s*of\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractYear(name: string): number | null {
  const match = name.match(/\((\d{4})\)|\b(19\d{2}|20\d{2})\b/);
  return match ? parseInt(match[1] || match[2], 10) : null;
}

/**
 * Score how well a Drive folder name matches a film title.
 * 0 means no match; >= MATCH_THRESHOLD is accepted as a real match.
 */
export function scoreFolderAgainstFilm(folderName: string, film: string): number {
  const normalizedFolder = normalizeFolderName(folderName);
  const normalizedFilm = normalizeFolderName(film);
  const folderYear = extractYear(folderName);
  const filmYear = extractYear(film);

  let score = 0;

  if (normalizedFolder === normalizedFilm) {
    score = 100;
  } else if (normalizedFolder.length >= 4 && normalizedFilm.length >= 4) {
    if (
      normalizedFolder.includes(normalizedFilm) &&
      normalizedFilm.length >= normalizedFolder.length * 0.5
    ) {
      score = 80;
    } else if (
      normalizedFilm.includes(normalizedFolder) &&
      normalizedFolder.length >= normalizedFilm.length * 0.5
    ) {
      score = 80;
    }
  }

  if (score === 0) {
    const folderWords = normalizedFolder.split(' ').filter(w => w.length > 2);
    const filmWords = normalizedFilm.split(' ').filter(w => w.length > 2);

    if (folderWords.length > 0 && filmWords.length > 0) {
      const matchingWords = folderWords.filter(w =>
        filmWords.some(fw => {
          if (fw === w) return true;
          const shorter = w.length < fw.length ? w : fw;
          if (shorter.length < 5) return false;
          return fw.includes(w) || w.includes(fw);
        })
      );
      const matchRatio = matchingWords.length / Math.max(folderWords.length, filmWords.length);
      const minMatchingWords = Math.min(2, Math.min(folderWords.length, filmWords.length));
      if (matchRatio >= 0.6 && matchingWords.length >= minMatchingWords) {
        score = 50 + matchRatio * 30;
      }
    }
  }

  if (score > 0 && folderYear && filmYear) {
    if (folderYear === filmYear) score += 10;
    else score = 0;
  }

  return score;
}

/** Levenshtein edit distance, two-row variant. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** 0..1 similarity between two names. 1 is identical. */
export function nameSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - editDistance(a, b) / maxLen;
}

/**
 * Folder names that came closest to a film title without clearing the match
 * threshold — the candidates a human should look at when audio is missing.
 *
 * Word-overlap scoring alone cannot see a typo: "Sorceror" and "Sorcerer"
 * share no whole word, so scoreFolderAgainstFilm rates them 0. Suggestions
 * therefore take the better of the match score and an edit-distance score,
 * because a misspelled title is the most common reason audio goes unfound.
 */
export function suggestFolders(film: string, folderNames: string[], limit = 3): string[] {
  const normalizedFilm = normalizeFolderName(film);
  return folderNames
    .map(name => ({
      name,
      score: Math.max(
        scoreFolderAgainstFilm(name, film),
        nameSimilarity(normalizeFolderName(name), normalizedFilm) * 100
      ),
    }))
    .filter(entry => entry.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(entry => entry.name);
}
```

Note the added trailing `.replace(/\s+/g, ' ')` in `normalizeFolderName` — removing articles can leave double spaces, which the original left in place.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/lib/drive-match.test.ts`
Expected: PASS — 12 tests passing

- [ ] **Step 5: Point download-drive-audio at the library**

In `scripts/download-drive-audio.ts`, delete the local `normalizeName`, `extractYear`, and the scoring body of `matchFolderToEpisode` (lines 261–348) and replace with:

```typescript
import {
  scoreFolderAgainstFilm,
  suggestFolders,
  MATCH_THRESHOLD,
  type UnresolvedEpisode,
} from '../src/lib/drive-match';

function matchFolderToEpisode(folderName: string, episodes: EpisodeMissing[]): EpisodeMissing | null {
  let bestMatch: EpisodeMissing | null = null;
  let bestScore = 0;

  for (const ep of episodes) {
    const score = scoreFolderAgainstFilm(folderName, ep.film);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = ep;
    }
  }

  return bestScore >= MATCH_THRESHOLD ? bestMatch : null;
}
```

Place the `import` with the other imports at the top of the file, not inline.

- [ ] **Step 6: Write the unresolved report**

In `scripts/download-drive-audio.ts`, replace the `if (unmatched.length > 0 && verbose) { ... }` block (around line 487) with:

```typescript
  // Report episodes that never found audio, with the closest folder names.
  // This is the signal that a sheet Film title has a typo.
  if (unmatchedEpisodes.length > 0) {
    const allFolderNames = folders.map(f => f.name);
    const unresolved: UnresolvedEpisode[] = unmatchedEpisodes.map(ep => ({
      episode: String(ep.episode),
      film: ep.film,
      suggestions: suggestFolders(ep.film, allFolderNames),
    }));

    const reportPath = path.resolve(__dirname, '..', 'unresolved-episodes.json');
    fs.writeFileSync(reportPath, JSON.stringify(unresolved, null, 2));
    console.log(`\nWrote ${unresolved.length} unresolved episode(s) to ${reportPath}`);

    for (const u of unresolved) {
      const hint = u.suggestions.length > 0 ? ` — closest folders: ${u.suggestions.join(', ')}` : '';
      console.log(`  E${u.episode}: ${u.film} — no audio found${hint}`);
    }
  }
```

- [ ] **Step 7: Add the Discord event**

In `scripts/notify-discord.ts`, add this exported builder next to the other `build*Message` functions:

```typescript
export function buildDriveUnresolvedMessage(unresolved: UnresolvedEpisode[]): WebhookPayload {
  const plural = unresolved.length === 1 ? '' : 's';
  return {
    content: `⚠️ ${unresolved.length} episode${plural} had no matching audio folder in Drive`,
    embeds: unresolved.slice(0, 10).map(u => ({
      title: `Ep ${u.episode} · ${u.film}`,
      description:
        u.suggestions.length > 0
          ? `No folder matched. Closest names in Drive:\n${u.suggestions.map(s => `• ${s}`).join('\n')}`
          : 'No folder matched, and nothing in Drive came close.',
      color: AMBER,
    })),
  };
}
```

Add `UnresolvedEpisode` to the imports at the top of the file:

```typescript
import type { UnresolvedEpisode } from '../src/lib/drive-match';
```

Then add a branch in `main()`, after the `no-new-episodes` branch and before the `else` that warns about unknown events:

```typescript
  } else if (event === 'drive-unresolved') {
    const reportPath = path.resolve(__dirname, '..', 'unresolved-episodes.json');
    if (!fs.existsSync(reportPath)) {
      console.warn('[notify-discord] No unresolved-episodes.json — skipping.');
      return;
    }
    const unresolved: UnresolvedEpisode[] = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    if (unresolved.length === 0) {
      console.warn('[notify-discord] unresolved-episodes.json is empty — skipping.');
      return;
    }
    payload = buildDriveUnresolvedMessage(unresolved);
```

Update the unknown-event warning string on the same `else` branch to list the new event:

```typescript
    console.warn(`[notify-discord] Unknown --event "${event}" — expected needs-mapping, ingested, no-new-episodes, or drive-unresolved.`);
```

- [ ] **Step 8: Write the builder test**

Create `scripts/notify-drive-unresolved.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDriveUnresolvedMessage, AMBER } from './notify-discord.ts';

test('drive-unresolved: single episode with suggestions', () => {
  const payload = buildDriveUnresolvedMessage([
    { episode: '317', film: 'Sorceror (1977)', suggestions: ['Sorcerer (1977)'] },
  ]);
  assert.equal(payload.content, '⚠️ 1 episode had no matching audio folder in Drive');
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, 'Ep 317 · Sorceror (1977)');
  assert.equal(payload.embeds[0].color, AMBER);
  assert.match(payload.embeds[0].description ?? '', /Sorcerer \(1977\)/);
});

test('drive-unresolved: plural content and no-suggestion wording', () => {
  const payload = buildDriveUnresolvedMessage([
    { episode: '317', film: 'A', suggestions: [] },
    { episode: '318', film: 'B', suggestions: [] },
  ]);
  assert.equal(payload.content, '⚠️ 2 episodes had no matching audio folder in Drive');
  assert.match(payload.embeds[0].description ?? '', /nothing in Drive came close/);
});

test('drive-unresolved: caps at 10 embeds', () => {
  const many = Array.from({ length: 13 }, (_, i) => ({
    episode: String(300 + i),
    film: `Film ${i}`,
    suggestions: [],
  }));
  assert.equal(buildDriveUnresolvedMessage(many).embeds.length, 10);
});
```

- [ ] **Step 9: Add the workflow step**

In `.github/workflows/new-episodes.yml`, insert after the "Notify Discord — no new episodes" step and before "Trigger deploy":

```yaml
      # Surface episodes whose sheet Film title matched no Drive folder, so a
      # typo is visible in Discord rather than buried in the job summary.
      - name: Notify Discord — unresolved Drive folders
        if: hashFiles('unresolved-episodes.json') != ''
        continue-on-error: true
        env:
          DISCORD_PDC_WEBHOOK_URL: ${{ secrets.DISCORD_PDC_WEBHOOK_URL }}
        run: node --import tsx ./scripts/notify-discord.ts --event=drive-unresolved
```

- [ ] **Step 10: Ignore the report artifact**

Append to `.gitignore`:

```
unresolved-episodes.json
```

- [ ] **Step 11: Run everything**

In `package.json`, extend the notify test script:

```json
"test:notify": "node --import tsx --test scripts/notify-discord.test.ts scripts/notify-drive-unresolved.test.ts"
```

And add drive-match to the pdc script:

```json
"test:pdc": "node --import tsx --test src/lib/pdc-sheet.test.ts src/lib/episode-sources.test.ts src/lib/episode-format.test.ts src/lib/drive-match.test.ts scripts/populate-tier1.test.ts"
```

Run: `npx tsc --noEmit` — Expected: no errors
Run: `npm run test:pdc` — Expected: 47 tests passing
Run: `npm run test:notify` — Expected: existing tests plus 3 new, all passing
Run: `npm run download-audio -- --dry-run --verbose` — Expected: matching runs as before; any episode with no audio is listed with its closest folder names

- [ ] **Step 12: Commit**

```bash
git add src/lib/drive-match.ts src/lib/drive-match.test.ts \
        scripts/download-drive-audio.ts scripts/notify-discord.ts \
        scripts/notify-drive-unresolved.test.ts \
        .github/workflows/new-episodes.yml .gitignore package.json
git commit -m "feat(pdc): report unresolved Drive folders to Discord with suggestions"
```

---

## Verification after all tasks

- [ ] `npx tsc --noEmit` — no errors
- [ ] `npm run test:pdc && npm run test:notify && npm run test:reports` — all passing
- [ ] `npm run populate-tier1 -- --fill-gaps --dry-run` — lists up to 10 episodes and the fields it would fill, writing nothing
- [ ] `/podreview` still loads an episode, auto-fills length/artwork/links, and saves to the sheet (the refactor in Task 3 must not have changed any response field name)
- [ ] Trigger `/pdc-check-episodes` in Discord with no new episodes pending — confirm the run completes and posts the usual "no new episodes" message

## Secrets required

`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `PATREON_CREATOR_TOKEN`, and `TMDB_API_KEY` must exist as repository secrets before Task 4's workflow change takes effect. All four are already configured in Vercel for the `/podreview` routes — copy the same values. If any is missing, the corresponding source returns `null` and its columns are left blank; the run still succeeds.

---

## Amendments during execution

This plan's reference code contained defects found by review while executing it. Task 3's and Task 4's
sections were corrected in place. **Task 1's were not** — its code blocks below still show the
pre-fix route. Do not treat them as the record of what shipped. What actually shipped for Task 1:

- `src/lib/pdc-sheet.ts` exports `PdcSheetValidationError`. The three pre-validation failures
  (missing credentials, empty sheet, missing `Ep` column) throw it, and the route returns
  `err.message` verbatim for that type, keeping the `Sheet update failed: ` prefix for genuine
  Google API errors. The plan's version routed all three through the prefix, changing their text.
- The route checks `hasSheetCredentials()` immediately after `checkAuth`, before `await
  request.json()`, restoring the original check order. The plan's version checked credentials inside
  `upsertEpisodeRow`, after field validation, which flipped a 500 to a 400 when both were missing.
- The dead `const status = message.startsWith('Google Sheets credentials') ? 500 : 500;` ternary at
  the end of the plan's route block does not exist in the shipped code.

Also corrected after the final whole-branch review, in ways not reflected in the task sections above:

- `resolveTmdb` takes `filmYear` and selects via a pure, exported `pickTmdbMatch(results, filmYear)`,
  which requires the year to agree and returns `null` otherwise. The plan's `results[0]` took TMDB's
  popularity-ranked top hit, which returns *Dune (2021)* for a `Dune (1984)` query — and because
  Tier 1 is fill-empty, a wrong link would never be corrected. `sync-metadata.ts` never sets
  `tmdbId`, so this search path is the primary one for new episodes, not a fallback.
- `upsertEpisodeRow` refuses to insert in `fill-empty` mode, returning a new `'skipped_no_row'`
  action. Tier 1 fills rows a human created; it must never create one.
- `fetchSpotifyMatch` and `fetchPatreonMatch` take `requireExact`, which Tier 1 passes as `true`.
  Interactive `/podreview` keeps the original lenient threshold unchanged.
- `.github/workflows/new-episodes.yml` has a `concurrency` group, and the unresolved-folders Discord
  post is gated to `workflow_dispatch` so it does not repeat on every cron pass.

### Post-deploy correction: `--fill-gaps` is bounded to go-forward episodes

The plan's `--fill-gaps` selected "the 15 most recent episodes with any blank Tier 1 column" and treated
`GAP_LIMIT` as a proxy for recency. It is not one: 214 of 328 historical episodes have blanks, so the
selection reached back to episode 191 and behaved as an archive backfill.

A dry run caught the consequence before any write. Episode 289's `Film` cell is `Mailbag (2025)` — a
mailbag episode, not a film — and TMDB has a real 2025 film named "Mail Bag", so the year check passed
and it would have written that film's IMDB and Letterboxd links permanently.

Tier 1 is a go-forward mechanism: it fills columns as episodes publish and retries for rows whose
Spotify/Patreon entries landed late. `TIER1_MIN_EPISODE = 315` now floors `--fill-gaps`, compared via
`episodeSortKey` so bonus IDs sort correctly. Explicit `--episodes=N` is deliberately NOT floored —
asking for a specific episode means you want it. Selection moved into a pure, exported
`selectGapTargets(episodes, floor, limit)` with tests covering the floor boundary and bonus IDs above
and below it.

Historical rows keep whatever a human entered, including deliberate blanks. Backfilling the archive is
a separate decision, not a side effect of the cron.
