# Transcript & Audio Lifecycle

How transcripts and MP3s are created, stored, and accessed across Blob, filesystem, and GitHub.

## Storage Locations at a Glance

| Asset | Vercel Blob | Filesystem | Git |
|-------|------------|------------|-----|
| **MP3 audio** | `audio/episode_{N}.mp3` | `mp3s/{N}.mp3` (local cache) | No (gitignored, ~120 MB each) |
| **Raw transcript** | `transcripts/raw/episode_{N}.json` | No | No |
| **Mapped transcript** | `transcripts/episode_{N}.json` | `transcripts/episode_{N}.json` | Yes |
| **Vector store** | `search-data/vector-store.json` | `vector-store.json` (build artifact) | No (~90 MB) |
| **BM25 index** | `search-data/bm25-index.json` | `bm25-index.json` (build artifact) | No (~24 MB) |
| **Topic vectors** | `search-data/topic-vectors.json` | `topic-vectors.json` (build artifact) | No (~54 MB) |
| **Metadata** | No | `src/lib/metadata-data.ts` | Yes |
| **Cleanup feedback** | `cleanup-feedback/ep{N}_{ts}.json` | No | No |
| **Job metadata** | `jobs/{jobId}.json` | No | No |

## 1. Audio (MP3)

### Creation
1. `scripts/download-drive-audio.ts` resolves each episode in this order:
   1. **Google Drive** (primary) — matches metadata to Drive folder names by
      title + year, with a second pass that probes container folders like
      "Best Of" for file-level matches.
   2. **Public RSS feed** (`src/lib/podcast-feed.ts`, Anchor.fm by default) —
      fallback for episodes Drive can't serve. Matches the feed's `<title>`
      against the metadata `film` field. Set `PODCAST_RSS_URL` to override.
2. The MP3 is written to `mp3s/{N}.mp3` regardless of source so the rest of
   the pipeline (`batch-transcribe.ts`) is source-agnostic.
3. The final report shows the count for each source: `X downloaded
   (Y drive, Z rss), ...`.

### Upload to Blob
- `scripts/batch-transcribe.ts` calls `uploadAudioToBlob()` → `audio/episode_{N}.mp3`
- Public URL, supports HTTP range requests for streaming

### Access
- **Review page**: `GET /api/audio/{episode}` → serves local file (dev) or redirects to Blob URL (prod)
- **HTML `<audio>` tag** with range request support for seeking

## 2. Transcripts

### Creation Flow

```
Google Drive MP3  ──┐
                    ├─→ download-drive-audio.ts → mp3s/{N}.mp3
Anchor.fm RSS MP3 ──┘     (Drive first; RSS fallback by film-title match)
    → batch-transcribe.ts → AssemblyAI (6-10 speakers, word boosting)
      → saveRawTranscript() → Blob: transcripts/raw/episode_{N}.json  (write-once)
      → saveTranscript()    → Blob: transcripts/episode_{N}.json       (overwritable)
```

Both `batch-transcribe.ts` and the webhook handler (`/api/transcribe/webhook`) save raw + mapped on completion.

### Format
```json
{
  "episode_number": 295,
  "episode_name": "Fast Times at Ridgemont High (1982)",
  "dialogues": [
    { "name": "Speaker A", "timestamp": "00:00:01", "text": "..." },
    ...
  ]
}
```

Raw transcripts use diarization labels (Speaker A, B, C...). Mapped transcripts use real names (Matt Haitch, Jason Goldman, etc.).

### Editing Flow (Review UI)
1. **Load**: `GET /api/transcripts/{episode}` → Blob first, filesystem fallback
2. **Edit**: Speaker mapping, cleanup fixes applied in browser
3. **Save**: `PUT /api/transcripts/{episode}` → always writes to Blob (`allowOverwrite: true`), attempts filesystem too

### Reset Flow
- `DELETE /api/transcripts/{episode}` → loads raw from `transcripts/raw/`, overwrites mapped version
- Reverts speaker labels to A, B, C... without re-transcribing

### Syncing Blob → Filesystem → Git
Edits made via the review UI only go to Blob. To persist in git:
1. Download from Blob to `transcripts/` (manually or via `check-new-episodes.ts`)
2. Commit and push

**Warning**: Ingest reads filesystem first. If filesystem has stale version, Blob edits are ignored during re-ingestion. Always sync Blob → filesystem before ingesting.

## 3. CI Automation

`.github/workflows/new-episodes.yml` (daily cron or manual):

```
1. Sync metadata from Google Sheets (PDC) → metadata-data.ts
2. Detect new episodes (metadata vs existing transcripts)
3. Download audio → mp3s/
     (Drive first; RSS fallback for anything Drive can't serve)
4. Batch transcribe → Blob (raw + mapped)
5. Download transcripts from Blob → transcripts/ (for git)
6. git commit metadata-data.ts + transcripts/episode_*.json
7. git push → triggers Vercel deploy
```

The pipeline is **PDC-triggered** — a new row in the metadata sheet is what
kicks off transcription. RSS is consulted only to source the MP3 when Drive
doesn't have it; it never causes an episode to be transcribed on its own.

## 4. Search Index Pipeline

```
transcripts/episode_*.json (filesystem, primary)
  + Blob transcripts (for episodes not on filesystem)
    → scripts/ingest.ts
      → Chunk (~500 tokens, 50-token overlap)
      → Sub-chunks: personal asides (_1000+), catchphrases (_2000+), segments (_3000+)
      → OpenAI embeddings (3072-dim)
      → BM25 inverted index
      → Topic summaries via Haiku + 512-dim embeddings
    → vector-store.json, bm25-index.json, topic-vectors.json (local)
      → scripts/upload-search-data.ts
        → Blob: search-data/vector-store.json
        → Blob: search-data/bm25-index.json
        → Blob: search-data/topic-vectors.json
```

At runtime, `vectorstore.ts` loads these from Blob into memory (cached per Lambda instance).

## 5. Key Access Patterns

| Operation | Source Priority | Files Involved |
|-----------|----------------|----------------|
| **Read transcript** (API) | 1. Blob, 2. Filesystem | `api/transcripts/[episode]/route.ts` |
| **Save transcript** (API) | 1. Blob (required), 2. Filesystem (best-effort) | Same |
| **Ingest transcripts** | 1. Filesystem, 2. Blob (for missing) | `scripts/ingest.ts` |
| **Agent search** (grep) | Filesystem only (bundled via `outputFileTracingIncludes`) | `src/lib/agent-search.ts` |
| **Vector search** | Blob (search-data/) | `src/lib/vectorstore.ts`, `hybrid-retrieval.ts` |
| **Audio playback** | 1. Filesystem (dev), 2. Blob redirect (prod) | `api/audio/[episode]/route.ts` |

## 6. Gotchas

- **Blob edits invisible to search** until re-ingested and re-uploaded
- **Ingest prefers filesystem** — stale git transcripts override Blob edits. Always sync before ingesting.
- **Raw transcripts are write-once** — `saveRawTranscript()` won't overwrite existing raw. This preserves the original diarization for reset.
- **MP3s not in git** — ~36 GB total. Must download from Drive (or the RSS fallback) or have in `mp3s/` locally.
- **Search indexes not in git** — ~170 MB combined. Must be in Blob for production.
