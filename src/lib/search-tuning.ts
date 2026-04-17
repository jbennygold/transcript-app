export type SearchVariant = 'default' | 'fast' | 'context';

export type RetrievalKOverrides = {
  embeddingK?: number;
  bm25K?: number;
  finalK?: number;
};

export type SearchTuning = {
  interpretiveModel?: string;
  interpretiveMaxTokens?: number;
  interpretiveK?: RetrievalKOverrides;
};

export function getSearchTuning(variant?: string): SearchTuning | null {
  if (!variant) {
    return null;
  }

  switch (variant) {
    case 'fast':
      return {
        interpretiveModel: process.env.INTERPRETIVE_FAST_MODEL || 'claude-haiku-4-5',
        interpretiveMaxTokens: 700,
      };
    case 'context':
      return {
        interpretiveK: {
          embeddingK: 8,
          bm25K: 6,
          finalK: 8,
        },
      };
    case 'default':
      return null;
    default:
      return null;
  }
}
