import { list } from '@vercel/blob';

export interface StoredChunk {
  id: string;
  text: string;
  embedding: number[];
  metadata: {
    episodeTitle: string;
    speakers: string;
    startTimestamp: string;
    endTimestamp: string;
  };
}

export interface TopicChunk {
  id: string;           // e.g., "episode_140_5_topic"
  text: string;         // topic summary
  embedding: number[];  // 512-dim
  parentChunkId: string;
  topicVersion: number;
  metadata: {
    episodeTitle: string;
    speakers: string;
    startTimestamp: string;
    endTimestamp: string;
  };
}

interface VectorStoreData {
  chunks: StoredChunk[];
}

// In-memory cache for the vector store (persists across requests in the same Lambda instance)
let cachedVectorStore: StoredChunk[] | null = null;
let loadPromise: Promise<StoredChunk[]> | null = null;

const SEARCH_DATA_PREFIX = 'search-data/';

/**
 * Load vector store from Vercel Blob storage.
 * Uses in-memory caching to avoid repeated fetches.
 */
export async function loadVectorStoreAsync(): Promise<StoredChunk[]> {
  // Return cached data if available
  if (cachedVectorStore !== null) {
    return cachedVectorStore;
  }

  // If already loading, wait for the existing promise
  if (loadPromise !== null) {
    return loadPromise;
  }

  // Start loading
  loadPromise = (async () => {
    try {
      console.log('Loading vector store from Blob storage...');
      const startTime = Date.now();

      // Find the vector store blob
      const blobs = await list({ prefix: `${SEARCH_DATA_PREFIX}vector-store.json` });
      const match = blobs.blobs.find((b) => b.pathname === `${SEARCH_DATA_PREFIX}vector-store.json`);

      if (!match) {
        console.warn('Vector store not found in Blob storage');
        cachedVectorStore = [];
        return cachedVectorStore;
      }

      // Fetch the data. Not size-verified the way the ingest path is: `fetch`
      // negotiates br/gzip, so content-length is the compressed size and can't be
      // compared against the blob's, and verifying would mean either an extra
      // HEAD or pulling ~250MB uncompressed. Runtime staleness is bounded by the
      // 5-minute cache-control that upload-search-data.ts now writes, and a
      // briefly-stale read here is harmless — unlike in ingest, nothing is
      // written back. See download-search-data.ts for that case.
      const response = await fetch(match.url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to fetch vector store: ${response.status}`);
      }

      const data: VectorStoreData = await response.json();
      cachedVectorStore = data.chunks || [];

      const elapsed = Date.now() - startTime;
      console.log(`Loaded ${cachedVectorStore.length} chunks from Blob in ${elapsed}ms`);

      return cachedVectorStore;
    } catch (error) {
      console.error('Error loading vector store:', error);
      cachedVectorStore = [];
      return cachedVectorStore;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

// --- Topic vector loading ---

let cachedTopicVectors: TopicChunk[] | null = null;
let topicLoadPromise: Promise<TopicChunk[]> | null = null;

export async function loadTopicVectorsAsync(): Promise<TopicChunk[]> {
  if (cachedTopicVectors !== null) return cachedTopicVectors;
  if (topicLoadPromise !== null) return topicLoadPromise;

  topicLoadPromise = (async () => {
    try {
      console.log('Loading topic vectors from Blob storage...');
      const startTime = Date.now();
      const blobs = await list({ prefix: `${SEARCH_DATA_PREFIX}topic-vectors.json` });
      const match = blobs.blobs.find(b => b.pathname === `${SEARCH_DATA_PREFIX}topic-vectors.json`);

      if (!match) {
        console.warn('Topic vectors not found in Blob storage (feature disabled or not yet uploaded)');
        cachedTopicVectors = [];
        return cachedTopicVectors;
      }

      const response = await fetch(match.url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Failed to fetch topic vectors: ${response.status}`);

      const data = await response.json();
      cachedTopicVectors = data.chunks || [];
      console.log(`Loaded ${cachedTopicVectors!.length} topic vectors in ${Date.now() - startTime}ms`);
      return cachedTopicVectors!;
    } catch (error) {
      console.error('Error loading topic vectors:', error);
      cachedTopicVectors = [];
      return cachedTopicVectors;
    } finally {
      topicLoadPromise = null;
    }
  })();

  return topicLoadPromise;
}

/**
 * Synchronous version that returns cached data or empty array.
 * Use loadVectorStoreAsync() for guaranteed data loading.
 * @deprecated Use loadVectorStoreAsync instead
 */
export function loadVectorStore(): StoredChunk[] {
  if (cachedVectorStore !== null) {
    return cachedVectorStore;
  }
  // Trigger async load for next request
  loadVectorStoreAsync().catch(console.error);
  return [];
}

export function isVectorStoreLoaded(): boolean {
  return cachedVectorStore !== null && cachedVectorStore.length > 0;
}

export function getVectorStoreSize(): number {
  return cachedVectorStore ? cachedVectorStore.length : 0;
}

// Lazily-built chunk map for O(1) neighbor lookups by ID
let cachedChunkMap: Map<string, StoredChunk> | null = null;
let cachedChunkMapSource: StoredChunk[] | null = null;

/**
 * Build (or return cached) a Map from chunk ID → StoredChunk for O(1) lookups.
 * Cache is invalidated if the underlying chunks array changes.
 */
export function getChunkMap(chunks: StoredChunk[]): Map<string, StoredChunk> {
  if (cachedChunkMap && cachedChunkMapSource === chunks) {
    return cachedChunkMap;
  }
  cachedChunkMap = new Map(chunks.map(c => [c.id, c]));
  cachedChunkMapSource = chunks;
  return cachedChunkMap;
}

export function saveVectorStore(): void {
  // No-op in production - data is managed via Blob storage
  console.warn('saveVectorStore is not available in production');
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function searchSimilar(
  queryEmbedding: number[],
  chunks: StoredChunk[],
  topK: number = 10
): { chunk: StoredChunk; score: number }[] {
  const scored = chunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Episode-scoped embedding search: filters chunks to target episodes
 * before running cosine similarity. Used for targeted sub-search
 * when the classifier identifies specific episodes.
 */
export function searchSimilarFiltered(
  queryEmbedding: number[],
  chunks: StoredChunk[],
  episodeTitles: string[],
  topK: number = 10
): { chunk: StoredChunk; score: number }[] {
  // Normalize by stripping year suffixes — metadata film has "(1988)" but
  // chunk episodeTitle may or may not, so strip from both sides.
  const normalize = (t: string) => t
    .replace(/\s*\(\d{4}\)/g, '')
    .replace(/^EMERGENCY EP\s*-\s*/i, '')
    .replace(/^BONUS:\s*/i, '')
    .replace(/^Best of Escape Hatch:\s*/i, '')
    .trim()
    .toLowerCase();
  const titleSet = new Set(episodeTitles.map(normalize));
  const filtered = chunks.filter(c =>
    titleSet.has(normalize(c.metadata.episodeTitle))
  );
  if (filtered.length === 0) return [];

  const scored = filtered.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function searchTopicVectors(
  queryEmbedding512: number[],
  topicChunks: TopicChunk[],
  topK: number = 10
): { topic: TopicChunk; score: number }[] {
  if (topicChunks.length === 0) return [];

  const scored = topicChunks.map(topic => ({
    topic,
    score: cosineSimilarity(queryEmbedding512, topic.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
