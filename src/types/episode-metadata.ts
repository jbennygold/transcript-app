import type { EpisodeId } from '@/lib/episode-format';

export interface EpisodeMetadata {
  pod: string;
  season: number;
  episode: EpisodeId;
  film: string;
  filmYear: number | null;
  releaseDate: string;
  length: string;
  reviewer: string;
  guest: string | null;
  mmmCount: number;
  thatsGreatCount: number;
  notableMoments: string;
  hFlex: string;
  jFlex: string;
  kevsQuestion: string;
  tildaH: string;
  tildaJason: string;
  tildaGuest: string | null;
  tildaCorey: string | null;
  showLink: string;
  artworkLink: string;
  letterboxdLink: string;
  imdbLink: string;
  // TMDB enrichment fields (optional - populated by enrichment script)
  tmdbId?: number;
  directors?: string[];
  cinematographers?: string[];
  cast?: string[];        // Top billed actors
  composers?: string[];
  genres?: string[];
  tmdbPosterPath?: string;
}

export interface QueryFilters {
  decade?: number;
  season?: number;
  guest?: string;
  film?: string;
  reviewer?: string;
  yearRange?: { min: number; max: number };
  // TMDB-enriched filters
  director?: string;
  cinematographer?: string;
  actor?: string;
  genre?: string;
}

export interface PaginationOptions {
  limit?: number;   // Max results to return (default: 50)
  offset?: number;  // Skip first N results (default: 0)
  sortBy?: 'episode' | 'releaseDate' | 'filmYear';  // Sort field (default: 'episode')
  sortOrder?: 'asc' | 'desc';  // Sort direction (default: 'desc' for most recent first)
}

export interface MetadataQueryResult {
  episodes: EpisodeMetadata[];
  totalCount: number;        // Total matching episodes (before pagination)
  returnedCount: number;     // Number returned in this response
  hasMore: boolean;          // Whether there are more results
  matchedFilters: string[];
}

export interface MetadataSource {
  film: string;
  season: number;
  episode: EpisodeId;
  releaseDate: string;
  guest: string | null;
  reviewer: string;
  relevantFields: Record<string, string>;
}

export interface TranscriptSource {
  episodeTitle: string;
  episodeNumber?: number;
  speakers: string;
  startTimestamp: string;
  endTimestamp: string;
  text: string;
  score: number;
}

export type QueryType = 'factual' | 'interpretive' | 'hybrid';

export type SearchStrategy = 'rag' | 'agent';

export interface ClassificationResult {
  type: QueryType;
  confidence: number;
  filters: QueryFilters;
  requiresTranscriptDepth?: boolean;
  supplementalQueries?: string[];
  searchStrategy?: SearchStrategy;
}

export interface HybridSearchResponse {
  answer: string;
  queryType: QueryType;
  sources: {
    transcripts?: TranscriptSource[];
    metadata?: MetadataSource[];
  };
}
