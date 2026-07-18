# Transcription Error Reports — Design

**Date:** 2026-07-18
**Status:** Approved (pending spec review)

## Problem

Matt's `explore.escapehatchpod.com` app surfaces transcription mistakes while
readers browse — the most common being **movie samples misattributed to a
speaker** (a film clip transcribed and labeled as Jason or Matt). Today there is
no way for his app to file that back to us. We want:

1. An API for his app to **file a transcription error report**.
2. A **review surface** where Jason can see pending reports and, on explicit
   approval, apply the fix to the transcript.

## Hard invariant

**Nothing is ever applied to a transcript without explicit per-report approval
from Jason.** Filing a report, the Discord ping, and the review queue are all
read-only with respect to transcripts. The only code path that mutates a
transcript is the resolve endpoint invoked by an explicit **Approve & apply**
action on a single report. There is no batch-apply, no auto-apply, and no
"apply all".

## Existing building blocks (reused, not rebuilt)

- **External auth** — `validateExternalKey(x-eh-key)` against the
  `EH_EXTERNAL_KEYS` allowlist (`src/lib/external-auth.ts`); the allowlist
  already uses `explore` as an example keyId. Matt's app already carries a key
  for `/api/external/search`.
- **External rate limiting** — `checkRateLimit(keyId)`
  (`src/lib/external-rate-limit.ts`).
- **Blob queue + query pattern** — `cleanup-feedback` route: one JSON per entry
  under a prefix, `list()` + `fetch()` to read back.
- **Correction shape** — `CleanupChange` from
  `src/app/api/cleanup-transcript/route.ts`:
  `{ index, type: 'sample'|'spelling'|'speaker'|'voicemailer', field: 'name'|'text', oldValue, newValue, reason }`.
- **Apply/write path** — `src/app/review/[episode]/page.tsx` applies a
  `CleanupChange` to the dialogue (`d.name = newValue` for `field:'name'`,
  `d.text = newValue` for `field:'text'`), then `PUT /api/transcripts/{ep}`
  followed by `POST /api/rebuild` to re-ingest.
- **Discord** — `postToDiscord(webhookUrl, payload)` in `scripts/notify-discord.ts`
  and the `DISCORD_PDC_WEBHOOK_URL` secret (already wired for episode
  notifications to #pod-data-central).

## Data flow

```
Matt's app  ──POST /api/external/transcription-error (x-eh-key)──┐
                                                                 ├─→ Blob queue ──→ /review/reports (Jason)
/review "report" button ──POST /api/transcription-reports───────┘  (status:pending)   │
                                                                    └─→ Discord #pod-data-central ping
                                          Approve & apply (explicit, per-report) ─→ PUT transcript + POST /api/rebuild
```

## 1. Ingest endpoint — `POST /api/external/transcription-error`

Reuses the middleware chain from `/api/external/search`:
`validateExternalKey(x-eh-key)` → `checkRateLimit(keyId)` → JSON validation.

Request body:

```jsonc
{
  "episode": 119,
  "anchor": {
    "startTs": "01:12:04",
    "endTs": "01:12:31",          // optional
    "speaker": "Jason Goldman",   // speaker label the reporter saw
    "originalText": "..."          // exact text of the flagged turn
  },
  "correction": {
    "type": "sample",             // sample | spelling | speaker | voicemailer
    "field": "name",              // name | text
    "newValue": "Movie Sample"    // relabel value, or corrected text for spelling
  },
  "note": "Galaxy Quest clip, not Jason",   // optional freeform
  "reporterName": "matt-explore"             // optional
}
```

Validation:
- Auth: missing key → 401 `Missing x-eh-key header`; invalid → 401 `Invalid key`.
- Rate limit exceeded → 429 with `Retry-After`.
- Invalid JSON → 400.
- `episode` must be a positive integer that resolves to a known episode.
- `anchor.startTs` non-empty string; `anchor.originalText` non-empty string.
- `correction.type` ∈ enum; `correction.field` ∈ {`name`,`text`}; `correction.newValue`
  non-empty and **not equal** to `anchor.originalText` (for `field:'text'`) or
  to `anchor.speaker` (for `field:'name'`).

On success: write a `pending` `TranscriptionReport` (source = keyId), fire the
Discord ping, return `{ id }`. **No dialogue-turn index is accepted in the
payload** — location is anchored on text + timestamp and resolved later.

## 2. Storage — Blob, mirrors `cleanup-feedback`

Prefix `transcription-reports/`, one JSON per report named
`tr_<createdAtMs>_<rand>.json` with `addRandomSuffix: false` and
`allowOverwrite: true` so status transitions rewrite the same object in place.

```ts
interface TranscriptionReport {
  id: string;                    // tr_<ts>_<rand>
  createdAt: string;             // ISO
  source: string;                // keyId ('explore') or 'internal'
  status: 'pending' | 'applied' | 'dismissed' | 'stale';
  episodeNumber: number;
  anchor: {
    startTs: string;
    endTs?: string;
    speaker: string;
    originalText: string;
  };
  correction: {
    type: 'sample' | 'spelling' | 'speaker' | 'voicemailer';
    field: 'name' | 'text';
    newValue: string;
  };
  note?: string;
  reporterName?: string;
  resolvedAt?: string;           // ISO, set on apply/dismiss
  resolvedTurnIndex?: number;    // set only when applied
}
```

`correction` maps 1:1 onto `CleanupChange` at apply time (the resolved turn index
becomes `CleanupChange.index`, `anchor.originalText`/`anchor.speaker` become
`oldValue`).

Resolved reports (`applied` / `dismissed` / `stale`) are **retained** in Blob as
an audit trail, not deleted.

## 3. Anchor resolver (shared library)

`src/lib/resolve-report-anchor.ts` — pure function, unit-tested:

```ts
type ResolveResult =
  | { status: 'match'; index: number }
  | { status: 'already_fixed' }          // current turn already equals newValue
  | { status: 'not_found' }
  | { status: 'ambiguous'; indexes: number[] };

resolveReportAnchor(transcript, report): ResolveResult
```

Algorithm:
1. Normalize whitespace/case for comparison.
2. Candidate turns = those whose `text` matches `anchor.originalText` (normalized).
   Prefer candidates whose timestamp is at/near `anchor.startTs` to break ties.
3. Zero candidates:
   - If some turn near `startTs` already has `field` == `newValue` → `already_fixed`.
   - Else → `not_found`.
4. Exactly one candidate → `match`.
5. More than one candidate that timestamp can't disambiguate → `ambiguous`.

`match` is the only result that permits applying. `already_fixed`, `not_found`,
and `ambiguous` all surface as **STALE** in the UI (apply disabled).

## 4. Review surface — new page `/review/reports`

Unauthenticated, consistent with the rest of `/review` (internal tool).

- `GET /api/transcription-reports?status=pending` — lists reports via Blob
  `list()` + `fetch()` (mirrors `cleanup-feedback` GET). Supports
  `?status=pending|applied|dismissed|stale|all` (default `pending`) and optional
  `?episode=N`.
- Page groups pending reports by episode. Each report card shows:
  - anchor context (speaker, timestamp, `originalText`),
  - the proposed change rendered red→green (reusing `CleanupReview` styling),
  - `source`, `reporterName`, and `note`,
  - a **STALE** badge when the anchor doesn't resolve to a single live turn.
- Actions per card: **[Approve & apply]** (enabled only on a confident single
  match) and **[Dismiss]**. No bulk actions.

## 5. Resolve/apply endpoint — `POST /api/transcription-reports/[id]/resolve`

Body `{ action: 'apply' | 'dismiss' }`.

- `apply`:
  1. Load the report; must be `pending` (else 409).
  2. Load the **current** transcript for `episodeNumber`.
  3. Run `resolveReportAnchor` **server-side, authoritatively** — the client's
     view is never trusted. If result ≠ `match`, do **not** write; update the
     report to `stale` and return `{ status: 'stale', reason }`.
  4. On `match`: set `dialogue[index][field] = newValue`,
     `PUT /api/transcripts/{ep}`, `POST /api/rebuild` (same path
     `CleanupReview` uses), then set report `status:'applied'`,
     `resolvedTurnIndex`, `resolvedAt`.
- `dismiss`: set `status:'dismissed'`, `resolvedAt`. No transcript write.

Re-resolving server-side at apply time is what enforces the hard invariant and
the stale-safety guarantee: a report that went stale between filing and approval
can never corrupt a transcript.

## 6. Notifications + unifying the internal button

- Extract `src/lib/discord-notify.ts` exposing an API-callable
  `notifyDiscord(payload)` (reuses `postToDiscord` and an amber embed builder;
  no-ops when `DISCORD_PDC_WEBHOOK_URL` is unset, matching the script's
  behavior).
- New report → post an embed: episode label, `type`, `original → newValue`,
  `source`, and `note`.
- The existing `/review` "report error" button is repointed from
  `/api/transcription-error` (Resend email) to
  `POST /api/transcription-reports` with `source: 'internal'`, mapping its
  current fields (`selectedText`, `correctedText`, timestamps, speakers) into the
  `anchor` + `correction` shape (`field:'text'`, `type:'spelling'` default).
- **The old Resend `/api/transcription-error` route is retired** once the button
  is repointed.

## 7. Endpoints summary

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/external/transcription-error` | `x-eh-key` + rate limit | Matt's app files a report |
| `POST /api/transcription-reports` | none (internal) | Internal report button files a report |
| `GET /api/transcription-reports` | none (internal) | List reports for the review page |
| `POST /api/transcription-reports/[id]/resolve` | none (internal) | Apply (explicit) or dismiss one report |

The two "file a report" callers share a single writer helper
(`saveTranscriptionReport()`) so the Blob shape and Discord ping are identical
regardless of source.

## 8. Testing

- **Unit — anchor resolver** (`resolve-report-anchor.test.ts`): exact match;
  whitespace/case-diff match; already-fixed → `already_fixed`; missing text →
  `not_found`; duplicate text at different timestamps → `ambiguous`;
  timestamp tie-break selects the right turn.
- **Unit/route — ingest validation**: auth reject (missing/invalid key), rate
  limit, invalid JSON, bad `type`, empty/identical `newValue`, unknown episode.
- **Manual (agent-browser)**: file a report via `curl` with the `explore` key →
  it appears on `/review/reports` → **Approve & apply** → confirm the transcript
  Blob updated and `/api/rebuild` ran → report shows `applied`. Then file a
  report whose text was already fixed → confirm it renders **STALE** and apply is
  disabled.

## Defaults chosen (not asked)

- Internal button keeps its current fields, mapped into the new shape.
- `/review/reports` is unauthenticated like the rest of `/review`.
- Resolved reports are retained in Blob for audit, not deleted.

## Out of scope (YAGNI)

- Bulk apply / apply-all (violates the hard invariant).
- Report editing before apply (dismiss + refile instead).
- Per-reporter dashboards or acceptance-rate analytics (the `cleanup-feedback`
  analytics pattern exists if wanted later).
- Notifying Matt's app of the outcome (no callback/webhook back to `explore`).
