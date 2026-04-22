import { loadEpisodeMetadata } from './metadata-store';
import { extractEpisodeNumberFromQuery } from './tilda-query';
import { episodeSortKey } from './episode-format';

export type QueryIntentType =
  | 'metadata_latest'
  | 'metadata_current_season'
  | 'metadata_total_episodes'
  | 'metadata_year_range_count'
  | 'metadata_year_range_sample'
  | 'metadata_field_latest'
  | 'metadata_field_max'
  | 'metadata_episode_fields'
  | 'metadata_episode_lookup'
  | 'metadata_guest_search'
  | 'metadata_director_films'
  | 'metadata_aggregate_rank'
  | 'metadata_tilda'
  | 'metadata_notable_moments'
  | 'transcript_only'
  | 'none';

export type MetadataFieldKey = 'mmmCount' | 'thatsGreatCount';
export type MetadataEpisodeField = 'guest' | 'reviewer' | 'releaseDate' | 'kevsQuestion';
export type AggregateRankField = 'cast' | 'directors' | 'cinematographers' | 'genres';

export interface QueryIntent {
  type: QueryIntentType;
  confidence: 'high' | 'medium' | 'low';
  field?: MetadataFieldKey;
  yearRange?: { min: number; max: number };
  episodeFields?: MetadataEpisodeField[];
  episodeNumber?: number;
  film?: string;
  guestName?: string;
  director?: string;
  aggregateField?: AggregateRankField;
  aggregateLimit?: number;
}

const YEAR_RANGE_PATTERN = /\b(19|20)\d{2}\s*-\s*(19|20)\d{2}\b/;
const YEAR_RANGE_WORD_PATTERN = /\bfrom\s+((19|20)\d{2})\s+to\s+((19|20)\d{2})\b/;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripParenthetical(text: string): string {
  return text.replace(/\([^)]*\)/g, ' ');
}

function extractYearRange(query: string): { min: number; max: number } | null {
  const normalized = normalize(query);
  const dashMatch = normalized.match(YEAR_RANGE_PATTERN);
  if (dashMatch) {
    const [start, end] = dashMatch[0].split('-').map((v) => parseInt(v.trim(), 10));
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      return { min: Math.min(start, end), max: Math.max(start, end) };
    }
  }

  const wordMatch = normalized.match(YEAR_RANGE_WORD_PATTERN);
  if (wordMatch) {
    const start = parseInt(wordMatch[1], 10);
    const end = parseInt(wordMatch[3], 10);
    if (!Number.isNaN(start) && !Number.isNaN(end)) {
      return { min: Math.min(start, end), max: Math.max(start, end) };
    }
  }

  return null;
}

export function findFilmFromQuery(query: string): string | null {
  const normalizedQuery = normalizeForMatch(query);
  if (!normalizedQuery) return null;

  const episodes = loadEpisodeMetadata();
  let bestMatch: { film: string; normalized: string; score: number } | null = null;

  for (const episode of episodes) {
    const normalizedFilm = normalizeForMatch(episode.film);
    const normalizedNoParen = normalizeForMatch(stripParenthetical(episode.film));
    const candidates = [normalizedFilm, normalizedNoParen].filter(Boolean);
    if (candidates.length === 0) continue;

    let matched: string | null = null;
    for (const candidate of candidates) {
      if (normalizedQuery.includes(candidate)) {
        matched = candidate;
        break;
      }
    }
    if (!matched) continue;

    const score = matched.length;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { film: episode.film, normalized: matched, score };
    }
  }

  if (!bestMatch) return null;

  const wordCount = bestMatch.normalized.split(' ').length;
  if (bestMatch.normalized.length <= 3 && wordCount < 2) {
    // Short single-word titles (e.g., "Her", "Elf") are ambiguous as substrings.
    // Only accept if the query uses the pattern "the <title> episode/movie/film"
    // which signals the user means a title, not a common word.
    const titlePattern = new RegExp(
      `\\bthe\\s+${bestMatch.normalized}\\s+(episode|movie|film)\\b`, 'i'
    );
    if (!titlePattern.test(normalizedQuery)) {
      return null;
    }
  }

  return bestMatch.film;
}

/**
 * Detect "directorial debut" / "first film" patterns and resolve director → earliest episode.
 * Only fires when findFilmFromQuery() returns null (no explicit film title in query).
 *
 * Strategy: check if query mentions a debut concept, then search the director catalog
 * for a matching last name in the query text. More robust than regex name extraction.
 */
const DEBUT_CONCEPT = /directorial\s+debut|first\s+(?:film|feature|movie)\b/i;

export function findDebutFilmFromQuery(query: string): string | null {
  const normalized = normalize(query);
  if (!DEBUT_CONCEPT.test(normalized)) return null;

  const episodes = loadEpisodeMetadata();

  // Collect unique directors from catalog
  const directorToEpisodes = new Map<string, typeof episodes>();
  for (const ep of episodes) {
    if (!ep.directors) continue;
    for (const d of ep.directors) {
      if (!directorToEpisodes.has(d)) directorToEpisodes.set(d, []);
      directorToEpisodes.get(d)!.push(ep);
    }
  }

  // Find the best matching director: check if their last name appears in the query
  let bestDirector: string | null = null;
  let bestLen = 0;
  for (const director of directorToEpisodes.keys()) {
    const lastName = director.split(' ').pop()!.toLowerCase();
    if (lastName.length < 3) continue;
    // Check if query contains the last name (handles plurals/possessives via substring)
    if (normalized.includes(lastName) && lastName.length > bestLen) {
      bestDirector = director;
      bestLen = lastName.length;
    }
  }

  if (!bestDirector) return null;

  // Find this director's earliest film by release year (best proxy for debut)
  const dirEpisodes = directorToEpisodes.get(bestDirector)!;
  const sorted = [...dirEpisodes].sort((a, b) => {
    // Prefer filmYear; fallback to episode order
    if (a.filmYear && b.filmYear) return a.filmYear - b.filmYear;
    if (a.filmYear) return -1;
    if (b.filmYear) return 1;
    return (a.season * 1000 + episodeSortKey(a.episode)) - (b.season * 1000 + episodeSortKey(b.episode));
  });

  return sorted[0].film;
}

export function findDirectorFromQuery(query: string): string | null {
  const normalizedQuery = normalizeForMatch(query);
  if (!normalizedQuery) return null;

  const episodes = loadEpisodeMetadata();

  // Collect unique directors
  const directors = new Set<string>();
  for (const ep of episodes) {
    if (ep.directors) {
      for (const d of ep.directors) directors.add(d);
    }
  }

  let bestMatch: { director: string; score: number } | null = null;

  for (const director of directors) {
    const normalizedDirector = normalizeForMatch(director);
    if (!normalizedDirector) continue;

    // Check full name first, then last name
    const lastName = director.split(' ').pop()!;
    const normalizedLast = normalizeForMatch(lastName);

    if (normalizedQuery.includes(normalizedDirector)) {
      const score = normalizedDirector.length;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { director, score };
      }
    } else if (normalizedLast && normalizedLast.length >= 4 && new RegExp(`\\b${normalizedLast}\\b`).test(normalizedQuery)) {
      // Last name match — require ≥4 chars to avoid "Lee", "Bay", etc.
      // Word boundary check prevents "shin" matching inside "fishing".
      const score = normalizedLast.length;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { director, score };
      }
    }
  }

  return bestMatch?.director ?? null;
}

function detectField(query: string): MetadataFieldKey | null {
  const normalized = normalize(query);
  if (normalized.includes("that's great") || normalized.includes('thats great')) {
    return 'thatsGreatCount';
  }
  if (normalized.includes('mmm')) {
    return 'mmmCount';
  }
  return null;
}

function wantsYearSample(normalized: string): boolean {
  return (
    /one\s+(movie|film)\s+from\s+each\s+year/.test(normalized) ||
    /one\s+(movie|film)\s+per\s+year/.test(normalized) ||
    /each\s+year.*(movie|film)/.test(normalized) ||
    /list\s+one\s+(movie|film)\s+.*each\s+year/.test(normalized)
  );
}

function extractGuestName(normalized: string): string | null {
  // "feature/featuring/with/have/had mike isaac as (a) guest"
  const asGuestMatch = normalized.match(
    /(?:feature|featuring|with|have|had|has|include|including)\s+(.{2,}?)\s+as\s+(?:a\s+)?guest/
  );
  if (asGuestMatch) return asGuestMatch[1].trim();

  // "was/is mike isaac (ever) a guest"
  const wasGuestMatch = normalized.match(
    /(?:was|were|is)\s+(.{2,}?)\s+(?:ever\s+)?(?:a\s+)?guest/
  );
  if (wasGuestMatch) return wasGuestMatch[1].trim();

  // "has/did mike isaac (been a) guest"
  const hasGuestMatch = normalized.match(
    /(?:has|have|had|did)\s+(.{2,}?)\s+(?:been\s+)?(?:a\s+)?guest/
  );
  if (hasGuestMatch) return hasGuestMatch[1].trim();

  // "guest episodes/appearances by/with mike isaac"
  const guestByMatch = normalized.match(
    /guest\s+(?:episodes?|appearances?)\s+(?:by|with|featuring|of)\s+(.{2,})/
  );
  if (guestByMatch) return guestByMatch[1].trim();

  // "episodes with mike isaac" (no "as guest" but "guest" is elsewhere in query)
  const withMatch = normalized.match(
    /episodes?\s+(?:with|featuring)\s+(.{2,}?)(?:\s+as\s+(?:a\s+)?guest)?$/
  );
  if (withMatch) return withMatch[1].trim();

  return null;
}

function detectEpisodeLookupIntent(query: string): QueryIntent | null {
  const episodeNumber = extractEpisodeNumberFromQuery(query);
  if (episodeNumber === null) return null;

  const normalized = normalize(query);

  // Skip if query asks for specific fields (handled by detectEpisodeFieldsIntent)
  if (/\b(guest|reviewer|reviewed|release date|kev'?s?\s+question)\b/.test(normalized)) return null;

  // Skip if query mentions tilda or notable moments (handled by later intents)
  if (/\btilda\b/.test(normalized)) return null;
  if (/\bnotable moments?\b/.test(normalized)) return null;

  // Match general episode queries
  const isEpisodeQuery =
    /\b(?:what\s+(?:is|was|are)\s+)?(?:episode|ep)\s*#?\s*\d/.test(normalized) ||
    /\btell\s+me\s+about\s+(?:episode|ep)\s*#?\s*\d/.test(normalized) ||
    /\bdetails?\s+(?:about|for|on)\s+(?:episode|ep)\s*#?\s*\d/.test(normalized) ||
    /^(?:episode|ep)\s*#?\s*\d{1,4}\s*$/.test(normalized.trim());

  if (!isEpisodeQuery) return null;

  return {
    type: 'metadata_episode_lookup',
    confidence: 'high',
    episodeNumber,
  };
}

function detectGuestSearchIntent(query: string): QueryIntent | null {
  const normalized = normalize(query);
  if (!/\bguest\b/.test(normalized)) return null;

  const name = extractGuestName(normalized);
  if (!name) return null;

  return {
    type: 'metadata_guest_search',
    confidence: 'medium',
    guestName: name,
  };
}

function detectEpisodeFieldsIntent(query: string): QueryIntent | null {
  const normalized = normalize(query);
  const wantsGuest = /\bguest\b/.test(normalized) || /\bguests\b/.test(normalized);
  const wantsReviewer =
    /\breviewer\b/.test(normalized) ||
    /\breviewed\b/.test(normalized) ||
    /\bwho reviewed\b/.test(normalized);
  const wantsReleaseDate =
    /\brelease date\b/.test(normalized) ||
    /\bwhen did\b.*\brelease\b/.test(normalized) ||
    /\bwhen was\b.*\breleased\b/.test(normalized) ||
    /\bwhat date\b.*\brelease\b/.test(normalized);
  const wantsKevsQuestion =
    /\bkev'?s?\s+question\b/.test(normalized) ||
    /\bkev\s+question\b/.test(normalized);

  if (!wantsGuest && !wantsReviewer && !wantsReleaseDate && !wantsKevsQuestion) return null;

  const episodeNumber = extractEpisodeNumberFromQuery(query);
  const film = episodeNumber ? null : findFilmFromQuery(query);
  if (episodeNumber === null && !film) return null;

  const episodeFields: MetadataEpisodeField[] = [];
  if (wantsGuest) episodeFields.push('guest');
  if (wantsReviewer) episodeFields.push('reviewer');
  if (wantsReleaseDate) episodeFields.push('releaseDate');
  if (wantsKevsQuestion) episodeFields.push('kevsQuestion');

  return {
    type: 'metadata_episode_fields',
    confidence: episodeNumber ? 'high' : 'medium',
    episodeFields,
    episodeNumber: episodeNumber ?? undefined,
    film: film ?? undefined,
  };
}

const AGGREGATE_FIELD_PATTERNS: Array<{ pattern: RegExp; field: AggregateRankField }> = [
  { pattern: /\b(actors?|actress(?:es)?|cast\s+members?|performers?)\b/i, field: 'cast' },
  { pattern: /\b(cinematographers?|dps?|director[s]?\s+of\s+photography)\b/i, field: 'cinematographers' },
  { pattern: /\b(directors?|filmmakers?)\b/i, field: 'directors' },
  { pattern: /\bgenres?\b/i, field: 'genres' },
];

function detectAggregateRankIntent(query: string): QueryIntent | null {
  const normalized = normalize(query);

  const hasRankSignal =
    /\bmost\b/.test(normalized) ||
    /\btop\s+\d+\b/.test(normalized) ||
    /\brank(ed|ing)?\b/.test(normalized) ||
    /\b(frequent|common|featured|covered|reviewed)\b/.test(normalized);
  if (!hasRankSignal) return null;

  // Field resolution — cinematographer before director so "director of photography" routes correctly
  let field: AggregateRankField | null = null;
  for (const { pattern, field: f } of AGGREGATE_FIELD_PATTERNS) {
    if (pattern.test(normalized)) { field = f; break; }
  }
  if (!field) return null;

  // Bail if the query names a specific director or film — that's a listing query, not a rank
  if (findDirectorFromQuery(query) || findFilmFromQuery(query)) return null;

  let aggregateLimit = 15;
  const topNMatch = normalized.match(/\btop\s+(\d+)\b/);
  if (topNMatch) {
    const n = parseInt(topNMatch[1], 10);
    if (n > 0 && n <= 50) aggregateLimit = n;
  }

  return {
    type: 'metadata_aggregate_rank',
    confidence: 'high',
    aggregateField: field,
    aggregateLimit,
  };
}

export function detectQueryIntent(query: string): QueryIntent {
  const normalized = normalize(query);
  const yearRange = extractYearRange(normalized);

  if (
    (normalized.includes('what does') && normalized.includes('do for a living')) ||
    (normalized.includes('what does') && normalized.includes('do for work')) ||
    (normalized.includes('what does') && normalized.includes('do for a job')) ||
    normalized.includes('what is their job') ||
    normalized.includes('what is his job') ||
    normalized.includes('what is her job') ||
    normalized.includes('what is their occupation') ||
    normalized.includes('what is his occupation') ||
    normalized.includes('what is her occupation')
  ) {
    return { type: 'transcript_only', confidence: 'high' };
  }

  if (normalized.includes('join the discord') || normalized.includes('joined the discord')) {
    return { type: 'transcript_only', confidence: 'high' };
  }

  const episodeFieldsIntent = detectEpisodeFieldsIntent(query);
  if (episodeFieldsIntent) {
    return episodeFieldsIntent;
  }

  const episodeLookupIntent = detectEpisodeLookupIntent(query);
  if (episodeLookupIntent) {
    return episodeLookupIntent;
  }

  const guestSearchIntent = detectGuestSearchIntent(query);
  if (guestSearchIntent) {
    return guestSearchIntent;
  }

  const aggregateRankIntent = detectAggregateRankIntent(query);
  if (aggregateRankIntent) {
    return aggregateRankIntent;
  }

  // Director-film listing: "what [director] movies/films have been episodes/covered/reviewed"
  const directorListingMatch = /\b(what|which|list)\b.*\b(movies?|films?|episodes?)\b/.test(normalized)
    && !yearRange // Don't hijack year-range queries
    && !/\bfilm\s+festival\b/.test(normalized); // "film festival" ≠ listing intent
  if (directorListingMatch) {
    const director = findDirectorFromQuery(query);
    if (director) {
      return { type: 'metadata_director_films', confidence: 'high', director };
    }
  }

  if ((normalized.includes('current season') || normalized.includes('what season') || normalized.includes('season is the pod on now'))
    && (normalized.includes('now') || normalized.includes('current') || normalized.includes('pod'))) {
    return { type: 'metadata_current_season', confidence: 'high' };
  }

  if (normalized.includes('how many episodes') || normalized.includes('total episodes')) {
    return { type: 'metadata_total_episodes', confidence: 'high' };
  }

  if (yearRange && wantsYearSample(normalized)) {
    return { type: 'metadata_year_range_sample', confidence: 'high', yearRange };
  }

  if (yearRange && (normalized.includes('how many films') || normalized.includes('how many movies') || normalized.includes('how many episodes'))) {
    return { type: 'metadata_year_range_count', confidence: 'high', yearRange };
  }

  const field = detectField(normalized);
  if (field) {
    if (normalized.includes('greatest') || normalized.includes('most') || normalized.includes('highest')) {
      return { type: 'metadata_field_max', confidence: 'high', field };
    }
    if (normalized.includes('last episode') || normalized.includes('latest episode') || normalized.includes('most recent')) {
      return { type: 'metadata_field_latest', confidence: 'high', field };
    }
    return { type: 'metadata_field_latest', confidence: 'high', field };
  }

  if (normalized.includes('last episode') || normalized.includes('latest episode') || normalized.includes('most recent episode')) {
    return { type: 'metadata_latest', confidence: 'high' };
  }

  if (/\bnotable moments?\b/.test(normalized)) {
    return { type: 'metadata_notable_moments', confidence: 'high' };
  }

  if (
    normalized.includes('tilda') &&
    (
      /\btilda\s+(play|would|should|pick|cast|as|role|segment|swinton)\b/.test(normalized) ||
      /\bcast\s+tilda\b/.test(normalized) ||
      /\bwho\s+would\s+tilda\b/.test(normalized) ||
      /\btilda\s+(question|segment|picks?|casting)\b/.test(normalized) ||
      /\broles?\b.*\btilda\b/.test(normalized) ||
      /\btilda\b.*\broles?\b/.test(normalized)
    )
  ) {
    return { type: 'metadata_tilda', confidence: 'high' };
  }

  return { type: 'none', confidence: 'high' };
}
