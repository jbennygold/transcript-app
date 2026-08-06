# Auto-Proposed Speaker Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-assigning every diarization label in `/review/new` with an auto-generated proposal the human confirms or corrects.

**Architecture:** A pure, synchronous module (`src/lib/speaker-proposal.ts`) classifies raw diarization labels into hosts/guests, voicemail callers, and a leftover fragment cluster; isolates each caller's genuine voicemail run; names callers from the recurring roster; and reports the rest of each caller's turns as contamination. `SpeakerMapper` applies that proposal on mount as a single undoable history entry, renders a cast panel for confirmation, and kicks off `/api/detect-samples` in the background because movie samples occur in every episode.

**Tech Stack:** TypeScript, Next.js App Router, React client components, `node:test` + `node:assert/strict` run via `node --import tsx --test`, Vercel Blob for validation fixtures.

**Spec:** `docs/superpowers/specs/2026-08-05-speaker-mapping-design.md`

## Global Constraints

- `src/lib/speaker-proposal.ts` must stay **pure and synchronous**: no network, no React, no `@anthropic-ai/sdk` import. It is unit-tested directly.
- Constants, exact values, exported from `speaker-proposal.ts`: `LONG_TURN_WORDS = 40`, `RUN_GAP_SECONDS = 240`, `PRINCIPAL_LONG_SHARE = 0.10`, `CALLER_MAX_LONG = 3`, `RUN_MARGIN_SECONDS = 30`, `MAX_PLAUSIBLE_CALLERS = 8`, `CALLER_TURN_WARNING = 60`.
- The module **never throws and never blocks**. Degenerate input returns an empty proposal; the mapping step then behaves exactly as it does today.
- **Refuse to name on a tie.** A wrong name silently corrupts segment chunks; a decline just asks the human.
- Contaminants go to the existing `Overtalk/Interjection` category, **never** to a guessed host (host guessing measured 45.7% accurate).
- Low confidence leaves the **raw label** in place — never `Voicemail (Unknown)`, which would make an episode look finished while being wrong.
- Do **not** modify `src/lib/transcription-config.ts`. Narrowing the speaker range was tried, shipped, and reverted in `7fd3350`.
- Tests must never use **tidiness as a success metric** — no assertion that fewer labels, fewer unassigned turns, or fewer callers is better. That is the metric that would have passed the `7fd3350` regression, where collapsing all five callers into hosts looked clean by turn counts. Asserting an *exact* classification against the human's known mapping (3 principals / 5 callers / 1 fragment on ep 317) is ground truth, not tidiness, and is required.
- Existing behaviour must be untouched when the transcript is already mapped (the `/review/new?load=` re-map path).
- Test runner invocation: `node --import tsx --test <files>`. Test files are colocated as `src/lib/<name>.test.ts`.

---

### Task 1: Validation fixtures

Committed paired fixtures so every later task has hermetic tests. Blob holds both the raw diarization output and the human's final mapping for ~19 episodes, index-aligned. Three pairs are committed; the full 19 stay available via the fetch script for the Task 6 scorer.

**Why these three:** 317 is the worked reference case (5 callers, all roster). 315 carries off-roster callers (Griffin, Rusty Surfer) that must produce declines. 303 contains a movie-sample cluster that looks like a caller.

**Files:**
- Create: `scripts/fetch-mapping-fixtures.ts`
- Create: `src/lib/fixtures/speaker-mapping/` (3 paired JSON files, committed)
- Create: `src/lib/fixtures/load.ts`
- Test: `src/lib/fixtures/load.test.ts`
- Modify: `package.json` (add `test:speakers` script)

**Interfaces:**
- Consumes: nothing
- Produces: `loadPair(episode: number): { raw: DialogueEntry[]; mapped: DialogueEntry[] }` from `src/lib/fixtures/load.ts`

- [ ] **Step 1: Write the fetch script**

Create `scripts/fetch-mapping-fixtures.ts`:

```ts
/**
 * Pulls paired raw/mapped transcripts from Blob for speaker-proposal validation.
 *
 * Blob is canonical for mapped transcripts. The git copies under transcripts/
 * are stale and mostly still hold placeholder labels — do NOT use them as
 * ground truth.
 *
 *   npx tsx scripts/fetch-mapping-fixtures.ts            # all pairs -> /tmp
 *   npx tsx scripts/fetch-mapping-fixtures.ts 317 315 303 --commit
 *
 * --commit writes into src/lib/fixtures/speaker-mapping/ for the unit tests.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { list } from '@vercel/blob';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const COMMIT_DIR = path.join(process.cwd(), 'src/lib/fixtures/speaker-mapping');
const SCRATCH_DIR = '/tmp/speaker-mapping-fixtures';

async function fetchJson(url: string, expectedSize: number): Promise<unknown> {
  const resp = await fetch(url, { cache: 'no-store' });
  const buf = Buffer.from(await resp.arrayBuffer());
  // Blob serves overwritten objects stale from the CDN; verify against list().
  if (Math.abs(buf.length - expectedSize) > 8) {
    throw new Error(`size mismatch: got ${buf.length}, expected ${expectedSize}`);
  }
  return JSON.parse(buf.toString());
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const wanted = args.filter((a) => /^\d+$/.test(a)).map(Number);
  const outDir = commit ? COMMIT_DIR : SCRATCH_DIR;
  mkdirSync(outDir, { recursive: true });

  const all = await list({ prefix: 'transcripts/', limit: 1000 });
  const raws = all.blobs.filter((b) => b.pathname.startsWith('transcripts/raw/'));

  for (const rawBlob of raws) {
    const file = rawBlob.pathname.split('/').pop()!;
    const ep = Number(file.match(/\d+/)?.[0]);
    if (wanted.length && !wanted.includes(ep)) continue;

    const mappedBlob = all.blobs.find((b) => b.pathname === `transcripts/${file}`);
    if (!mappedBlob) {
      console.log(`ep${ep}: no mapped counterpart, skipping`);
      continue;
    }

    const raw = (await fetchJson(rawBlob.url, rawBlob.size)) as { dialogues: unknown[] };
    const mapped = (await fetchJson(mappedBlob.url, mappedBlob.size)) as { dialogues: unknown[] };

    if (raw.dialogues.length !== mapped.dialogues.length) {
      console.log(`ep${ep}: NOT ALIGNED (${raw.dialogues.length} vs ${mapped.dialogues.length}), skipping`);
      continue;
    }

    writeFileSync(path.join(outDir, `episode_${ep}.raw.json`), JSON.stringify(raw.dialogues));
    writeFileSync(path.join(outDir, `episode_${ep}.mapped.json`), JSON.stringify(mapped.dialogues));
    console.log(`ep${ep}: ${raw.dialogues.length} turns -> ${outDir}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to produce the committed fixtures**

Run: `npx tsx scripts/fetch-mapping-fixtures.ts 317 315 303 --commit`
Expected: three `ep<N>: <count> turns -> .../src/lib/fixtures/speaker-mapping` lines, six JSON files written.

If Blob credentials are unavailable, stop and report — every later task depends on these fixtures.

- [ ] **Step 3: Write the failing test**

Create `src/lib/fixtures/load.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPair } from './load';

test('loadPair returns raw and mapped transcripts of equal length', () => {
  const { raw, mapped } = loadPair(317);
  assert.equal(raw.length, 903);
  assert.equal(mapped.length, 903);
});

test('loadPair pairs are index-aligned by timestamp', () => {
  for (const ep of [317, 315, 303]) {
    const { raw, mapped } = loadPair(ep);
    assert.equal(raw.length, mapped.length, `ep${ep} length`);
    for (let i = 0; i < raw.length; i++) {
      assert.equal(raw[i].timestamp, mapped[i].timestamp, `ep${ep} turn ${i}`);
    }
  }
});

test('raw fixtures carry placeholder labels, mapped fixtures carry real names', () => {
  const { raw, mapped } = loadPair(317);
  const rawNames = new Set(raw.map((d) => d.name));
  const mappedNames = new Set(mapped.map((d) => d.name));
  assert.ok([...rawNames].every((n) => /^[A-Z]$/.test(n)), 'raw should be single letters');
  assert.ok(mappedNames.has('Matt Haitch'), 'mapped should contain a host');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --import tsx --test src/lib/fixtures/load.test.ts`
Expected: FAIL — cannot find module `./load`.

- [ ] **Step 5: Write the loader**

Create `src/lib/fixtures/load.ts`:

```ts
import { readFileSync } from 'fs';
import path from 'path';
import type { DialogueEntry } from '@/types/transcript';

const DIR = path.join(process.cwd(), 'src/lib/fixtures/speaker-mapping');

/**
 * Paired ground truth for speaker-proposal tests: raw diarization labels and
 * the human's final mapping, index-aligned turn-for-turn.
 *
 * Refresh or add episodes with:
 *   npx tsx scripts/fetch-mapping-fixtures.ts <ep>... --commit
 */
export function loadPair(episode: number): { raw: DialogueEntry[]; mapped: DialogueEntry[] } {
  const read = (suffix: string): DialogueEntry[] =>
    JSON.parse(readFileSync(path.join(DIR, `episode_${episode}.${suffix}.json`), 'utf8'));
  return { raw: read('raw'), mapped: read('mapped') };
}
```

- [ ] **Step 6: Add the npm script**

In `package.json`, after the `test:notes` line, add:

```json
    "test:speakers": "node --import tsx --test src/lib/fixtures/load.test.ts src/lib/speaker-proposal.test.ts"
```

Note the trailing comma on the preceding line.

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --import tsx --test src/lib/fixtures/load.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Commit**

```bash
git add scripts/fetch-mapping-fixtures.ts src/lib/fixtures package.json
git commit -m "test: add paired raw/mapped transcript fixtures for speaker mapping"
```

---

### Task 2: Label classification

Splits raw labels into `principal` (hosts and guests), `caller` (voicemailers), and `fragment` (the leftover short-turn cluster). Uses share of the episode's long turns, not absolute counts — episodes range 399–1384 turns and absolute thresholds do not survive that range.

**Files:**
- Create: `src/lib/speaker-proposal.ts`
- Test: `src/lib/speaker-proposal.test.ts`

**Interfaces:**
- Consumes: `loadPair` from `src/lib/fixtures/load.ts`
- Produces:
  - constants `LONG_TURN_WORDS`, `RUN_GAP_SECONDS`, `PRINCIPAL_LONG_SHARE`, `CALLER_MAX_LONG`, `RUN_MARGIN_SECONDS`, `MAX_PLAUSIBLE_CALLERS`, `CALLER_TURN_WARNING`
  - `type LabelKind = 'principal' | 'caller' | 'fragment'`
  - `interface ClassifiedLabel { label: string; kind: LabelKind; indices: number[]; turnCount: number; longTurnCount: number }`
  - `classifyLabels(dialogues: DialogueEntry[]): ClassifiedLabel[]` — sorted by `longTurnCount` descending

- [ ] **Step 1: Write the failing test**

Create `src/lib/speaker-proposal.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPair } from './fixtures/load';
import { classifyLabels } from './speaker-proposal';

test('classifyLabels finds 3 principals, 5 callers and 1 fragment on ep 317', () => {
  const { raw } = loadPair(317);
  const labels = classifyLabels(raw);
  const count = (k: string) => labels.filter((l) => l.kind === k).length;
  assert.equal(count('principal'), 3);
  assert.equal(count('caller'), 5);
  assert.equal(count('fragment'), 1);
});

test('classifyLabels never marks a real voicemailer as a principal', () => {
  // Ground truth: every principal label must map to a host or the episode guest,
  // never to a roster caller or a category.
  const ROSTER = ['Corey', 'kev voicemail', 'birria', 'Mr Java', 'Lizzen', 'Animal Mother', 'Ethan'];
  const CATEGORIES = ['Sounder/FX', 'Movie Sample', 'Voicemail (Unknown)', 'Overtalk/Interjection'];

  for (const ep of [317, 315, 303]) {
    const { raw, mapped } = loadPair(ep);
    for (const label of classifyLabels(raw).filter((l) => l.kind === 'principal')) {
      // dominant mapped name for this label, weighted by words
      const byName = new Map<string, number>();
      for (const i of label.indices) {
        const words = raw[i].text.trim().split(/\s+/).length;
        byName.set(mapped[i].name, (byName.get(mapped[i].name) ?? 0) + words);
      }
      const truth = [...byName.entries()].sort((a, b) => b[1] - a[1])[0][0];
      assert.ok(!ROSTER.includes(truth), `ep${ep} ${label.label} is really caller "${truth}"`);
      assert.ok(!CATEGORIES.includes(truth), `ep${ep} ${label.label} is really category "${truth}"`);
    }
  }
});

test('classifyLabels uses long-turn share, so it works on short and long episodes', () => {
  // ep 303 (628 turns) and ep 317 (903 turns) must both resolve 3 principals.
  assert.equal(classifyLabels(loadPair(303).raw).filter((l) => l.kind === 'principal').length, 3);
  assert.equal(classifyLabels(loadPair(317).raw).filter((l) => l.kind === 'principal').length, 3);
});

test('classifyLabels returns an empty array for an empty transcript', () => {
  assert.deepEqual(classifyLabels([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/speaker-proposal.test.ts`
Expected: FAIL — cannot find module `./speaker-proposal`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/speaker-proposal.ts`:

```ts
import type { DialogueEntry } from '@/types/transcript';
import { timestampToSeconds } from '@/lib/timestamps';

/**
 * Thresholds validated against 19 paired episodes (299-317): raw diarization
 * labels vs the human's final mapping, index-aligned. See
 * docs/superpowers/specs/2026-08-05-speaker-mapping-design.md
 *
 * Measured outcomes at these values:
 *   - label classification: exact on 19/19 episodes; no principal label was
 *     ever actually a voicemailer or a category
 *   - caller naming: 59/72 correct, 11 declined, 2 mis-named
 *   - contamination: 53.5% of a caller label's turns on average
 *
 * PRINCIPAL_LONG_SHARE is a SHARE, not an absolute turn count: episodes range
 * 399-1384 turns and absolute thresholds do not survive that range.
 *
 * Do NOT "fix" contamination by narrowing the diarization speaker range in
 * src/lib/transcription-config.ts. That was tried, shipped, and reverted in
 * 7fd3350 — capping at 5 collapsed all five callers into hosts (0/5 distinct)
 * while looking clean by turn-count metrics.
 */
export const LONG_TURN_WORDS = 40;
export const RUN_GAP_SECONDS = 240;
export const PRINCIPAL_LONG_SHARE = 0.10;
export const CALLER_MAX_LONG = 3;
export const RUN_MARGIN_SECONDS = 30;
export const MAX_PLAUSIBLE_CALLERS = 8;
export const CALLER_TURN_WARNING = 60;

export type LabelKind = 'principal' | 'caller' | 'fragment';

export interface ClassifiedLabel {
  label: string;
  kind: LabelKind;
  indices: number[];
  turnCount: number;
  longTurnCount: number;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function isLong(d: DialogueEntry): boolean {
  return countWords(d.text) >= LONG_TURN_WORDS;
}

/**
 * Split raw diarization labels into hosts/guests, voicemail callers, and the
 * leftover short-turn cluster.
 *
 * Note the fragment cluster is NOT where movie samples live. Samples are
 * scattered across principal and caller labels alike (present in 19/19
 * episodes); classification cannot separate them. That is /api/detect-samples'
 * job.
 */
export function classifyLabels(dialogues: DialogueEntry[]): ClassifiedLabel[] {
  const byLabel = new Map<string, number[]>();
  dialogues.forEach((d, i) => {
    const list = byLabel.get(d.name);
    if (list) list.push(i);
    else byLabel.set(d.name, [i]);
  });

  const totalLong = dialogues.filter(isLong).length;

  const out: ClassifiedLabel[] = [];
  for (const [label, indices] of byLabel) {
    const longTurnCount = indices.filter((i) => isLong(dialogues[i])).length;
    const longShare = totalLong > 0 ? longTurnCount / totalLong : 0;

    let kind: LabelKind;
    if (longShare >= PRINCIPAL_LONG_SHARE) kind = 'principal';
    else if (longTurnCount >= 1 && longTurnCount <= CALLER_MAX_LONG) kind = 'caller';
    else kind = 'fragment';

    out.push({ label, kind, indices, turnCount: indices.length, longTurnCount });
  }

  return out.sort((a, b) => b.longTurnCount - a.longTurnCount);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/lib/speaker-proposal.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/speaker-proposal.ts src/lib/speaker-proposal.test.ts
git commit -m "feat(speaker-proposal): classify diarization labels by long-turn share"
```

---

### Task 3: Caller run isolation and contaminant detection

Each caller label is a real voice plus contamination — one genuine 150–350 word voicemail plus stray host backchannel scattered across the episode (53.5% of turns on average). Isolating the genuine run is what makes bulk label→name mapping safe.

Contamination is **not** purely positional: ep 317 turn 775 (`96:11 "What did your dad do?"`) and turn 788 (`98:51 "Really good."`) are host backchannel sitting *inside* the voicemail block. The rule is "not part of this caller's single high-word run".

**Files:**
- Modify: `src/lib/speaker-proposal.ts`
- Test: `src/lib/speaker-proposal.test.ts`

**Interfaces:**
- Consumes: `ClassifiedLabel`, `LONG_TURN_WORDS`, `RUN_GAP_SECONDS`, `RUN_MARGIN_SECONDS`, `countWords` from Task 2
- Produces: `isolateCallerRun(dialogues: DialogueEntry[], indices: number[]): number[]` — the caller's genuine turns, ascending; empty when the label has no long turn

- [ ] **Step 1: Write the failing test**

In `src/lib/speaker-proposal.test.ts`, **replace the existing import line** from
`./speaker-proposal` with this one (do not add a second import statement — a
duplicate `classifyLabels` binding is a TypeScript error):

```ts
import { classifyLabels, isolateCallerRun, countWords, LONG_TURN_WORDS } from './speaker-proposal';
```

Then append:

```ts
test('isolateCallerRun keeps every genuine voicemail turn on ep 317', () => {
  // No long turn may ever be stripped — that would delete the actual voicemail.
  const { raw } = loadPair(317);
  for (const label of classifyLabels(raw).filter((l) => l.kind === 'caller')) {
    const run = new Set(isolateCallerRun(raw, label.indices));
    for (const i of label.indices) {
      if (countWords(raw[i].text) >= LONG_TURN_WORDS) {
        assert.ok(run.has(i), `${label.label} long turn ${i} was stripped`);
      }
    }
  }
});

test('isolateCallerRun drops the backchannel tail', () => {
  const { raw } = loadPair(317);
  const callers = classifyLabels(raw).filter((l) => l.kind === 'caller');
  // Every ep 317 caller label shrinks: measured 37->5, 21->3, 19->1, 14->4, 9->3.
  for (const label of callers) {
    const run = isolateCallerRun(raw, label.indices);
    assert.ok(run.length < label.turnCount, `${label.label} did not shrink`);
    assert.ok(run.length > 0, `${label.label} lost its whole run`);
  }
});

test('isolateCallerRun removes contamination that sits inside the voicemail block', () => {
  // ep 317 turn 775 ("What did your dad do?") is host backchannel on caller
  // label I, at 96:11 — inside the block, so a positional rule would miss it.
  const { raw } = loadPair(317);
  const labelI = classifyLabels(raw).find((l) => l.label === 'I');
  assert.ok(labelI, 'label I should exist');
  assert.ok(!isolateCallerRun(raw, labelI!.indices).includes(775));
});

test('isolateCallerRun returns empty when the label has no long turn', () => {
  const dialogues = [
    { name: 'X', timestamp: '1:00', text: 'Yeah.' },
    { name: 'X', timestamp: '50:00', text: 'Right.' },
  ];
  assert.deepEqual(isolateCallerRun(dialogues, [0, 1]), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/lib/speaker-proposal.test.ts`
Expected: FAIL — `isolateCallerRun` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/speaker-proposal.ts`:

```ts
/** Group indices into runs separated by more than RUN_GAP_SECONDS of silence. */
function groupByTimeGap(dialogues: DialogueEntry[], indices: number[]): number[][] {
  const groups: number[][] = [];
  let current: number[] | null = null;
  let lastSeconds = Number.NEGATIVE_INFINITY;

  for (const i of indices) {
    const seconds = timestampToSeconds(dialogues[i].timestamp);
    if (current && seconds - lastSeconds < RUN_GAP_SECONDS) {
      current.push(i);
    } else {
      current = [i];
      groups.push(current);
    }
    lastSeconds = seconds;
  }
  return groups;
}

function totalWords(dialogues: DialogueEntry[], indices: number[]): number {
  return indices.reduce((sum, i) => sum + countWords(dialogues[i].text), 0);
}

/**
 * Isolate a caller's genuine voicemail from the backchannel contaminating its
 * label. Seeds on the label's LONG turns only — seeding on all turns lets the
 * scattered one-word tail drag the run across the whole episode.
 *
 * Returns the turns to keep. Everything else on the label is contamination.
 */
export function isolateCallerRun(dialogues: DialogueEntry[], indices: number[]): number[] {
  const longIndices = indices.filter((i) => countWords(dialogues[i].text) >= LONG_TURN_WORDS);
  if (longIndices.length === 0) return [];

  const seedGroups = groupByTimeGap(dialogues, longIndices);
  seedGroups.sort((a, b) => totalWords(dialogues, b) - totalWords(dialogues, a));
  const seed = seedGroups[0];

  const start = timestampToSeconds(dialogues[seed[0]].timestamp) - RUN_MARGIN_SECONDS;
  const end = timestampToSeconds(dialogues[seed[seed.length - 1]].timestamp) + RUN_MARGIN_SECONDS;

  return indices.filter((i) => {
    const seconds = timestampToSeconds(dialogues[i].timestamp);
    return seconds >= start && seconds <= end;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/lib/speaker-proposal.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/speaker-proposal.ts src/lib/speaker-proposal.test.ts
git commit -m "feat(speaker-proposal): isolate caller voicemail runs from backchannel"
```

---

### Task 4: Naming

Names callers from the recurring roster and principals from the cold open. The probe window anchors on the caller's **first long turn** — voicemails run back-to-back, so a window spanning the whole run bleeds into the next caller's intro cue. That change alone cut mis-names from 5 to 2 with no loss of correct names.

**Files:**
- Modify: `src/lib/speaker-proposal.ts`
- Test: `src/lib/speaker-proposal.test.ts`

**Interfaces:**
- Consumes: `isolateCallerRun`, `countWords`, `LONG_TURN_WORDS` from Tasks 2–3
- Produces:
  - `VOICEMAILER_ALIASES: Record<string, string[]>`
  - `nameCaller(dialogues: DialogueEntry[], run: number[]): string | null`
  - `namePrincipals(dialogues: DialogueEntry[], principals: ClassifiedLabel[], guestName?: string | null): Map<string, string>` — label → name, entries omitted where undetermined

- [ ] **Step 1: Write the failing test**

In `src/lib/speaker-proposal.test.ts`, **replace the existing import line** from
`./speaker-proposal` with this one:

```ts
import { classifyLabels, isolateCallerRun, nameCaller, namePrincipals, countWords, LONG_TURN_WORDS } from './speaker-proposal';
```

Then append:

```ts
test('nameCaller resolves all five ep 317 callers', () => {
  const { raw, mapped } = loadPair(317);
  const results = classifyLabels(raw)
    .filter((l) => l.kind === 'caller')
    .map((l) => {
      const run = isolateCallerRun(raw, l.indices);
      // ground truth: mapped name of the longest turn in the run
      const longest = run.reduce((a, b) => (countWords(raw[a].text) > countWords(raw[b].text) ? a : b));
      return { proposed: nameCaller(raw, run), truth: mapped[longest].name };
    });
  assert.equal(results.length, 5);
  for (const r of results) assert.equal(r.proposed, r.truth);
});

test('nameCaller declines rather than guessing for off-roster callers', () => {
  // ep 315 has Griffin and Rusty Surfer, neither in the roster. They must come
  // back null — a wrong name silently corrupts segment chunks, a null just
  // asks the human.
  const { raw, mapped } = loadPair(315);
  const ROSTER = ['Corey', 'kev voicemail', 'birria', 'Mr Java', 'Lizzen', 'Animal Mother', 'Ethan'];
  for (const l of classifyLabels(raw).filter((c) => c.kind === 'caller')) {
    const run = isolateCallerRun(raw, l.indices);
    if (run.length === 0) continue;
    const longest = run.reduce((a, b) => (countWords(raw[a].text) > countWords(raw[b].text) ? a : b));
    const truth = mapped[longest].name;
    const proposed = nameCaller(raw, run);
    if (!ROSTER.includes(truth)) {
      assert.equal(proposed, null, `off-roster "${truth}" should decline, got "${proposed}"`);
    }
  }
});

test('nameCaller refuses to name on a tie', () => {
  const dialogues = [
    { name: 'B', timestamp: '10:00', text: 'Here is Corey, and also here is Kev.' },
    { name: 'E', timestamp: '10:10', text: 'x '.repeat(60) },
  ];
  assert.equal(nameCaller(dialogues, [1]), null);
});

test('nameCaller returns null for an empty run', () => {
  assert.equal(nameCaller([], []), null);
});

test('namePrincipals identifies Haitch from the cold open and binds the guest', () => {
  const { raw } = loadPair(317);
  const principals = classifyLabels(raw).filter((l) => l.kind === 'principal');
  const names = namePrincipals(raw, principals, 'Dave Mandel');
  const assigned = [...names.values()];
  assert.ok(assigned.includes('Matt Haitch'), 'Haitch self-names in the cold open');
  assert.ok(assigned.includes('Dave Mandel'), 'guest name is bound');
  assert.ok(assigned.includes('Jason Goldman'), 'remaining principal is Jason');
});

test('namePrincipals names only Haitch when no guest name is available', () => {
  // With 3 principals and no guestName there is no way to tell Jason from the
  // guest, so neither is guessed — only the label that self-names is assigned.
  const { raw } = loadPair(317);
  const principals = classifyLabels(raw).filter((l) => l.kind === 'principal');
  const names = namePrincipals(raw, principals, null);
  assert.equal(names.size, 1);
  assert.deepEqual([...names.values()], ['Matt Haitch']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/lib/speaker-proposal.test.ts`
Expected: FAIL — `nameCaller` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/speaker-proposal.ts`:

```ts
/**
 * Recurring voicemailers and the spellings they appear under. Keys are the
 * canonical names used by SEGMENT_CONFIGS in scripts/ingest.ts — segment
 * sub-chunking keys on these exact strings.
 *
 * This roster is deliberately incomplete. Across 19 episodes there is a long
 * tail of one-off callers (Griffin, ctcher, Rusty Surfer, Buddha LeDread,
 * Space monkey, Silly Oswald, Proto, Derek, Sam, Bijani). They come back null
 * and the human names them. An LLM fallback would not know them either.
 */
export const VOICEMAILER_ALIASES: Record<string, string[]> = {
  'Corey': ['corey'],
  'kev voicemail': ['kev'],
  'birria': ['birria', 'truthsayer'],
  'Mr Java': ['mr\\.? ?java'],
  'Lizzen': ['lizzen'],
  'Animal Mother': ['animal mother'],
  'Ethan': ['ethan'],
};

function countMatches(text: string, aliases: string[]): number {
  return aliases.reduce((sum, alias) => {
    const matches = text.match(new RegExp(`\\b${alias}\\b`, 'ig'));
    return sum + (matches ? matches.length : 0);
  }, 0);
}

/**
 * Name a caller from the roster.
 *
 * The window anchors on the caller's FIRST long turn, not the whole run.
 * Voicemails run back-to-back, so a full-run window bleeds into the next
 * caller's intro cue: that fix took mis-names from 5 to 2 with no loss of
 * correct names.
 *
 * Signals, in weight order:
 *   - self-ID in the caller's own words ("it's Kev here") — weight 3
 *   - self-ID in a short turn of theirs just before the body
 *     ("This is your brother, Animal Mother") — weight 3
 *   - the host's intro cue in the 3 turns before ("Lay it on us, Ethan") — weight 1
 *
 * REVERTED EXPERIMENT — do not re-attempt: proximity tie-breaking on chained
 * handoffs ("thanks Kev, here is Corey" -> prefer the name nearest the body)
 * took mis-names 2 -> 3 and gained zero correct names.
 */
export function nameCaller(dialogues: DialogueEntry[], run: number[]): string | null {
  if (run.length === 0) return null;

  const firstLong = run.find((i) => countWords(dialogues[i].text) >= LONG_TURN_WORDS) ?? run[0];
  const intro = dialogues.slice(Math.max(0, firstLong - 3), firstLong).map((d) => d.text).join(' ');
  const body = dialogues[firstLong].text;
  const ownPreamble = run
    .filter((i) => i < firstLong && i >= firstLong - 6)
    .map((i) => dialogues[i].text)
    .join(' ');

  const scores = Object.entries(VOICEMAILER_ALIASES)
    .map(([name, aliases]) => ({
      name,
      score:
        countMatches(body, aliases) * 3 +
        countMatches(ownPreamble, aliases) * 3 +
        countMatches(intro, aliases),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scores.length === 0) return null;
  // Refuse on a tie: a wrong name silently corrupts segment chunks.
  if (scores.length > 1 && scores[0].score === scores[1].score) return null;
  return scores[0].name;
}

const HOST_SELF_INTRO = /\bit'?s\s+haitch\b/i;
const COLD_OPEN_TURNS = 25;

/**
 * Name the host/guest labels.
 *
 * Haitch self-names in the cold open ("Hey everybody, it's Haitch, and welcome
 * to..."), which identifies his label directly. The guest name arrives from
 * sheet metadata via guestName. Jason is then the remaining principal.
 *
 * This is the weakest link in the chain and is exactly what the human confirms
 * in the cast panel. Labels that cannot be determined are omitted from the map
 * rather than guessed.
 */
export function namePrincipals(
  dialogues: DialogueEntry[],
  principals: ClassifiedLabel[],
  guestName?: string | null,
): Map<string, string> {
  const names = new Map<string, string>();
  if (principals.length === 0) return names;

  const coldOpen = dialogues.slice(0, COLD_OPEN_TURNS);
  const haitchLabel = coldOpen.find((d) => HOST_SELF_INTRO.test(d.text))?.name;
  const isPrincipal = (label: string) => principals.some((p) => p.label === label);

  if (haitchLabel && isPrincipal(haitchLabel)) names.set(haitchLabel, 'Matt Haitch');

  // The guest speaks least of the principals — hosts carry the episode.
  const remaining = principals
    .filter((p) => !names.has(p.label))
    .sort((a, b) => b.longTurnCount - a.longTurnCount);

  const trimmedGuest = guestName?.trim();
  if (trimmedGuest && remaining.length >= 2) {
    names.set(remaining[remaining.length - 1].label, trimmedGuest);
    remaining.pop();
  }

  // Whoever is left, if exactly one, is Jason.
  if (remaining.length === 1 && names.size > 0) {
    names.set(remaining[0].label, 'Jason Goldman');
  }

  return names;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/lib/speaker-proposal.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/speaker-proposal.ts src/lib/speaker-proposal.test.ts
git commit -m "feat(speaker-proposal): name callers from roster and principals from cold open"
```

---

### Task 5: Proposal assembly and degenerate guards

Ties the passes together and returns the `SpeakerProposal` the UI consumes. Fails open: any degenerate result yields an empty proposal so the mapping step behaves exactly as it does today.

**Files:**
- Modify: `src/lib/speaker-proposal.ts`
- Test: `src/lib/speaker-proposal.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–4
- Produces:
  - `interface ProposedLabel { label: string; kind: LabelKind; proposedName: string | null; confidence: 'high' | 'low'; turnCount: number; runTurnCount: number; runStart?: string; runEnd?: string; sampleText: string; warnings: string[] }`
  - `interface SpeakerProposal { labels: ProposedLabel[]; contaminants: Array<{ index: number; fromLabel: string }>; degenerate: string | null }`
  - `proposeSpeakerMapping(dialogues: DialogueEntry[], opts?: { guestName?: string | null }): SpeakerProposal`
  - `CONTAMINANT_SPEAKER = 'Overtalk/Interjection'`

- [ ] **Step 1: Write the failing test**

In `src/lib/speaker-proposal.test.ts`, **replace the existing import line** from
`./speaker-proposal` with this one, and add the `DialogueEntry` type import:

```ts
import type { DialogueEntry } from '@/types/transcript';
import {
  classifyLabels, isolateCallerRun, nameCaller, namePrincipals,
  proposeSpeakerMapping, countWords, LONG_TURN_WORDS,
} from './speaker-proposal';
```

Then append:

```ts
test('proposeSpeakerMapping produces a full ep 317 proposal', () => {
  const { raw } = loadPair(317);
  const proposal = proposeSpeakerMapping(raw, { guestName: 'Dave Mandel' });
  assert.equal(proposal.degenerate, null);
  assert.equal(proposal.labels.length, 9);
  const named = proposal.labels.filter((l) => l.proposedName !== null).map((l) => l.proposedName);
  for (const expected of ['Matt Haitch', 'Jason Goldman', 'Dave Mandel', 'Corey', 'Ethan', 'kev voicemail', 'birria', 'Animal Mother']) {
    assert.ok(named.includes(expected), `missing ${expected}`);
  }
  assert.ok(proposal.contaminants.length > 50, 'ep 317 has ~94 contaminant turns');
});

test('proposeSpeakerMapping never reports a long turn as a contaminant', () => {
  for (const ep of [317, 315, 303]) {
    const { raw } = loadPair(ep);
    const proposal = proposeSpeakerMapping(raw, { guestName: null });
    for (const c of proposal.contaminants) {
      assert.ok(countWords(raw[c.index].text) < LONG_TURN_WORDS, `ep${ep} turn ${c.index} is substantive`);
    }
  }
});

test('proposeSpeakerMapping declines both labels when two would take the same name', () => {
  // Two labels both scoring "Kev" would build Kev's segment chunks from a host
  // cluster — the Animal-Mother-349-turns failure, reintroduced automatically.
  // Neither may win.
  //
  // The host needs MANY long turns here: PRINCIPAL_LONG_SHARE is a share, so
  // with only two long turns in the transcript each one is 50% and E/F would
  // classify as principals instead of callers.
  const long = (word: string) => `${word} `.repeat(60);
  const dialogues: DialogueEntry[] = [];
  for (let i = 0; i < 12; i++) {
    dialogues.push({ name: 'B', timestamp: `${i}:00`, text: long('host') });
  }
  dialogues.push({ name: 'B', timestamp: '20:00', text: 'Here is Kev.' });
  dialogues.push({ name: 'E', timestamp: '20:05', text: long('alpha') });
  dialogues.push({ name: 'B', timestamp: '40:00', text: 'And here is Kev.' });
  dialogues.push({ name: 'F', timestamp: '40:05', text: long('beta') });

  const proposal = proposeSpeakerMapping(dialogues, { guestName: null });

  const e = proposal.labels.find((l) => l.label === 'E');
  const f = proposal.labels.find((l) => l.label === 'F');
  assert.equal(e?.kind, 'caller', 'E should classify as a caller');
  assert.equal(f?.kind, 'caller', 'F should classify as a caller');
  assert.equal(e?.proposedName, null, 'duplicate name must not be assigned');
  assert.equal(f?.proposedName, null, 'duplicate name must not be assigned');
});

test('proposeSpeakerMapping fails open on a transcript with no principals', () => {
  const dialogues: DialogueEntry[] = [
    { name: 'A', timestamp: '0:01', text: 'Yeah.' },
    { name: 'B', timestamp: '0:05', text: 'Right.' },
  ];
  const proposal = proposeSpeakerMapping(dialogues, { guestName: null });
  assert.equal(proposal.labels.length, 0);
  assert.equal(proposal.contaminants.length, 0);
  assert.ok(proposal.degenerate);
});

test('proposeSpeakerMapping flags the unresolvable fragment cluster', () => {
  const { raw } = loadPair(317);
  const proposal = proposeSpeakerMapping(raw, { guestName: 'Dave Mandel' });
  const fragment = proposal.labels.find((l) => l.kind === 'fragment');
  assert.ok(fragment, 'ep 317 has a fragment cluster');
  assert.equal(fragment!.proposedName, null, 'fragment cluster must not be named');
  assert.ok(fragment!.warnings.length > 0, 'fragment cluster should carry a warning');
});

test('proposeSpeakerMapping warns when a label holds implausibly many turns', () => {
  // A voicemailer with more turns than CALLER_TURN_WARNING is the ep 317
  // Animal-Mother-349-turns signature: a bulk mapping that swallowed a host.
  const long = (word: string) => `${word} `.repeat(60);
  const dialogues: DialogueEntry[] = [];
  for (let i = 0; i < 12; i++) {
    dialogues.push({ name: 'B', timestamp: `${i}:00`, text: long('host') });
  }
  dialogues.push({ name: 'B', timestamp: '20:00', text: 'Here is Kev.' });
  dialogues.push({ name: 'E', timestamp: '20:05', text: long('alpha') });
  for (let i = 0; i < 70; i++) {
    dialogues.push({ name: 'E', timestamp: `${30 + i}:00`, text: 'Yeah.' });
  }

  const proposal = proposeSpeakerMapping(dialogues, { guestName: null });
  const e = proposal.labels.find((l) => l.label === 'E');
  assert.ok(e, 'label E should exist');
  assert.ok(
    e!.warnings.some((w) => w.includes('holds')),
    `expected a turn-count warning, got ${JSON.stringify(e!.warnings)}`,
  );
});

test('proposeSpeakerMapping never throws on empty or malformed input', () => {
  assert.doesNotThrow(() => proposeSpeakerMapping([], {}));
  assert.doesNotThrow(() => proposeSpeakerMapping([{ name: 'A', timestamp: 'nonsense', text: '' }], {}));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/lib/speaker-proposal.test.ts`
Expected: FAIL — `proposeSpeakerMapping` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/speaker-proposal.ts`:

```ts
/**
 * Where contaminant turns go.
 *
 * NOT a guessed host: the nearest preceding and nearest following principal
 * label disagree 45.7% of the time (51 of 94 turns on ep 317). Every
 * disagreement is 1-4 word backchannel where host precision is worth nothing
 * downstream, while getting the turn OFF the caller label is worth everything
 * — it is what unblocks extractSegmentChunks().
 */
export const CONTAMINANT_SPEAKER = 'Overtalk/Interjection';

export interface ProposedLabel {
  label: string;
  kind: LabelKind;
  proposedName: string | null;
  confidence: 'high' | 'low';
  turnCount: number;
  runTurnCount: number;
  runStart?: string;
  runEnd?: string;
  sampleText: string;
  warnings: string[];
}

export interface SpeakerProposal {
  labels: ProposedLabel[];
  contaminants: Array<{ index: number; fromLabel: string }>;
  /** Non-null when the proposal was abandoned; the UI then changes nothing. */
  degenerate: string | null;
}

const EMPTY: SpeakerProposal = { labels: [], contaminants: [], degenerate: null };

function longestText(dialogues: DialogueEntry[], indices: number[]): string {
  if (indices.length === 0) return '';
  const best = indices.reduce((a, b) =>
    countWords(dialogues[a].text) > countWords(dialogues[b].text) ? a : b);
  return dialogues[best].text;
}

/**
 * Build a proposed speaker mapping from raw diarization output.
 *
 * Never throws and never blocks. On a degenerate result it returns an empty
 * proposal with `degenerate` set, and the caller leaves the transcript alone.
 */
export function proposeSpeakerMapping(
  dialogues: DialogueEntry[],
  opts: { guestName?: string | null } = {},
): SpeakerProposal {
  try {
    if (!dialogues || dialogues.length === 0) {
      return { ...EMPTY, degenerate: 'empty transcript' };
    }

    const classified = classifyLabels(dialogues);
    const principals = classified.filter((l) => l.kind === 'principal');
    const callers = classified.filter((l) => l.kind === 'caller');

    if (principals.length === 0) {
      return { ...EMPTY, degenerate: 'no principal labels found' };
    }
    if (callers.length > MAX_PLAUSIBLE_CALLERS) {
      return { ...EMPTY, degenerate: `${callers.length} caller labels exceeds ${MAX_PLAUSIBLE_CALLERS}` };
    }

    const principalNames = namePrincipals(dialogues, principals, opts.guestName);

    // Name callers first, then void any name claimed by more than one label.
    const runs = new Map<string, number[]>();
    const callerNames = new Map<string, string | null>();
    for (const caller of callers) {
      const run = isolateCallerRun(dialogues, caller.indices);
      runs.set(caller.label, run);
      callerNames.set(caller.label, nameCaller(dialogues, run));
    }
    const nameCounts = new Map<string, number>();
    for (const name of callerNames.values()) {
      if (name) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    for (const [label, name] of callerNames) {
      if (name && nameCounts.get(name)! > 1) callerNames.set(label, null);
    }

    const labels: ProposedLabel[] = [];
    const contaminants: Array<{ index: number; fromLabel: string }> = [];

    for (const entry of classified) {
      const warnings: string[] = [];
      let proposedName: string | null = null;
      let runIndices = entry.indices;

      if (entry.kind === 'principal') {
        proposedName = principalNames.get(entry.label) ?? null;
        if (!proposedName) warnings.push('could not identify this speaker');
      } else if (entry.kind === 'caller') {
        runIndices = runs.get(entry.label) ?? [];
        proposedName = callerNames.get(entry.label) ?? null;
        if (!proposedName) warnings.push('not a known voicemailer — name this one');
        if (entry.turnCount > CALLER_TURN_WARNING) {
          warnings.push(`holds ${entry.turnCount} turns, far more than a voicemail`);
        }
        const runSet = new Set(runIndices);
        for (const i of entry.indices) {
          if (!runSet.has(i)) contaminants.push({ index: i, fromLabel: entry.label });
        }
      } else {
        warnings.push('no clear voice — likely mixed speakers and movie samples');
      }

      labels.push({
        label: entry.label,
        kind: entry.kind,
        proposedName,
        confidence: proposedName ? 'high' : 'low',
        turnCount: entry.turnCount,
        runTurnCount: runIndices.length,
        runStart: runIndices.length ? dialogues[runIndices[0]].timestamp : undefined,
        runEnd: runIndices.length ? dialogues[runIndices[runIndices.length - 1]].timestamp : undefined,
        sampleText: longestText(dialogues, runIndices.length ? runIndices : entry.indices),
        warnings,
      });
    }

    return { labels, contaminants, degenerate: null };
  } catch (err) {
    return { ...EMPTY, degenerate: err instanceof Error ? err.message : 'proposal failed' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/lib/speaker-proposal.test.ts`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/speaker-proposal.ts src/lib/speaker-proposal.test.ts
git commit -m "feat(speaker-proposal): assemble proposal with fail-open degenerate guards"
```

---

### Task 6: Full-set regression scorer

The unit tests cover three committed fixtures. This script scores the proposal against all ~19 paired episodes in Blob and enforces the measured floors, matching the existing `regression:*` script idiom. It is not part of `test:speakers` because it needs Blob credentials.

**Files:**
- Create: `scripts/score-speaker-proposal.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `proposeSpeakerMapping`, `classifyLabels`, `isolateCallerRun`, `countWords`, `VOICEMAILER_ALIASES` from Tasks 2–5
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Write the scorer**

Create `scripts/score-speaker-proposal.ts`:

```ts
/**
 * Scores speaker-proposal against every paired episode in Blob.
 *
 *   npx tsx scripts/fetch-mapping-fixtures.ts     # populate /tmp first
 *   npm run score:speakers
 *
 * Floors are the measured baseline from the design spec. Correct names may go
 * up; MIS-NAMES MAY NOT GO UP. Declining is cheap, a wrong name is not.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import type { DialogueEntry } from '../src/types/transcript';
import { classifyLabels, isolateCallerRun, nameCaller, countWords, VOICEMAILER_ALIASES } from '../src/lib/speaker-proposal';

const DIR = '/tmp/speaker-mapping-fixtures';
const MIN_CORRECT = 59;
const MAX_MISNAMED = 2;

function main() {
  let episodes = 0;
  let correct = 0;
  let declined = 0;
  let misnamed = 0;
  const failures: string[] = [];

  const files = readdirSync(DIR).filter((f) => f.endsWith('.raw.json')).sort();
  if (files.length === 0) {
    console.error(`No fixtures in ${DIR}. Run: npx tsx scripts/fetch-mapping-fixtures.ts`);
    process.exit(1);
  }

  for (const file of files) {
    const ep = Number(file.match(/\d+/)?.[0]);
    const raw: DialogueEntry[] = JSON.parse(readFileSync(path.join(DIR, file), 'utf8'));
    const mapped: DialogueEntry[] = JSON.parse(
      readFileSync(path.join(DIR, `episode_${ep}.mapped.json`), 'utf8'));
    if (raw.length !== mapped.length) continue;
    episodes++;

    for (const label of classifyLabels(raw).filter((l) => l.kind === 'caller')) {
      const run = isolateCallerRun(raw, label.indices);
      if (run.length === 0) continue;
      const longest = run.reduce((a, b) => (countWords(raw[a].text) > countWords(raw[b].text) ? a : b));
      const truth = mapped[longest].name;
      const proposed = nameCaller(raw, run);

      if (proposed === truth) correct++;
      else if (proposed === null) declined++;
      else {
        misnamed++;
        failures.push(`ep${ep} ${label.label}: truth="${truth}" proposed="${proposed}"`);
      }
    }
  }

  console.log(`episodes scored: ${episodes}`);
  console.log(`correct: ${correct}  declined: ${declined}  MIS-NAMED: ${misnamed}`);
  if (failures.length) {
    console.log('\nmis-names:');
    for (const f of failures) console.log('  ' + f);
  }

  let failed = false;
  if (correct < MIN_CORRECT) {
    console.error(`\nFAIL: correct ${correct} < floor ${MIN_CORRECT}`);
    failed = true;
  }
  if (misnamed > MAX_MISNAMED) {
    console.error(`\nFAIL: mis-named ${misnamed} > ceiling ${MAX_MISNAMED}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log('\nPASS');
}

main();
```

- [ ] **Step 2: Add the npm script**

In `package.json`, after `test:speakers`, add:

```json
    "score:speakers": "node --import tsx ./scripts/score-speaker-proposal.ts"
```

- [ ] **Step 3: Run it**

```bash
npx tsx scripts/fetch-mapping-fixtures.ts
npm run score:speakers
```

Expected: `correct: 59  declined: 11  MIS-NAMED: 2` then `PASS`. Numbers may differ slightly if Blob has gained episodes; the run must still print `PASS`.

- [ ] **Step 4: Commit**

```bash
git add scripts/score-speaker-proposal.ts package.json
git commit -m "test: add full-set regression scorer for speaker proposal"
```

---

### Task 7: Cast panel in SpeakerMapper

Applies the proposal on mount as a single history entry (so `Ctrl+Z` reverts the whole thing) and renders the confirmation panel.

**Files:**
- Modify: `src/components/SpeakerMapper.tsx`

**Interfaces:**
- Consumes: `proposeSpeakerMapping`, `SpeakerProposal`, `ProposedLabel`, `CONTAMINANT_SPEAKER`, `CALLER_TURN_WARNING` from Task 5
- Produces: nothing consumed by later tasks except the `proposal` state that Task 8 reads

- [ ] **Step 1: Add imports and state**

In `src/components/SpeakerMapper.tsx`, add to the imports near line 13:

```tsx
import {
  proposeSpeakerMapping,
  CONTAMINANT_SPEAKER,
  type SpeakerProposal,
} from '@/lib/speaker-proposal';
```

Then after the `sounderAutoAppliedRef` declaration (~line 128), add:

```tsx
  // Auto-proposal. `originalLabels` is the raw diarization label per turn,
  // snapshotted before the proposal renames anything — panel rows re-apply
  // against it so renaming stays a one-click bulk operation afterwards.
  const [proposal, setProposal] = useState<SpeakerProposal | null>(null);
  const originalLabelsRef = useRef<string[]>([]);
  const proposalAppliedRef = useRef(false);
```

- [ ] **Step 2: Apply the proposal on mount**

After the existing sounder auto-apply `useEffect` (~line 413), add:

```tsx
  // Propose a mapping once, on mount, as a SINGLE history entry so Ctrl+Z
  // reverts the whole proposal at once.
  //
  // Guarded on placeholder labels: /review/new?load= feeds this component an
  // already-mapped transcript, and re-running the proposal there would be
  // destructive — it would re-classify "birria" as a caller label and re-strip
  // turns a human already corrected by hand.
  useEffect(() => {
    if (proposalAppliedRef.current) return;
    if (initialDialogues.length === 0) return;

    const placeholders = initialDialogues.filter((d) => isPlaceholderLabel(d.name)).length;
    if (placeholders < initialDialogues.length / 2) return;

    proposalAppliedRef.current = true;
    originalLabelsRef.current = initialDialogues.map((d) => d.name);

    const result = proposeSpeakerMapping(initialDialogues, { guestName });
    setProposal(result);
    if (result.degenerate) return;

    const renames = new Map<string, string>();
    for (const label of result.labels) {
      if (label.proposedName) renames.set(label.label, label.proposedName);
    }
    const contaminated = new Set(result.contaminants.map((c) => c.index));
    if (renames.size === 0 && contaminated.size === 0) return;

    saveToHistory(`Auto-proposed mapping (${renames.size} speakers, ${contaminated.size} stray turns)`);
    setDialogues((prev) =>
      prev.map((d, i) => {
        if (contaminated.has(i)) return { ...d, name: CONTAMINANT_SPEAKER };
        const proposed = renames.get(d.name);
        return proposed ? { ...d, name: proposed } : d;
      }),
    );
  }, [initialDialogues, guestName, isPlaceholderLabel, saveToHistory]);
```

- [ ] **Step 3: Add the rename-by-original-label handler**

After `applySpeakerToIndices` (~line 406), add:

```tsx
  // Re-assign every turn whose ORIGINAL diarization label matches, so a panel
  // row still bulk-renames after the proposal has already changed the names.
  const renameProposedLabel = useCallback(
    (originalLabel: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;
      const indices = originalLabelsRef.current
        .map((label, i) => (label === originalLabel ? i : -1))
        .filter((i) => i >= 0);
      if (indices.length === 0) return;
      applySpeakerToIndices(indices, trimmed, `Rename ${originalLabel} → ${trimmed}`);
      setProposal((prev) =>
        prev
          ? {
              ...prev,
              labels: prev.labels.map((l) =>
                l.label === originalLabel
                  ? { ...l, proposedName: trimmed, confidence: 'high', warnings: [] }
                  : l,
              ),
            }
          : prev,
      );
    },
    [applySpeakerToIndices],
  );
```

- [ ] **Step 4: Render the panel**

In the JSX, immediately after the closing `</div>` of the header block and before the Audio Player block (~line 1010), insert:

```tsx
      {/* Cast panel — confirm or correct the auto-proposal */}
      {proposal && !proposal.degenerate && proposal.labels.length > 0 && (
        <div className="p-4 border-b bg-indigo-50">
          <div className="flex items-center justify-between mb-3">
            <span className="font-medium text-indigo-900">
              Proposed cast — {proposal.labels.length} labels ·{' '}
              {proposal.contaminants.length} stray turns moved
            </span>
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              className="text-sm text-indigo-700 hover:text-indigo-900 disabled:text-indigo-300"
            >
              Undo proposal
            </button>
          </div>

          <div className="space-y-1">
            {proposal.labels.map((row) => (
              <div key={row.label} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-gray-500 w-8">{row.label}</span>
                <input
                  type="text"
                  defaultValue={row.proposedName ?? ''}
                  placeholder="unassigned"
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value.trim() !== row.proposedName) {
                      renameProposedLabel(row.label, e.target.value);
                    }
                  }}
                  className={`px-2 py-1 border rounded w-44 ${
                    row.confidence === 'low' ? 'border-orange-400 bg-orange-50' : 'border-gray-300'
                  }`}
                  list="known-speakers-panel"
                />
                <span className="text-gray-600 w-28">
                  {row.kind === 'caller' && row.runTurnCount !== row.turnCount
                    ? `${row.turnCount}→${row.runTurnCount} turns`
                    : `${row.turnCount} turns`}
                </span>
                <span className="font-mono text-xs text-gray-500 w-28">
                  {row.runStart && row.runEnd ? `${row.runStart}–${row.runEnd}` : ''}
                </span>
                <span className="text-gray-500 truncate flex-1">
                  {row.warnings.length > 0 ? (
                    <span className="text-orange-700">⚠ {row.warnings.join(' · ')}</span>
                  ) : (
                    `"${row.sampleText.slice(0, 60)}…"`
                  )}
                </span>
              </div>
            ))}
          </div>
          <datalist id="known-speakers-panel">
            {speakerSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      )}
```

- [ ] **Step 5: Verify the build and behaviour**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors from `SpeakerMapper.tsx` or `speaker-proposal.ts`.

Then run `npm run dev`, open `/review/new?load=317`, and confirm **no panel appears** (that transcript is already mapped — the guard must hold). Then open a raw transcript through the normal upload flow, or temporarily point `?load=` at an unmapped episode, and confirm the panel renders with names filled in.

- [ ] **Step 6: Commit**

```bash
git add src/components/SpeakerMapper.tsx
git commit -m "feat(review): apply speaker proposal on mount and add cast panel"
```

---

### Task 8: Sample detection as a first-class step

Movie samples occur in **19 of 19** episodes (1–26 turns), scattered across principal and caller labels. Left as an optional button, this design would ship *more* samples than the flow it replaces: a sample turn on a principal label gets confidently renamed to a host, and the human is no longer paging through every turn to catch it.

Detection starts in the background on mount **after** the proposal is applied, because `/api/detect-samples` builds its `knownSpeakers` list by filtering out placeholder labels — on a raw transcript that list comes back empty.

**Files:**
- Modify: `src/components/SpeakerMapper.tsx`

**Interfaces:**
- Consumes: `proposal` state and `detectSamples` from Task 7 and existing code
- Produces: nothing

- [ ] **Step 1: Add auto-dispatch state**

Next to the existing sample-detection state (~line 121), add:

```tsx
  const sampleAutoRunRef = useRef(false);
```

- [ ] **Step 2: Dispatch detection after the proposal lands**

After the proposal `useEffect` from Task 7, add:

```tsx
  // Movie samples appear in every episode and land on host labels as often as
  // caller labels, so detection is a step of the flow, not an optional button.
  //
  // Runs AFTER the proposal so /api/detect-samples sees real speaker names —
  // it derives knownSpeakers by filtering out placeholder labels, which on a
  // raw transcript leaves that list empty.
  //
  // Concurrent with the human reading the cast panel, so it costs no
  // wall-clock, and it lands as its own history entry — separately undoable.
  useEffect(() => {
    if (sampleAutoRunRef.current) return;
    if (!proposal || proposal.degenerate) return;
    if (!episodeName) return;
    sampleAutoRunRef.current = true;
    void detectSamples();
  }, [proposal, episodeName, detectSamples]);
```

- [ ] **Step 3: Add the panel line**

Inside the cast panel from Task 7, immediately after the closing `</div>` of the `space-y-1` rows container, add:

```tsx
          <div className="mt-3 pt-3 border-t border-indigo-200 flex items-center gap-3 text-sm">
            <span className="font-mono text-gray-500 w-8">—</span>
            <span className="w-44 text-gray-700">Movie samples</span>
            <span className="flex-1">
              {detectingSamples ? (
                <span className="text-gray-500">detecting…</span>
              ) : detectedSampleCount === null ? (
                <span className="text-gray-500">not started</span>
              ) : detectedSampleCount === -1 ? (
                <span className="text-red-700">⚠ detection failed — samples may be labeled as hosts</span>
              ) : detectedSampleCount === 0 ? (
                <span className="text-orange-700">
                  ⚠ none found — every episode measured had some, so check by hand
                </span>
              ) : (
                <span className="text-gray-700">{detectedSampleCount} turns labeled</span>
              )}
            </span>
            <button
              type="button"
              onClick={detectSamples}
              disabled={detectingSamples}
              className="text-sm text-indigo-700 hover:text-indigo-900 disabled:text-indigo-300"
            >
              Re-detect
            </button>
          </div>
```

- [ ] **Step 4: Warn on continue**

Replace the `handleSubmit` callback (~line 717) with:

```tsx
  const handleSubmit = useCallback(() => {
    const sampleDetectionIncomplete =
      proposal !== null && !proposal.degenerate && (detectedSampleCount === null || detectedSampleCount === -1);
    if (sampleDetectionIncomplete) {
      const proceed = window.confirm(
        'Movie sample detection did not complete. Every episode measured contained ' +
          'movie samples, and undetected ones stay attributed to a host — which ' +
          'corrupts segment chunks and metadata extraction downstream.\n\n' +
          'Continue anyway?',
      );
      if (!proceed) return;
    }
    onMappingComplete(dialogues);
  }, [dialogues, onMappingComplete, proposal, detectedSampleCount]);
```

- [ ] **Step 5: Verify**

Run: `npm run lint && npx tsc --noEmit`
Expected: no errors.

Run `npm run dev`, open the mapping step for an unmapped transcript, and confirm: the panel shows `detecting…` then a turn count; `Apply & Continue` proceeds without a prompt once detection has succeeded; and blocking the network request produces the failure state plus the confirm dialog.

- [ ] **Step 6: Commit**

```bash
git add src/components/SpeakerMapper.tsx
git commit -m "feat(review): run sample detection as a step of the mapping proposal"
```

---

## Verification

After Task 8:

```bash
npm run test:speakers        # unit tests, 21 tests
npx tsx scripts/fetch-mapping-fixtures.ts && npm run score:speakers   # 59/72 floor, ≤2 mis-named
npm run lint
npx tsc --noEmit
```

Then map one real unmapped episode end-to-end through `/review/new` and check the two downstream signals from the spec: segment-chunk count after ingest should land near the episode's caller count (not near zero, not in the twenties), and Tier 2 / Tilda extraction should produce a full set of proposals rather than one.
