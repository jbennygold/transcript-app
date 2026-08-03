# Automated Population of the Pod Data Central Sheet

## Context

The canonical episode metadata lives in a Google Sheet (`Pod Data Detail` tab, sheet ID
`1RbtWP966CxA57PatyMcbJ6_ylg9tmCvDSLNxjmQ4bvk`). Historically every column was filled in by hand by a
community reviewer after an episode aired. This design automates the columns that can be derived —
from third-party APIs, from the audio, and from the transcript — while keeping a human gate on
anything a model inferred.

The sheet remains the source of truth. `scripts/sync-metadata.ts` reads it and regenerates
`src/lib/metadata-data.ts`, which the search app consumes. Nothing about that direction changes.

## Goals

- Remove manual data entry for fields that are mechanically derivable.
- Never silently overwrite a human-entered value with a machine-derived one.
- Give contributors a low-friction way to add Notable Moments, with an approval step.
- Reuse the existing write path, review UI, and Discord bot rather than building parallel ones.

## Non-goals

- Changing how new episodes are detected. Matt continues to stub the row (Season, Ep, Film,
  Release_Date, Guest) and trigger the workflow from Discord; he depends on that step for his own
  workflow.
- Changing the sheet's schema. No new columns.
- Backfilling historical episodes. The pipeline is new-episodes-only. Backfill may follow once the
  extractors are calibrated, as separate work.
- Ongoing population of `H_Flex` / `J_Flex`. They stay in the sheet as historical columns and are
  never written by this pipeline.

## Current state

Substantial parts of this already exist and are reused as-is.

| Capability | Where it lives today |
| --- | --- |
| Write to the sheet | `POST /api/podreview/update-pdc` — upsert by `Ep` against `Pod Data Detail`, header aliasing, refuses to overwrite a filled cell with a blank (`route.ts:191`) |
| Length, artwork, show link, release date | `GET /api/podreview/match-episode` (Spotify + Patreon), consumed at `podreview/page.tsx:303` |
| Letterboxd + IMDB links | `POST /api/podreview/tmdb-search` from the stored `tmdbId`, consumed at `podreview/page.tsx:419` |
| Fill-empty-only semantics | `onlyFillEmpty` flag, `podreview/page.tsx:292` — client-side only today |
| Kev segment isolation | `extractSegmentChunks()` in `scripts/ingest.ts`; Kev is one of six known voicemailers |
| Submit → admin approve pattern | `/api/transcription-reports` + `/review/submissions` |
| Episode announcements | `scripts/notify-discord.ts`, events `needs-mapping` / `ingested` / `no-new-episodes` |
| Ingest trigger | "Publish to Search" button, `review/[episode]/page.tsx:502` → `ingest-episode.yml` |

The gap is that none of the derivation runs headless. It all requires a human clicking through
`/podreview`.

## Workflow

1. Matt uploads audio to the Drive `Audio Files/<film>` folder.
2. Matt stubs the sheet row: Season, Ep, Film, Release_Date, Guest.
3. Matt triggers `new-episodes.yml` from Discord via `/pdc-check-episodes`.
   - **New:** after sync and transcription, Tier 1 fills the deterministic columns.
4. Jason does speaker mapping and cleanup at `/review/<ep>`, then clicks Publish to Search.
   - **New:** after ingest, Tier 2 writes extraction *proposals* to Blob and announces them.
5. **New:** Jason confirms or edits the proposals in `/podreview`; accepted values go to the sheet.
6. **New:** the bot opens notes collection in `#engineers`; contributors submit via `/pdc-note`;
   Jason approves in `/review/submissions`; accepted notes append to `Notable_Moments`.

## Field ownership

| Field | Owner | Write mode |
| --- | --- | --- |
| Pod, Season, Ep, Film, Release_Date, Guest | Matt (stub) | manual |
| Length, Length_minutes | Tier 1 | fill-empty |
| Show_Link, Artwork_Link | Tier 1 | fill-empty |
| Letterboxd_Link, IMDB_Link | Tier 1 | fill-empty |
| Film canonicalization | Tier 2 | staged proposal |
| MMM_Count, Thats_Great_Count | Tier 2 | staged proposal |
| Kevs_Question | Tier 2 | staged proposal |
| TildaH, TildaJason, TildaGuest, TildaCorey | Tier 2 | staged proposal |
| Notable_Moments | Component 4 (Engineers Notes) | append on approval |
| Reviewer | pipeline sentinel `auto`, overwritten by whoever confirms | fill-empty |
| H_Flex, J_Flex | nobody — historical only | never written |
| Chuckle_Hut_Favorites | nobody | never written |

`Chuckle_Hut_Favorites` appears in `RawCSVRow` (`sync-metadata.ts:54`) but `convertRow()` never reads
it and `EpisodeMetadata` has no corresponding field, so it never reaches the app. It is left alone.

`H_Flex` and `J_Flex` are `"N/A"` in 274 and 281 rows respectively out of ~316 — roughly 35 real
values total, each an unstructured personal anecdote. Not worth an extractor.

## Component 1 — Shared sheet-write library

**New file**: `src/lib/pdc-sheet.ts`

The header-mapping and upsert logic currently inside `src/app/api/podreview/update-pdc/route.ts`
moves here so both the API route and CI can use it. This is a prerequisite for everything else —
Tier 1 runs in GitHub Actions and cannot call an auth-gated Vercel route conveniently.

```typescript
type WriteMode = 'fill-empty' | 'overwrite';

interface UpsertResult {
  action: 'inserted' | 'updated' | 'no_change';
  changedFields: string[];
}

async function upsertEpisodeRow(
  row: Partial<Record<PdcColumnKey, string>>,
  mode: WriteMode
): Promise<UpsertResult>;

async function appendToCell(
  episode: string,
  column: PdcColumnKey,
  line: string
): Promise<UpsertResult>;
```

- `fill-empty` writes a value only when the target cell is currently blank. `overwrite` keeps
  today's behaviour: write when non-blank and different, never clobber with a blank.
- `appendToCell` is a read-modify-write used only for `Notable_Moments`.
- `update-pdc/route.ts` becomes a thin auth + validation wrapper calling `upsertEpisodeRow(row,
  'overwrite')`, preserving its current behaviour exactly.
- `scripts/sync-metadata.ts:216` currently requests `spreadsheets.readonly`. It stays read-only —
  only the new write paths request the `spreadsheets` scope. CI already has
  `GOOGLE_SERVICE_ACCOUNT_KEY_JSON`.

The `Reviewer` field is required by `update-pdc` (`route.ts:107`) and denotes the community member
who filled the row (`birria`, `Space Monkey`, `Hex`, …). Machine-written rows use the sentinel
`auto`, which doubles as a queryable marker for rows nobody has confirmed yet.

## Component 2 — Tier 1, deterministic fill

**Runs**: inside `scripts/check-new-episodes.ts`, after transcription, before the report is written.
Also re-runs each scheduled cron pass for any row still missing Tier 1 values.

**Fields**: `Length`, `Length_minutes`, `Show_Link`, `Artwork_Link`, `Letterboxd_Link`, `IMDB_Link`.

**Sources**: the logic already behind `/api/podreview/match-episode` (Spotify + Patreon) and
`/api/podreview/tmdb-search`. Both currently live in route handlers; the fetch-and-parse portions
move to `src/lib/episode-sources.ts` so CI and the routes share them.

**Write mode**: `fill-empty` — always. A Tier 1 pass can never change a cell that already has a
value, which makes it safe to re-run on every cron pass.

The re-run matters: if Matt uploads audio before the episode publishes, Spotify and Patreon have
nothing to match, so `Show_Link` and `Artwork_Link` stay blank until a later pass finds them.

## Component 3 — Tier 2, staged extraction

**Runs**: as a new step in `.github/workflows/ingest-episode.yml`, after the ingest step, so the
transcript has been speaker-mapped and cleaned. This is load-bearing — `TildaH` vs `TildaJason`
depends entirely on correct speaker attribution, and an unmapped transcript has placeholder
speakers.

**Fields and methods**:

- **`Kevs_Question`** — Kev is one of the six voicemailers with dedicated segment sub-chunks from
  `extractSegmentChunks()`. Extraction is a single Haiku call scoped to the Kev segment. Highest
  confidence of the Tier 2 set.
- **`TildaH` / `TildaJason` / `TildaGuest` / `TildaCorey`** — a structured recurring bit: each host
  names which role Tilda Swinton should play. Haiku call over the transcript. Guest and Corey
  variants are frequently absent and must be allowed to come back null.
- **`MMM_Count` / `Thats_Great_Count`** — deterministic scan over transcript turns, not an LLM call.
  ASR renders these inconsistently (`mm`, `hmm`, `mmm-hmm`, `Mmm.`) and "that's great" has a literal
  sense as well as the catchphrase sense, so the counting rule needs calibration before it is
  trusted. See below.
- **Film canonicalization** — if TMDB returns a canonical `Title (YYYY)` that differs from Matt's
  entry, propose the correction. This is staged rather than fill-empty because `Film` is never blank
  after Matt's stub, and because title mismatch is a known failure mode: `findFilmFromQuery()`
  matches against canonical titles with year suffixes, and `normalizeEpisodeTitle()` exists solely to
  reconcile the two forms.

**Output**: proposals are written to Blob at `pdc-proposals/ep{N}_{timestamp}.json`, matching the
shape and lifecycle of `cleanup-feedback/` and the transcription reports. Nothing is written to the
sheet by this component.

```typescript
interface FieldProposal {
  column: PdcColumnKey;
  proposed: string;
  current: string | null;   // sheet value at proposal time
  confidence: 'high' | 'low';
  evidence?: string;        // quote or turn reference backing the value
}

interface EpisodeProposals {
  episode: string;
  createdAt: string;
  proposals: FieldProposal[];
}
```

**Review**: `/podreview` already loads every one of these fields for a given episode
(`page.tsx:380-410`). It gains a proposals banner — per-field accept/reject with the proposed value
shown against the current one, plus accept-all. Accepting calls `upsertEpisodeRow(…, 'overwrite')`.

**Announcement**: `notify-discord.ts` gains an `--event=proposals-ready` case, posting to
`#pod-data-central` with the episode and a link to `/podreview`.

### Calibration gate for the counters

`MMM_Count` and `Thats_Great_Count` ship behind a flag that records the derived count alongside the
existing hand-entered value without proposing it. Roughly 300 episodes already carry hand counts —
that is the eval set. The counters only start producing proposals once their accuracy against that
set is measured and accepted. Everything else in Tier 2 ships without this gate.

## Component 4 — Engineers Notes

Replaces manual `Notable_Moments` entry. The bot currently runs
`intents: [GatewayIntentBits.Guilds]` (`transcript-bot/scripts/discord-bot.ts:661`); this design
keeps it that way. Reading thread replies or reactions would require `GuildMessages`,
`GuildMessageReactions`, and the privileged `MessageContent` intent, plus reaction polling to survive
Railway restarts — considerable infrastructure for less capability than a slash command, and with no
audit trail or edit path.

**Flow**:

1. `ingest-episode.yml` fires `notify-discord.ts --event=notes-open`, posting the episode to
   `#engineers`.
2. The app records that episode as the currently open one for notes.
3. Contributors run `/pdc-note note:"…"`. The episode is implicit — it attaches to the open episode.
   An optional `ep:` argument covers late notes on an older episode.
4. The bot POSTs to a new `POST /api/episode-notes`, which stores to Blob at
   `episode-notes/ep{N}_{timestamp}.json` with the submitter's Discord tag and timestamp.
5. `/review/submissions` gains a notes tab: accept, reject, or edit-then-accept per note, matching
   the existing `CleanupReview` interaction model.
6. On accept, `appendToCell(episode, 'Notable_Moments', '- ' + note)`.

**Format**: `Notable_Moments` is already newline-delimited with `- ` bullets in existing rows, so
appending a bullet per accepted note matches the established convention and keeps
`searchNotableMoments()` tokenization working unchanged.

**Access**: `/pdc-note` is open to any member of the `#engineers` channel — collection is meant to be
low-friction, and the approval step is the gate. This differs from `/pdc-check-episodes`, which is
role-gated via `EPISODE_TRIGGER_ROLE` because it triggers billable work.

## Risks and mitigations

**Silent overwrite of human values.** The largest risk. `update-pdc` protects against blanking a
filled cell but not against a wrong machine value replacing a correct human one, and re-ingest fires
on every cleanup pass. Mitigated structurally: Tier 1 is `fill-empty` only, and Tier 2 never writes
to the sheet at all — it writes proposals a human accepts.

**Drive folder matching.** Since detection stays sheet-driven, `download-drive-audio.ts` still
matches Matt's `Film` string against Drive folder names by fuzzy scoring (≥60% word overlap plus
year agreement, minimum score 50). A title typo yields "Audio not found in Drive" buried in a job
summary. Mitigation: the script already computes an `unmatched` folder list — surface it in the
Discord reply so a mismatch is visible where the run was triggered. Small change, included in scope.

**Write-back lag.** A sheet write does not reach `src/lib/metadata-data.ts` until the next
`sync-metadata` run, so accepted Tier 2 values appear in the app on the following cron pass.
Accepted, not mitigated: triggering a sync on each acceptance would add a second concurrent writer to
`metadata-data.ts`, which `new-episodes.yml` already carries elaborate rebase-recovery code to
handle.

**Extraction quality.** Kev and Tilda extraction can be wrong. Mitigated by staging — a wrong
proposal costs one rejection click and never reaches the sheet.

## Sequencing

1. `src/lib/pdc-sheet.ts` extracted; `update-pdc` refactored onto it with behaviour unchanged.
2. `src/lib/episode-sources.ts` extracted from the match-episode and tmdb-search routes.
3. Tier 1 wired into `check-new-episodes.ts`. Deliverable on its own — removes six columns of manual
   entry with no model involvement.
4. Unmatched-Drive-folder reporting in the Discord reply.
5. Tier 2 proposal generation and storage; `/podreview` proposals banner; `proposals-ready`
   notification. Kev, Tilda, and Film canonicalization only.
6. MMM / That's Great counters in measure-only mode; calibrate against the ~300 hand-counted rows;
   enable proposals if accuracy is acceptable.
7. Engineers Notes: `/api/episode-notes`, `/pdc-note` command, `notes-open` event, submissions tab.

Steps 1–4 have no model involvement and no approval surface, so they can ship and prove out before
any of the extraction work begins.
