# Auto-proposed speaker mapping for `/review/new`

**Date:** 2026-08-05
**Status:** approved design, ready for implementation planning
**Scope:** new episodes only (go-forward). No backfill of existing transcripts.

## Problem

The `mapping` step of `/review/new` hands a raw diarization transcript to
`SpeakerMapper` (~1500 lines) and asks a human to assign every label by hand.
The work is slow for one specific reason: **a voicemailer's diarization label is
a real voice plus heavy contamination.** It holds one genuine 150–350 word
voicemail and a tail of stray host backchannel ("Yeah.", "Right.") scattered
across the rest of the episode, so bulk label→name mapping is unsafe and the
human is forced into turn-by-turn review.

This matters beyond ergonomics. Mapping gates the whole metadata pipeline:
`extractSegmentChunks()` keys on mapped speaker names, and Tier 2 / Tilda
extraction refuses to run on an unmapped transcript
(`scripts/generate-proposals.ts:169`). Ep 317's first ingest produced 1 proposal
instead of 6 for exactly this reason.

The episodes are not "N unknown speakers." They are 2 hosts (always Matt Haitch
and Jason Goldman), 1–2 guests whose names are known from sheet metadata before
mapping starts, 3–6 voicemailers from a recurring roster, plus movie samples and
sounders. That structure is exploitable.

## Measurements

All numbers below were measured against **19 paired episodes (299–317)**: the raw
diarization output from Blob `transcripts/raw/`, index-aligned against the
human's final mapping from Blob `transcripts/`. All 19 pairs align turn-for-turn.

Note: the git copies under `transcripts/` are stale and mostly still hold
placeholder labels. Blob is canonical for mapped transcripts. Do not use the git
copies as ground truth.

### The discriminator is words-per-turn

Caller labels are almost perfectly bimodal — one or two long turns (the real
voicemail) plus a tail of one-word backchannel. Ep 317:

| label | top turns (words) | median | turns ≥40w | turns ≤3w |
|---|---|---|---|---|
| H (Corey) | 214, 55, 30, 9, 3 | 1 | 2 | 33 |
| F (Ethan) | 89, 22, 18, 3, 3 | 1 | 1 | 18 |
| G (Kev) | 196, 4, 3, 3, 2 | 1 | 1 | 17 |
| E (birria) | 261, 38, 25, 19, 4 | 2 | 1 | 9 |
| I (Animal Mother) | 164, 31, 6, 5, 4 | 4 | 1 | 4 |

### Contamination is worse than previously recorded

Across 72 caller labels in 19 episodes, **53.5%** of a caller label's turns on
average were assigned elsewhere by the human. **43 of 72** labels were over 50%
contaminated. The prior note in memory (`episode-speaker-structure`) recorded
20–40% from ep 317 alone; that understates it.

### Contamination is not purely positional

The prior stated fix — "a turn falling far outside that caller's contiguous
block is a diarization error" — misses real cases *inside* the block. Ep 317:

- turn 775, `96:11 I (5w) "What did your dad do?"` — inside the voicemail block
- turn 788, `98:51 E (2w) "Really good."` — host backchannel mid-host-exchange

The rule that holds is **"not part of this caller's single high-word run"**,
which subsumes the positional test.

### Reassigning contaminants to a named host is a coin flip

Of 94 contaminant turns in ep 317, the nearest preceding and nearest following
principal label **disagree on 51 — 45.7% agreement**. Every disagreement is a 1–4
word backchannel ("Yeah.", "Okay.", "Mm-mm.").

### Classification generalizes exactly

Across all 19 episodes: 3 principals each (4 where there were two guests, eps 300
and 313), and **no principal label was ever actually a voicemailer or a
category**. Principal labels ran 0–7% contaminated.

Absolute turn-count thresholds do not survive the range (399–1384 turns per
episode). **Share of the episode's long turns does.**

### Movie samples are universal and scattered

Every one of the 19 episodes contains movie-sample turns — 1 to 26 per episode,
median around 7. They do **not** pool in the fragment cluster. They are spread
across raw labels, including principals:

| episode | sample turns | raw labels they came from |
|---|---|---|
| 311 | 9 | `D:7` `G:1` `F:1` — D is a principal |
| 312 | 5 | `D:4` `B:1` — both principals |
| 309 | 13 | `E:4` `A:4` `D:3` `C:2` |
| 317 | 4 | `C:3` `A:1` — C fragment, A is the guest |

`Sounder/FX` turns appear in 18 of 19 episodes, 1–5 per episode, and are already
handled by the existing `isSounderCandidate` auto-apply.

This is the reason sample detection is a first-class step of the proposal flow
rather than an optional button — see "Component 3".

### Naming accuracy

72 caller labels: **59 named correctly, 11 declined, 2 mis-named.**

Two iterations behind that number:

1. Anchoring the probe window on the caller's **first long turn** instead of the
   whole run cut mis-names 5 → 2 with no loss of correct names. The wide window
   bled into the *next* caller's intro cue, because voicemails run back-to-back.
2. **Proximity tie-breaking was tried and reverted.** Preferring the name nearest
   the body on chained handoffs ("thanks Kev, here is Corey") took mis-names
   2 → 3 and gained zero correct names. Do not re-attempt.

### The roster is incomplete by design

`DEFAULT_VOICEMAILERS` covers the recurring cast (episodes appeared in, of 19):
birria 18, Corey 18, kev voicemail 16, Animal Mother 15, Mr Java 9, Lizzen 7,
Ethan 5. But there is a long tail of one-off callers it will never contain:
Griffin, ctcher, Rusty Surfer, Jonesy Loves Beer, Buddha LeDread, Space monkey,
Silly Oswald, Proto, Derek, Sam, Bijani.

So ~82% is near the ceiling for roster matching, and most declines are genuine
strangers a human must name regardless. **An LLM naming fallback is explicitly
out of scope** — it cannot know "ctcher" either, and it would add latency and
cost to the critical path for no measurable gain.

## Approach

A pure proposal pre-pass, consumed by a single mapping screen. The proposal is
applied on mount; the human confirms or corrects rather than assigning from
scratch.

Rejected alternatives:

- **Split wizard** (confirm hosts → guest → voicemail block → sweep remainder) —
  four gates on a proposal that is usually already right, and substantially more
  UI code. It optimizes for the failure case.
- **Contamination fix downstream only** (ingest or `/api/cleanup-transcript`) —
  wrong on the merits. Mapping gates ingest, so a post-mapping fix is too late
  for the very things it protects. It also needs the raw labels, which only
  exist before mapping: once `E` has become `birria`, a stray "Really good." and
  a real birria turn are indistinguishable without re-deriving run structure.

## Component 1 — `src/lib/speaker-proposal.ts`

One pure, synchronous, dependency-free function. No network, no React, no
Anthropic import, so it is directly unit-testable against fixtures.

```ts
proposeSpeakerMapping(
  dialogues: DialogueEntry[],
  opts: { guestName?: string | null }
): SpeakerProposal
```

### Constants

Values validated against the 19-episode set. They belong in one exported,
documented block carrying the measurements above.

```ts
LONG_TURN_WORDS       = 40    // a turn this long is substantive speech, not backchannel
RUN_GAP_SECONDS       = 240   // gap that separates one voicemail run from another
PRINCIPAL_LONG_SHARE  = 0.10  // share of the episode's long turns that marks a host/guest
CALLER_MAX_LONG       = 3     // a caller delivers 1-3 substantive turns, never more
RUN_MARGIN_SECONDS    = 30    // slack when admitting turns into an isolated run
MAX_PLAUSIBLE_CALLERS = 8     // above this, run-grouping is misfiring — bail
CALLER_TURN_WARNING   = 60    // a roster name holding more turns than this is flagged
```

`PRINCIPAL_LONG_SHARE` is a share rather than an absolute count because episode
length ranges from 399 to 1384 turns across the validation set; absolute
thresholds do not survive that range.

### Pass 1 — classify labels

For each raw label, compute turn count and long-turn count (`≥ LONG_TURN_WORDS`).

- `principal` — holds `≥ PRINCIPAL_LONG_SHARE` of the episode's long turns
- `caller` — 1 to `CALLER_MAX_LONG` long turns, and not principal
- `fragment` — everything else (the leftover short-turn cluster)

Note that the fragment cluster is *not* where movie samples live. Samples are
scattered across principal and caller labels alike; classification does not and
cannot separate them. That is Component 3's job.

Share-based, not absolute counts. This is what separates the real voices from the
leftover fragment cluster, and what stops a caller label being discarded as noise.

### Pass 2 — isolate each caller's run

Take the label's long turns, group by time gap (`RUN_GAP_SECONDS`), keep the
heaviest group by total words, then admit any turn of that label inside the
group's time span plus a small margin. Everything else on the label is a
contaminant.

### Pass 3 — name

**Callers:** score `DEFAULT_VOICEMAILERS` aliases by word-boundary hits over a
window anchored on the first long turn — the 3 turns before it (host intro cue),
the turn itself (self-ID), and any short turns of the same label immediately
preceding it ("This is your brother, Animal Mother"). Self-ID in the caller's own
words is weighted 3× a host cue. **Refuse to name on a tie.**

**Principals:** extract from the cold open — `"it's Haitch"` names its own label
directly; the guest comes from `guestName`, already plumbed through from sheet
metadata; the remaining principal is Jason. Principal naming is the weakest link
in the chain and is exactly what the human confirms in the panel.

### Pass 4 — emit

Returns without mutating anything:

```ts
interface SpeakerProposal {
  labels: Array<{
    label: string;                    // "E"
    kind: 'principal' | 'caller' | 'fragment';
    proposedName: string | null;      // null = not confident
    confidence: 'high' | 'low';
    turnCount: number;
    runStart?: string; runEnd?: string;
    sampleText: string;               // longest turn, for the panel
    warnings: string[];               // "holds 349 turns", "no voicemail body"
  }>;
  contaminants: Array<{ index: number; fromLabel: string }>;
}
```

### Two deliberate choices

**Contaminants go to `Overtalk/Interjection`, not to a guessed host.** Guessing
is 45.7% accurate — a coin flip. But every disagreement is a 1–4 word backchannel
where host precision is worth nothing downstream, while getting the turn *off*
the caller label is worth everything: it is what unblocks
`extractSegmentChunks()`. `Overtalk/Interjection` already exists in
`CATEGORY_SPEAKERS`. This is the one place the design knowingly declines to be
precise.

**Low confidence leaves the raw label in place** — no name, and specifically not
`Voicemail (Unknown)`. That bucket would make the episode *look* finished (zero
unassigned turns) while being wrong, which is the wrong-metric trap that produced
the `max_speakers_expected` regression reverted in `7fd3350`. The raw label stays
orange, `n`/next-unassigned keeps working, and the panel stays honest.

## Component 2 — cast panel in `SpeakerMapper`

The proposal is applied on mount as a **single history entry**, so `Ctrl+Z`
reverts the whole proposal at once using machinery the component already has.

```
Proposed cast — 9 labels · 94 stray turns moved            [Undo proposal]
─────────────────────────────────────────────────────────────────────────
  D → Jason Goldman      high   249 turns   "Oh my God, Bugs Bunny sings…"
  B → Matt Haitch        high   231 turns   "Hey everybody, it's Haitch…"
  A → Dave Mandel        high   194 turns   "I had a— early on, we would…"
  C → ⚠ unassigned       low    129 turns   4 long turns, no clear voice
        ↳ likely mixed hosts + movie samples · [Detect Samples]
  H → Corey              high    37→ 5 turns  100:42–103:20  "…this is Corey…"
  F → Ethan              high    21→ 3 turns   85:35– 86:13  "Hello, Escape…"
  G → kev voicemail      high    19→ 1 turn    96:57         "…it's Kev here…"
  E → birria             high    14→ 4 turns   93:33– 98:51  "The Summer of…"
  I → Animal Mother      high     9→ 3 turns   90:13– 92:05  "Hello, animal…"
─────────────────────────────────────────────────────────────────────────
  Movie samples          4 turns labeled (C:3 A:1)          [Re-detect]
```

Each name is an editable field seeded from the proposal, with the existing roster
as suggestions. The turn list stays below, unchanged, as the correction path.

The `37→5` notation is the contamination fix made visible: Corey's label held 37
turns, 5 survive as his actual voicemail, 32 moved to `Overtalk/Interjection`.

### Three implementation details

**Corrections need the original labels.** Once the proposal is applied, the raw
`E`/`F`/`G` labels are gone from `dialogues`. The component snapshots
`originalLabels = dialogues.map(d => d.name)` on mount and keeps the
`SpeakerProposal` in state. Editing a row re-applies to every index whose
*original* label matched, so renaming stays a one-click bulk operation after the
names have changed.

**Guard the re-map path.** `/review/new?load=` feeds `SpeakerMapper` an
already-mapped transcript. Running the proposal there would be destructive — it
would re-classify `birria` as a caller label and re-strip turns already corrected
by hand. The proposal runs only when a majority of turns still carry placeholder
labels (`isPlaceholderLabel`). Otherwise the panel does not appear and the
component behaves exactly as today.

**The fragment cluster gets a row, not a name.** It is the leftover short-turn
cluster that no naming signal resolves. The panel names the problem and leaves it
to the human rather than guessing.

### Sanity checks are the panel

Both known mis-mapping detectors fall out of data the panel already holds: a
roster name holding more than `CALLER_TURN_WARNING` turns, or a caller label with
zero or more than `CALLER_MAX_LONG` long turns, is flagged inline via
`warnings`. Ep
317's Animal-Mother-with-349-turns is caught before it ships rather than
discovered later through segment-chunk counts. Segment-chunk count remains
useful as the post-ingest check.

## Component 3 — sample detection as a first-class step

Movie samples occur in **19 of 19** episodes and land on principal and caller
labels alike. Left as an optional button, this design would make them *more*
likely to ship than the flow it replaces: a sample turn sitting on a principal
label gets confidently renamed "Jason Goldman", the panel shows `high` confidence
with no warning, and the human — now reading nine summary rows instead of paging
through 900 turns — has lost the pass that would have caught it. Since mapping
gates the metadata pipeline, that silently poisons everything downstream.

So `/api/detect-samples` is promoted from a hint to a step of the flow.

**It starts in the background on mount, immediately after the proposal is
applied.** Ordering is not incidental: `detect-samples` builds its
`knownSpeakers` list by filtering out placeholder labels, so on a raw transcript
that list comes back empty and the model loses the context it uses to spot
non-participant audio. Running it after the proposal has assigned real names
gives it "Matt Haitch, Jason Goldman, Dave Mandel, Corey…" to work against.

Because it runs concurrently with the human reading the cast panel, it adds no
wall-clock. Results merge in as a **second history entry**, separately undoable
from the proposal itself. The panel carries a dedicated line:

```
  Movie samples    detecting…  →  4 turns labeled  (C:3 A:1)
```

`Apply & Continue` warns when detection never ran or errored. Given 19/19
prevalence, **"no samples found" is a suspicious result, not a clean one**, and
the panel says so rather than presenting it as success.

This is a deliberate exception to the "no LLM in the critical path" position
taken for naming. That position holds for naming, where an LLM cannot know
off-roster callers like "ctcher" and would add cost for no measured gain. It does
not hold here: there is no deterministic alternative, and the need is universal.
The call is off the critical path anyway — it is concurrent, and failure is
non-blocking.

### Interaction with the contamination pass

A sample turn sitting on a caller label, outside that caller's run, is swept to
`Overtalk/Interjection` by Pass 2 before detection returns. That is acceptable —
the primary goal, getting it off the caller label so `extractSegmentChunks()` is
not corrupted, is met. Detection results take precedence where they overlap, so
such a turn ends up correctly labeled `Movie Sample`.

## Error handling — fail open

The module never throws and never blocks. On a degenerate result it returns an
empty proposal and the mapping step behaves exactly as it does today:

- **Zero principals** — diarization is badly wrong; do not touch it.
- **More than `MAX_PLAUSIBLE_CALLERS` callers** — run-grouping is misfiring. The
  validation set peaked at 6 caller labels in one episode.
- **Two labels proposing the same name.** Most important of the three. Two labels
  both scoring "Kev" would build Kev's segment chunks from a host cluster — the
  Animal-Mother failure, reintroduced automatically. Both drop to low confidence
  and keep their raw labels rather than one silently winning.

Narrower cases degrade rather than bail. **No voicemail block** (some episodes
have none) yields zero callers and a principals-only proposal. **No guest** yields
two principals; a third principal with no `guestName` to bind to is marked low
confidence rather than guessed. **Movie-sample clusters that look like callers**
(eps 303 and 312 were exactly this) fail to match the roster, land as declines,
and are resolved by Component 3.

Sample detection failing is non-blocking by construction: the proposal stands,
the panel shows the error on its Movie samples line, and `Apply & Continue`
warns. The human can retry it or proceed knowingly.

## Testing

Unit tests against fixtures drawn from the 19 paired episodes. Ep 317's raw form
is already in git; additional fixtures are pulled from Blob `transcripts/raw/`
with their `transcripts/` counterparts as expected output.

Assertions:

- classification matches the human's mapping — every `principal` label resolves
  to a host or the known guest, never to a roster caller or a category
- caller naming accuracy does not regress below the measured **59/72**
- **mis-names do not exceed the measured 2/72** — this is the metric that matters
  most; declining is cheap, a wrong name is not
- every turn of a genuine voicemail body survives: **no long turn is ever stripped
  as a contaminant**
- the degenerate guards fire on synthetic fixtures (duplicate-name, no-principal,
  guest-absent)
- sample detection is dispatched after the proposal is applied, not before, so
  `knownSpeakers` is non-empty when it runs
- a sample-detection failure leaves the proposal intact and surfaces a warning,
  rather than blocking or silently passing

Component 3 is not unit-tested for detection *accuracy* — that is `/api/detect-
samples`' own measured ~5% false-positive behaviour, unchanged by this work. What
is tested is the wiring: ordering, non-blocking failure, and the warning path.

**Explicitly not asserted:** unassigned-turn count, or label count. A test that
rewards tidiness is the test that would have passed the `max_speakers_expected`
regression. The suite scores correct naming and body preservation only.

Threshold constants live in one exported, documented block carrying these
measurements — the same pattern as the rationale comment in
`src/lib/transcription-config.ts` — so anyone retuning them sees the evidence
first, including the reverted proximity experiment.

## Out of scope

- Backfill of existing transcripts (go-forward only, per decision)
- LLM **naming** fallback — cannot name off-roster callers, adds latency for no
  measured gain. This is scoped to naming only; LLM sample detection is in scope
  and is Component 3.
- Any change to `max_speakers_expected` / `min_speakers_expected`. Narrowing the
  range was tried, shipped, and reverted in `7fd3350`: capping at 5 collapsed all
  five callers into hosts (0/5 distinct) while looking clean by turn-count
  metrics. Contamination is a post-processing problem.
- Rebuilding cleanup, sample detection, or raw preservation — all exist

## Follow-ups noted, not included

- `DEFAULT_VOICEMAILERS` could gain the repeat off-roster callers (Griffin
  appears in 2 of 19 episodes) — a data change, not a design change.
- Existing mapped data holds case-variant duplicates: `Kev`/`kev voicemail`,
  `silly oswald`/`Silly Oswald`, `movie sample`/`Movie Sample`. Argues for
  normalizing speaker names on write. Separate piece of work.
