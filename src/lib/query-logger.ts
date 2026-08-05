import { put } from '@vercel/blob';
import { MUTABLE_BLOB_CACHE_MAX_AGE } from './blob-storage';

const QUERY_LOG_PREFIX = 'query-log/';

export interface QueryLogEntry {
  id: string;
  timestamp: string;
  query: string;
  classification: {
    type: string;
    confidence?: number;
    filters?: Record<string, unknown>;
  };
  sourceCount: number;
  transcriptSourceCount: number;
  metadataSourceCount: number;
  sourceEpisodes: string[];
  answerLength: number;
  latencyMs: number;
  path: string;
  intent?: { type: string; confidence?: string };
  synthesisModel?: string;
  depth?: 'quick' | 'deep';
  routingPath?: 'metadata_fast_path' | 'full_pipeline' | 'fallthrough' | 'agent_search';
  // Populated later if user submits feedback
  rating?: 'good' | 'bad' | null;
  comment?: string;
  // Agent search telemetry (only populated when routingPath='agent_search')
  searchStrategy?: 'rag' | 'agent';
  agentIterationCount?: number;
  agentToolCallCount?: number;
  agentFallbackReason?: null | 'timeout' | 'error_threshold' | 'weak_evidence' | 'model_error';
  agentLatencyBreakdownMs?: {
    route: number;
    tooling: number;
    synthesis: number;
    total: number;
  };
  // Topic vector telemetry
  topicBlobLoaded?: boolean;
  topicHitCount?: number;
  topicOnlyHitCount?: number;
  // Use case classification
  useCase?: string;      // Deterministic tag, set at log time
  useCaseLLM?: string;   // LLM tag, set by batch classifier script
  // External consumer attribution
  source?: 'internal' | 'external';
  externalKeyId?: string;
}

export function generateLogId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `ql_${ts}_${rand}`;
}

/**
 * Log a search query and its results to Vercel Blob.
 * Fire-and-forget — errors are logged but don't affect the response.
 */
export async function logQuery(data: Omit<QueryLogEntry, 'id' | 'timestamp'>, preGeneratedId?: string): Promise<string | null> {
  const id = preGeneratedId ?? generateLogId();
  const entry: QueryLogEntry = {
    id,
    timestamp: new Date().toISOString(),
    ...data,
  };

  // Organize by year-month for easy browsing
  const month = entry.timestamp.slice(0, 7); // "2026-02"
  const pathname = `${QUERY_LOG_PREFIX}${month}/${id}.json`;

  try {
    // Short TTL even though this write creates the entry: the id is stable and
    // the entry is later overwritten in place — by the feedback route adding a
    // rating, and by classify-query-logs adding a use-case. At Blob's one-month
    // default those updates would stay invisible to /analytics for weeks.
    await put(pathname, JSON.stringify(entry), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
    });
    return id;
  } catch (err) {
    console.error('Failed to log query:', err);
    return null;
  }
}
