# Escape Hatch Search

AI-powered semantic search across 300+ podcast episode transcripts.

**[Live app →](https://search.escapehatchpod.com)** · **[About / press kit](https://search.escapehatchpod.com/aboutus)**

## What it does

Natural-language search over every episode of the Escape Hatch Podcast. Ask a question, get an AI-synthesized answer with source citations and timestamps — powered by hybrid retrieval (vector + BM25) and Claude.

### How search works

*For a plain-language, end-to-end walkthrough, see [How a query travels through the search system](docs/query-journey.md).*

1. **Query classification** — Claude Haiku categorises the query as factual, interpretive, or hybrid and extracts filters (guest, film, director, genre, decade, season).
2. **Intent detection** — Special intents (latest episode, total count, metadata lookups, director filmographies) are routed directly to deterministic aggregates.
3. **Routing gate** — Aggregation-style questions ("how many times did X say Y", "list every prop they mentioned", "which episode did X say Y") are routed to an **agent search** path: a Claude Sonnet agent with tools that iteratively greps raw transcripts — the kind of exhaustive scan retrieval can't do. Everything else takes the retrieval path below. Falls back to retrieval on failure.
4. **Hybrid retrieval** — OpenAI embeddings feed two vector searches — one over full chunk text (1536-dim) and a supplemental one over Haiku-generated topic summaries (512-dim) that surface personal/incidental content buried in film-heavy chunks — alongside a BM25 inverted index for lexical matching. Results are merged via Reciprocal Rank Fusion with adaptive retrieval depth per query type.
5. **Answer synthesis** — Retrieved chunks + metadata are streamed through Claude Sonnet, which produces a markdown answer with source citations.

## Tech stack

| Layer | Tech |
|---|---|
| Framework | Next.js (App Router), React 19, TypeScript |
| Styling | Tailwind CSS |
| AI | Claude (Anthropic) for classification, agent search & synthesis, OpenAI for embeddings |
| Search | BM25 lexical index, vector similarity (full-text + topic-summary vectors), Reciprocal Rank Fusion, agent-driven transcript grep |
| Transcription | AssemblyAI |
| Storage | Vercel Blob (vector store, topic vectors, BM25 index, transcripts in production), local JSON in dev |
| Metadata | TMDB (film/director/actor enrichment) |
| Hosting | Vercel (serverless) |

## Documentation

Deeper reference docs live in [`docs/`](docs/):

**Architecture & search**
- [How a query travels through the search system](docs/query-journey.md) — the "life of a query," end to end
- [Agent-grep hybrid search architecture](docs/rewrite.md) — design of the agent search path
- [LLM topic extraction](docs/topic-extraction-design.md) — the supplemental topic-summary vectors

**Operations & reference**
- [Transcript & audio lifecycle](docs/transcript-audio-lifecycle.md) — how transcripts and MP3s are created, stored, and accessed across Blob, filesystem, and Git
- [External search API](docs/external-search-api.md) — stable API seam for third-party consumers
- [Query use cases](docs/query-use-cases.md) — the query categories used for evals and analytics

## Getting started

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
git clone https://github.com/<your-org>/transcript-app.git
cd transcript-app
npm install
```

Create a `.env.local` file and fill in the required keys — see the table below.

Start the dev server:

```bash
npm run dev
```

The app will be available at `http://localhost:3000`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | OpenAI — used for generating embeddings |
| `ANTHROPIC_API_KEY` | Yes | Anthropic — used for query classification and answer synthesis |
| `BLOB_READ_WRITE_TOKEN` | Yes | Vercel Blob — stores the vector store, topic vectors, BM25 index, and transcripts in production |
| `NEXT_PUBLIC_BASE_URL` | No | Base URL of the running app (defaults to localhost in dev) |
| `WARMUP_TOKEN` | No | Protects the `/api/warmup` endpoint |
| `TOPIC_VECTORS_ENABLED` | No | Feature flag — enables the supplemental topic-summary vector search |
| `AGENT_SEARCH_ENABLED` | No | Feature flag — enables the agent (transcript-grep) search path |
| `AGENT_SEARCH_PERCENT_ROLLOUT` | No | Percentage rollout (0–100) for agent search |
| `AGENT_SEARCH_DISABLE_ON_ERROR_RATE` | No | Auto-disables agent search above this error rate |
| `DISCORD_PDC_WEBHOOK_URL` | No | Discord webhook for #pod-data-central episode notifications |
| `ASSEMBLYAI_API_KEY` | No | AssemblyAI — only needed to transcribe new episodes |
| `TMDB_API_KEY` | No | TMDB — only needed to enrich episode metadata with film/director info |
| `RESEND_API_KEY` | No | Resend — only needed for email notifications |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | No | Path to a service-account JSON; used by the metadata sync and Drive audio download |
| `PODCAST_RSS_URL` | No | Overrides the default Anchor.fm feed URL used as the audio-download fallback |

## Scripts reference

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build (orchestrator + Next.js) |
| `npm run build:local` | Local build (bundle data + Next.js) |
| `npm run start` | Start production server |
| `npm run lint` | Run linter |
| `npm run ingest` | Ingest transcript data into the vector store |
| `npm run upload-search-data` | Upload search index to Vercel Blob |
| `npm run bundle` | Bundle data files for deployment |
| `npm run regression:queries` | Run query regression tests |
| `npm run perf:queries` | Run performance benchmarks |
| `npm run ab:queries` | Run A/B query comparison tests |
| `npm run transcribe` | Transcribe a single audio file |
| `npm run batch-transcribe` | Batch-transcribe multiple audio files |
| `npm run enrich-tmdb` | Enrich episode metadata via TMDB |
| `npm run sync-metadata` | Sync episode metadata from the Google Sheet (PDC) |
| `npm run download-audio` | Download episode MP3s. Tries Google Drive first; falls back to the public RSS feed for any episode Drive can't serve |

## Project structure

```
src/
  app/            # Next.js App Router — pages and API routes
    api/          #   search, share, feedback, transcribe, coverage, etc.
    aboutus/      #   Press kit / about page
    analytics/    #   Internal analytics views
    coverage/     #   Coverage analytics page
    docs/         #   In-app documentation
    eval/         #   Search evaluation pages
    podreview/    #   Podcast review page
    review/       #   Transcript review/editing pages
    share/        #   Shared search result pages
  components/     # React components (AudioPlayer, TranscriptEditor, etc.)
  hooks/          # Custom React hooks
  lib/            # Core modules
    hybrid-retrieval.ts   # Embedding + topic-vector + BM25 fusion
    bm25.ts               # BM25 lexical search
    vectorstore.ts        # Vector similarity search
    query-classifier.ts   # LLM-based query classification
    query-intent.ts       # Intent detection & routing
    routing-policy.ts     # Agent-vs-RAG routing gate (shared by both endpoints)
    agent-search.ts       # Agent search — Sonnet + transcript-grep tools
    claude.ts             # Claude integration for synthesis
    embeddings.ts         # OpenAI embedding generation
    metadata-store.ts     # Episode metadata access
    blob-storage.ts       # Vercel Blob read/write for transcripts and audio
    podcast-feed.ts       # RSS feed fetcher used as a fallback audio source
  types/          # TypeScript type definitions
scripts/          # CLI tooling — ingest, transcribe, regression, perf, etc.
transcripts/      # Raw transcript files
data/             # Episode metadata and search data
```

## Audio sources

Per-episode MP3s are needed only for transcription, not at runtime. The
download script resolves them in this order:

1. **Google Drive** — the historical primary, used for older episodes and
   pre-release uploads from the production team.
2. **Public RSS feed** (Anchor.fm) — fallback when an episode isn't in Drive.
   Matched by film title; the feed's `<title>` mirrors the metadata `film`
   field verbatim. Override the feed URL with `PODCAST_RSS_URL` if needed.

Each downloaded file is tagged with its source (`drive` or `rss`) in the
script's report, so you can see at a glance how each episode was served.

## Discord bot

A companion Discord bot (`/pdc` slash command) queries this app's search API. It lives in a separate repository.

## Warmup endpoint

To reduce cold-start latency, warm the vector store and BM25 index:

```
GET /api/warmup?token=YOUR_TOKEN
```

Set `WARMUP_TOKEN` in the environment to protect the endpoint. A GitHub Actions workflow can call this on a schedule — configure `WARMUP_URL` and `WARMUP_TOKEN` as repo secrets.

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b my-feature`)
3. Commit your changes
4. Open a pull request

## License

[Apache License 2.0](LICENSE)
