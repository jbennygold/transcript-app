# How a Query Travels Through the Search System

This document explains, in plain language, what happens after someone types a question into the search box. It focuses on **how the question is interpreted**, **which data sources are consulted**, and **how the final answer is assembled**.

## The short version

1. **We check for "simple" questions first.** If it's something like "latest episode," "how many episodes," "who was the guest/reviewer for episode X," "what episodes feature guest X," or "what was Kev's question," we answer directly from the episode metadata.
2. **We classify the question and start embedding it** — both happen in parallel for speed.
3. **In the full pipeline, we search both metadata and transcripts.** Metadata uses extracted filters; transcript retrieval combines embedding + BM25.
4. **We assemble a response.** The system returns an answer plus source excerpts (including transcript timestamps) so you can verify it.

---

## A simple diagram

```mermaid
flowchart TD
  A["User question"] --> B["Intent check: is this a quick metadata question?"]
  B -- "Yes" --> C["Answer from episode metadata"]
  B -- "No" --> D["Classify question + generate embedding (in parallel)"]
  D --> R["Routing decision: RAG or Agent?"]
  R -- "Agent (aggregation/counting)" --> AG["Agent loop: grep raw transcripts iteratively"]
  AG --> AGR["Agent synthesizes answer with citations"]
  R -- "RAG (default)" --> E["Pick data sources"]
  E --> F["Metadata search (episode list, guests, reviewers, release dates, Kev’s question)"]
  E --> G["Transcript search (episode dialogue)"]
  F --> H["Answer synthesis"]
  G --> H["Answer synthesis"]
  H --> I["Final response with citations + timestamps"]
  AGR --> I
```

## Technical components (high level)

```mermaid
flowchart LR
  A["Search UI"] --> B["/api/search/stream"]
  B --> C["Intent detection"]
  B --> D["Query classification"]
  D --> R["Routing gate"]
  R -- "agent" --> AG["Agent search (Sonnet + grep tools)"]
  AG --> K["Response with citations"]
  R -- "rag" --> E["Metadata filters"]
  R -- "rag" --> F["Hybrid retrieval"]
  E --> G["Episode metadata store"]
  F --> H["Vector store (embeddings, 1536-dim)"]
  F --> HT["Topic vectors (512-dim)"]
  F --> I["BM25 index (keywords)"]
  H --> L["Post-retrieval (dedup, rerank)"]
  HT --> L
  I --> L
  G --> J["Answer synthesis"]
  L --> J
  J --> K
```

### Component definitions

- **Search UI** — The page where someone types a question and clicks search.
- **/api/search/stream** — The primary server endpoint used by the UI (SSE streaming) that orchestrates the whole search flow. (`/api/search` is the non-streaming sibling.) Both endpoints share routing policy and synthesis decisions via a common module (`src/lib/routing-policy.ts`).
- **Intent detection** — A quick check for “easy” metadata questions (latest episode, total count, episode lookup, guest/reviewer lookup, release date, Kev’s question, etc.).
- **Query classification** — Labels the question as factual, interpretive, or hybrid, and extracts filters.
- **Routing gate** — Two-step decision in `routing-policy.ts` that determines whether a query goes to the agent search path or the RAG pipeline. Requires both a feature flag (`AGENT_SEARCH_ENABLED=true`) and a match against `AGENT_ROUTING_PATTERNS` (~16 regex patterns across Phases A, B, and C). Routes counting/frequency queries, speaker comparisons (“who says X more”), windowed comparisons (“first/last N episodes”), exhaustive listings (“list all...talked about”), temporal ordering (“earliest mention of”), frequency rankings (“most frequent/repeated”), episode counting (“how many episodes discuss”), multi-episode extraction (“N episodes prior/before/after”), cross-episode mention context (“in what context has X been mentioned”), quote finders (“which episode did X say Y”), host-scoped topic search (“what has X said about Y”), existence checks (“has X talked about Y”), persona aggregation (“what are some things X said”), and transcript-excerpt requests (“show me the bit where…”) to the agent. Cross-episode patterns (B11/B12) are **film-gated** — if a specific film is detected, the query is treated as episode-scoped and stays on RAG. Everything else goes to RAG. See `docs/rewrite.md` for full design.
- **Agent search** — An LLM agent (Sonnet) with tool-use that iteratively greps raw transcript files to answer queries RAG can’t handle (counting, frequency, cross-episode aggregation). Has 4 tools: `grep_transcripts`, `read_episode_transcript`, `search_episodes`, `list_episodes`. Max 10 iterations, 45s timeout. Falls back to RAG on failure. Implemented in `src/lib/agent-search.ts`.
- **Metadata filters** — Structured filters (guest, film, season, etc.) used to narrow the episode list.
- **Episode metadata store** — The structured episode database (titles, guests, reviewers, release dates, Kev’s question, summaries). Also backs a **director-film listing fast-path** (`metadata_director_films` intent) that answers “what X movies have been episodes” deterministically — director name → matching episodes, zero LLM calls — and a **notable-moments keyword fallback** (`searchNotableMoments`) that scans notable-moments fields when the classifier extracts no filters.
- **Hybrid retrieval** — The transcript search step that combines semantic and keyword search.
- **Vector store (embeddings, 1536-dim)** — Meaning‑based search over transcript chunks using full chunk text embeddings.
- **Topic vectors (512-dim)** — Supplemental embedding search over LLM-generated topic summaries. Each standard chunk has a corresponding topic summary (2-4 sentences extracted by Haiku at ingest time) that captures personal anecdotes, tangential topics, and incidental mentions buried in film-focused chunks. Stored in a separate blob, loaded in parallel, fail-open. When a topic vector matches, the parent chunk is returned. Gated by `TOPIC_VECTORS_ENABLED` env var. See `docs/topic-extraction-design.md` for full design.
- **BM25 index (keywords)** — Exact‑word search over transcript chunks, with synonym expansion for known clusters (food, music, preferences, catchphrase) and Whisper transcription error bridges (e.g., “Eszterhas” → “Esther”/”Ester”).
- **Answer synthesis** — The response writer that blends metadata + transcripts into a readable answer.
- **Response with citations** — The final output with sources and timestamps for verification.

---

## Step‑by‑step explanation

### 1) Intent check (quick answers)
Some questions are **really just metadata lookups**, like:
- "What's the latest episode?"
- "How many episodes are there?"
- "What's the latest episode with guest X?"
- "What episodes feature guest X?" (returns a formatted episode list)
- "What episode is 283?" / "Give me details about episode 283"
- "Who was the guest or reviewer on *No Country for Old Men*?"
- "When did episode 6 release?"
- "What was Kev's question on episode 1?"
- "What Villeneuve movies have been episodes?" (deterministic director→episode listing, zero LLM calls)

For these, the system **skips the heavier search** and answers directly from episode metadata (titles, guests, reviewers, release dates, Kev's question, director filmographies, etc.). This is fast and avoids over‑complication.

If an intent fires but the metadata lookup returns nothing (e.g., the film isn't in the database), the system **falls through** to the full search pipeline rather than returning an empty result.

**Confidence guardrail:** When intent detection has only **medium confidence**, the system skips the metadata fast-path entirely and falls through to the full pipeline. This prevents low-quality deterministic answers for ambiguous queries.

---

### 2) Classification + embedding (in parallel)
If it's not a quick metadata lookup, two things happen **at the same time** to save latency:
- The query is **classified** into one of three buckets (below).
- An **embedding** (a numeric meaning‑fingerprint) is generated for the query, ready for transcript search.

The classification step produces one of three labels:

- **Factual** — “Which episode covered *The Thing*?” / “Who was the guest on *No Country for Old Men*?” / “When did episode 6 release?”
- **Interpretive** — “What did they think about *The Thing*?”
- **Hybrid** — “Which episode covered *The Thing*, and what did they say?”

At the same time, the system extracts **filters** like:
guest, film, director, actor, genre, decade, season.

These filters help narrow down the search to the most relevant episodes.

**Deterministic film detection:** After LLM classification, the system always runs a deterministic film matcher (`findFilmFromQuery`) that checks the query against the full episode catalog. If a catalog film title appears as a substring in the query, the canonical match (with year suffix, e.g., "They Live (1988)") overrides whatever the LLM extracted. This eliminates flakiness for short or ambiguous film titles that the LLM may not consistently recognize.

**Director-debut resolution:** If no film title is found in the query, the system checks for "directorial debut" or "first film" patterns. When detected, it searches the director catalog for a matching last name in the query and returns their earliest film by release year. For example, "Wachowskis' directorial debut" resolves to "Bound (1996)". This ensures `targetEpisodeTitles` gets populated for implicit film references, triggering episode injection and boosting downstream.

**Supplemental query generation:** For persona, aggregation, or cross-episode pattern queries, the classifier also generates 1–3 supplemental search queries that rephrase the question to target underlying content rather than concept words. For example, "If Jason had a catchphrase" generates supplemental queries like "Jason Goldman you hack" and "Jason recurring phrase". These are run through the same BM25 + embedding pipeline with a discount factor and merged into the main results. Certain known patterns (e.g., catchphrase + host name) also trigger deterministic supplemental queries for reliability.

**Low-confidence guardrail:** If the classifier has low confidence (< 0.6) and extracted no filters, the system forces the query type to **hybrid** regardless of what the LLM returned. This prevents misrouting ambiguous queries into the wrong search mode.

---

### 2b) Agent search routing (aggregation queries)

After classification, the system checks whether the query should be handled by the **agent search path** instead of the standard RAG pipeline. This is a two-step gate:

1. **Feature flag check**: `AGENT_SEARCH_ENABLED` must be `true` (set via environment variable).
2. **Pattern match**: The query must match at least one of ~16 deterministic regex patterns in `AGENT_ROUTING_PATTERNS`, grouped into three phases:

   **Phase A** — counting/frequency:
   - "how many times/how often/every time ... say/said/mention/used/interrupted/called/repeated..." (16 verb anchors)

   **Phase B** — broader aggregation (from feedback analysis):
   - **B1 Speaker comparison**: "who says X more"
   - **B2 Windowed comparison**: "first/last N episodes" + comparison word (more/less/most/often)
   - **B3 Exhaustive listing**: "list/name/what are all/every" + utterance or passive verb (talked/discussed/mentioned/said/brought up/called/described/referred to/labeled)
   - **B3b Listing (noun form)**: "what are all the mentions/references/discussions/instances of X"
   - **B3c Listing (times form)**: "all the times X has commented/complained/talked/joked/ranted..."
   - **B4 Temporal ordering**: "earliest/first mention/time/instance of"
   - **B5 Frequency ranking**: "most frequent/common/repeated" + noun (phrases/words/callers/voicemailers)
   - **B6 Episode counting**: "how many episodes" + topic verb (mention/discuss/cover/feature)
   - **B7 Multi-episode extraction**: "N episodes prior/before/after"
   - **B8 Cross-episode mention context**: "in what context has X been mentioned", "was X ever mentioned", "are there any mentions of X"
   - **B10 Quote finder**: "which episode/segment did X say/mention/hum/sing/quote Y"
   - **B11 Host-scoped topic search**: "what does/did/has [host] say/think/talk about [topic]" — *film-gated*
   - **B12 Existence check**: "has X talked/spoken/commented about Y" — *film-gated*
   - **B13 Persona aggregation**: "what are some [adj] things X has said/done"

   **Phase C** — transcript excerpt:
   - **C1**: "give/show/find/pull up the [X] bit/part/section/moment/riff/rant where/when/about..."

3. **Film-detection gate (Gate 3)**: The cross-episode patterns **B11 and B12 are film-gated** — if a specific film was detected in the query and the *only* matching patterns are film-gated, the query is treated as episode-scoped and stays on RAG (e.g., "what did Haitch say about *They Live*" uses RAG, but "what has Haitch said about Verhoeven" goes to the agent).

If all conditions pass, the query goes to an **LLM agent** (Sonnet) that has tools to grep raw transcript files. The agent iteratively searches, reads results, reformulates queries, and counts occurrences across episodes. This handles queries like "How many times does Jason say big time?" or "List all the props they talked about buying" that RAG fundamentally cannot answer (RAG retrieves the best-matching chunks, but can't exhaustively scan the corpus).

The agent has 4 tools:
- **grep_transcripts** — regex search across every episode transcript (300+ episodes, loaded from Blob at runtime)
- **read_episode_transcript** — load and read a specific episode's full transcript
- **search_episodes** — search episode metadata (films, guests, etc.)
- **list_episodes** — list all episodes with numbers and titles

The agent loop runs up to 10 iterations with a 45-second timeout. If the agent fails (timeout, errors, or insufficient evidence), the system falls back to the standard RAG pipeline. The user always gets an answer.

For agent queries, the UI shows "Deep searching..." with progress events describing what the agent is doing ("Searching for recurring phrases...", "Found 12 matches across 8 episodes...").

If the query does **not** match agent patterns, it proceeds to the standard RAG pipeline (steps 3-4 below) as before.

---

### 3) Data sources consulted

There are two main sources of truth:

#### A) Episode metadata
This is the structured data about each episode:
- Title, guest, reviewer, release date, season, episode number
- Kev’s question (when available)
- Notable moments, reviewer notes, and other summaries (when available)

If the question is factual or hybrid, metadata is searched using extracted filters. Certain factual questions are answered **directly** from metadata as a fast path (guest/reviewer lookup, release date, Kev’s question).

#### B) Transcript search
In the full pipeline, transcript search always runs (alongside metadata search), because even factual queries may need evidence from what was said.

This is done in three ways:
- **Semantic search** (meaning-based, using 1536-dim embeddings of full chunk text)
- **Topic vector search** (meaning-based, using 512-dim embeddings of LLM-generated topic summaries — surfaces chunks where personal/lifestyle content is buried in film-focused text)
- **Keyword search** (exact words, using a BM25 index)

These are combined into a "hybrid" search so we don't miss relevant passages. Topic vector results are resolved to their parent chunks, normalized, and merged with full-text embedding results before RRF fusion with BM25.

The transcript corpus includes four types of chunks:
- **Standard chunks** (~50 per episode): sequential transcript segments covering the full episode dialogue.
- **Personal-aside chunks** (ID offset `_1000+`): small supplemental chunks (~200-400 tokens) extracted from food-preference and lifestyle discussions that would otherwise be buried in film-focused chunks.
- **Catchphrase chunks** (ID offset `_2000+`): 3-turn sub-chunks around known recurring phrases (e.g., Jason's "you hack"), with semantic prefixes for embedding/BM25 matching.
- **Segment chunks** (ID offset `_3000+`): dedicated sub-chunks for 6 recurring voicemailer segments (Truthsayer/Birria, Kev, Corey, Animal Mother, Mr Java, Lizzen), with semantic prefixes and speaker-boundary detection.

**Metadata-informed boosting:** When the metadata search identifies specific episodes (e.g., the classifier extracted a film filter like "Starman"), the transcript search boosts chunks from those episodes. This ensures that if you ask about a specific episode's content, the relevant chunks rank higher even if other episodes have similar keywords. The boosting is gentle (1.5x score multiplier) so cross-episode mentions still surface, and targeted episodes also get a higher per-episode cap in the diversification step so more of their chunks make it into the final results.

**Film filter fallback:** If the classifier detected a film filter but the metadata query returned 0 results (e.g., because additional filters like host or topic narrowed too aggressively), the detected film is still passed to transcript search as a target. This ensures retrieval injection, boosting, and diversification always fire for the detected episode.

**Supplemental query merge:** When the classifier generated supplemental queries, each is run through BM25 + embedding search independently, fused via RRF, and then merged into the main results with a 0.7× discount factor. Chunks that appear in both main and supplemental results get a score boost; supplemental-only chunks are added at their discounted score. This helps surface distributed evidence for persona/aggregation queries where the concept word doesn't appear in the relevant chunks.

**Post-retrieval processing (Phase 2a+2b):** After fusion and boosting, several additional steps clean up and reorder the candidate set before the final answer:
- **Boilerplate suppression** — recurring outro/credits language (e.g., "that's it for this episode", "leave us a rating", Patreon links) is downweighted so it doesn't crowd out substantive content.
- **Near-duplicate removal** — chunks with high token overlap (Jaccard ≥ 0.6) are deduplicated so the same content doesn't consume multiple result slots. This handles "Best of" re-broadcast episodes whose rebroadcast chunks closely match the originals.
- **Adjacent chunk expansion** — when a result mentions a query keyword, its neighboring chunks from the same episode are appended. This helps when an anecdote spans two chunks and the entity mention is in one but the story continues in the next.
- **LLM reranking** — a lightweight model (Haiku) reorders the top candidate chunks by semantic relevance to the query, and omits chunks clearly irrelevant to the query. This catches cases where lexical/embedding scores rank a chunk highly but it's not actually the best match for the user's intent. Excerpts shown to the reranker use keyword-centered windowing (the 600-char window is centered where query terms cluster, not blindly from the start of the chunk). Skipped when ≤5 results; falls back to original order on timeout (5s).

---

### 4) Answer synthesis
Once relevant metadata and transcript passages are gathered, the system **writes a response** in natural language.

The synthesis mode depends on the query type and whether the answer lives in metadata or transcripts:
- **Factual, metadata-answerable** queries (e.g., "Tim Burton movies", "Proto episodes") use a fast path: a smaller model (Haiku), a limited set of transcript chunks, and a shorter response cap. A "Show deeper analysis" button lets the user opt into full synthesis if the quick answer isn't enough.
- **Factual, transcript-depth** queries (e.g., "Did Haitch have a band?", "River Phoenix mentions") auto-switch to full-depth synthesis on first load (all retrieved transcript chunks, default Sonnet model).
- **Interpretive queries** use all retrieved transcript chunks on first load; in quick mode the system applies a fast-model tuning by default, while deep mode uses Sonnet.
- **Hybrid queries** use full-depth synthesis (all retrieved transcript chunks) on first load.

The system determines whether a factual query needs transcript depth using a classifier signal (`requiresTranscriptDepth`). Queries about opinions, quotes, biographical details, specific phrases, or frequency/ranking across episodes require transcript depth. Queries answerable from structured episode data (titles, guests, directors, dates) do not.

The "Show deeper analysis" button appears only when quick synthesis was used (factual + metadata-answerable) and additional transcript chunks were available beyond the initial quick cap.

The response includes:
- **Citations** to the transcript snippets
- **Timestamps** so you can jump to the right part of the episode

If the search found no strong matches, it will say so rather than guessing.

---

## Why this design works for humans

- **Fast for simple questions** (no need to run a big search)
- **Flexible for open‑ended questions**
- **Grounded in real quotes** (citations + timestamps)
- **Avoids over‑confidence** by refusing to hallucinate when filters don’t match

---

## Quick example

> **Question:** “What did the hosts think about *Alien*?”

1. Intent check → not a simple metadata question
2. Classification + embedding → run in parallel; classified as interpretive
3. Data sources → transcripts (hybrid search using precomputed embedding)
4. Answer → summary + cited quotes + timestamps
