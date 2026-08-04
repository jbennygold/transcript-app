/**
 * Third-party lookups for episode metadata: Spotify (length, artwork),
 * Patreon (show link), TMDB (IMDB + Letterboxd links).
 *
 * Pure scoring/formatting helpers are exported separately from the network
 * calls so they can be unit-tested without credentials.
 */

const SPOTIFY_SHOW_ID = '6qd41W3ueh2NLdKu9Xwt5G';
const PATREON_CAMPAIGN_ID = '10527831';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

export interface SpotifyMatch {
  title: string;
  duration: string;
  durationMinutes: string;
  releaseDate: string;
  artworkUrl: string;
  spotifyUrl: string;
}

export interface PatreonMatch {
  title: string;
  publishedAt: string;
  showLink: string;
}

export interface TmdbDetails {
  tmdbId: number;
  title: string;
  year: string | null;
  imdbId: string | null;
  imdbLink: string;
  letterboxdLink: string;
}

export interface TmdbSearchResult {
  id: number;
  title: string;
  releaseDate: string;
  year: string | null;
  posterPath: string | null;
}

// ── Pure helpers ──

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\(\d{4}\)\s*/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isVideoOrUncut(title: string): boolean {
  const upper = title.toUpperCase();
  return upper.includes('VIDEO') || upper.includes('UNCUT');
}

export function scoreMatch(query: string, candidate: string): number {
  const q = normalizeTitle(query);
  const c = normalizeTitle(candidate);
  if (q === c) return 1.0;
  if (c.includes(q) || q.includes(c)) return 0.8;
  const qWords = q.split(' ').filter(Boolean);
  const cWords = new Set(c.split(' ').filter(Boolean));
  const overlap = qWords.filter(w => cWords.has(w)).length;
  return overlap / Math.max(qWords.length, 1);
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDurationMinutes(ms: number): string {
  return String(Math.round(ms / 60000));
}

export function letterboxdSlug(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

export function buildTmdbDetails(movie: Record<string, unknown>): TmdbDetails {
  const imdbId = (movie.imdb_id as string | null) || null;
  const slug = letterboxdSlug(String(movie.title ?? ''));
  const releaseDate = movie.release_date ? String(movie.release_date) : '';
  return {
    tmdbId: Number(movie.id),
    title: String(movie.title ?? ''),
    year: releaseDate ? releaseDate.slice(0, 4) : null,
    imdbId,
    imdbLink: imdbId ? `https://www.imdb.com/title/${imdbId}/` : '',
    letterboxdLink: slug ? `https://letterboxd.com/film/${slug}/` : '',
  };
}

// ── Spotify ──

let showArtworkUrl: string | null = null;

async function getSpotifyToken(): Promise<string | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token || null;
}

async function getShowArtworkUrl(token: string): Promise<string | null> {
  if (showArtworkUrl) return showArtworkUrl;
  const res = await fetch(`https://api.spotify.com/v1/shows/${SPOTIFY_SHOW_ID}?fields=images`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  showArtworkUrl = data.images?.[0]?.url || null;
  return showArtworkUrl;
}

/**
 * @param minScore Minimum scoreMatch value to accept a candidate, defaulting
 *   to the interactive /podreview floor (0.5). Unattended callers (Tier 1)
 *   pass 1.0 to require an exact normalized-title match — at 0.5 a short
 *   title like "Her" scores 0.8 against any candidate containing it as a
 *   substring (e.g. "The Godfather"), which a human reviewing /podreview
 *   would catch but a cron job would write permanently into a blank cell.
 */
export async function fetchSpotifyMatch(query: string, minScore = 0.5): Promise<SpotifyMatch | null> {
  const token = await getSpotifyToken();
  if (!token) return null;

  const params = new URLSearchParams({
    q: `${query} show:Escape Hatch`,
    type: 'episode',
    limit: '10',
  });

  const res = await fetch(`https://api.spotify.com/v1/search?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const episodes = (data.episodes?.items || []) as Array<{
    name: string;
    duration_ms: number;
    release_date: string;
    images?: Array<{ url: string }>;
    external_urls?: { spotify?: string };
  }>;

  // Compare against minScore with >=, not >, so a minScore of 1.0 (the
  // unattended floor) can actually accept an exact match — a strict ">"
  // floor comparison would reject a 1.0-scoring candidate against a 1.0
  // floor and never match anything.
  let bestScore = -Infinity;
  let bestEp: (typeof episodes)[number] | null = null;
  for (const ep of episodes) {
    if (isVideoOrUncut(ep.name)) continue;
    const score = scoreMatch(query, ep.name);
    if (score >= minScore && score > bestScore) {
      bestScore = score;
      bestEp = ep;
    }
  }
  if (!bestEp) return null;

  // Suppress the show's generic cover — it means no episode art exists yet.
  let artworkUrl = bestEp.images?.[0]?.url || '';
  if (artworkUrl) {
    const showArt = await getShowArtworkUrl(token);
    if (showArt && artworkUrl === showArt) artworkUrl = '';
  }

  return {
    title: bestEp.name,
    duration: formatDuration(bestEp.duration_ms),
    durationMinutes: formatDurationMinutes(bestEp.duration_ms),
    releaseDate: bestEp.release_date,
    artworkUrl,
    spotifyUrl: bestEp.external_urls?.spotify || '',
  };
}

// ── Patreon ──

/**
 * @param minScore Minimum scoreMatch value to accept a candidate, defaulting
 *   to the interactive /podreview floor (0.5). Unattended callers (Tier 1)
 *   pass 1.0 to require an exact normalized-title match — see the identical
 *   comment on fetchSpotifyMatch for why.
 */
export async function fetchPatreonMatch(query: string, minScore = 0.5): Promise<PatreonMatch | null> {
  const token = process.env.PATREON_CREATOR_TOKEN;
  if (!token) return null;

  // See fetchSpotifyMatch for why this compares with >= against minScore
  // rather than treating minScore itself as the running "bestScore".
  let bestScore = -Infinity;
  let best: PatreonMatch | null = null;

  let nextUrl: string | null =
    `https://www.patreon.com/api/oauth2/v2/campaigns/${PATREON_CAMPAIGN_ID}/posts?fields%5Bpost%5D=title,published_at,url&page%5Bcount%5D=50`;

  let pages = 0;
  const maxPages = 8;

  while (nextUrl && pages < maxPages) {
    const res: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) break;
    const data = await res.json();

    for (const post of data.data || []) {
      const title = post.attributes?.title || '';
      if (isVideoOrUncut(title)) continue;
      const score = scoreMatch(query, title);
      if (score >= minScore && score > bestScore) {
        bestScore = score;
        best = {
          title,
          publishedAt: post.attributes.published_at || '',
          showLink: `https://www.patreon.com${post.attributes.url || ''}`,
        };
        if (score >= 1.0) return best;
      }
    }

    nextUrl = data.links?.next || null;
    pages++;
  }

  return best;
}

// ── TMDB ──

/**
 * Returns null when the upstream call fails, [] when it succeeds with no
 * matches — and also [] for the no-API-key and short-query short-circuits
 * below, which are not successes. Those two short-circuits are deliberate:
 * populate-tier1 calls this without its own key/length checks, so returning
 * [] here (rather than null) is what lets the CLI degrade gracefully when
 * TMDB_API_KEY is absent, instead of erroring.
 */
export async function searchTmdb(query: string): Promise<TmdbSearchResult[] | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey || query.trim().length < 2) return [];

  const params = new URLSearchParams({ api_key: apiKey, query: query.trim() });
  const res = await fetch(`${TMDB_BASE_URL}/search/movie?${params}`);
  if (!res.ok) return null;

  const data = await res.json();
  return ((data.results || []) as Array<Record<string, unknown>>).slice(0, 8).map(r => ({
    id: Number(r.id),
    title: String(r.title ?? ''),
    releaseDate: r.release_date ? String(r.release_date) : '',
    year: r.release_date ? String(r.release_date).slice(0, 4) : null,
    posterPath: r.poster_path ? `https://image.tmdb.org/t/p/w92${r.poster_path}` : null,
  }));
}

export async function fetchTmdbDetails(tmdbId: number): Promise<TmdbDetails | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  const res = await fetch(
    `${TMDB_BASE_URL}/movie/${tmdbId}?api_key=${apiKey}&append_to_response=external_ids`
  );
  if (!res.ok) return null;

  return buildTmdbDetails(await res.json());
}
