/**
 * Enrich episode metadata with TMDB (The Movie Database) data.
 * Adds director, cinematographer, cast, and genre information.
 *
 * Usage: TMDB_API_KEY=your_key node --import tsx ./scripts/enrich-tmdb.ts
 *
 * Get a free API key at: https://www.themoviedb.org/settings/api
 */

import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import type { EpisodeMetadata } from '@/types/episode-metadata';

// Load .env.local first, then .env as fallback
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

interface TMDBSearchResult {
  id: number;
  title: string;
  release_date: string;
  poster_path: string | null;
}

interface TMDBCredits {
  cast: Array<{ name: string; order: number }>;
  crew: Array<{ name: string; job: string; department: string }>;
}

interface TMDBMovieDetails {
  id: number;
  title: string;
  genres: Array<{ id: number; name: string }>;
  poster_path: string | null;
}

type MutableEpisodeMetadata = EpisodeMetadata & {
  [key: string]: unknown;
};

// Rate limiting: TMDB allows 40 requests per 10 seconds
const RATE_LIMIT_DELAY = 260; // ~260ms between requests = ~38 req/10s

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchMovie(title: string, year?: number | null): Promise<TMDBSearchResult | null> {
  // Clean up title - remove year suffix like "(1985)" and "Part 1/2"
  let cleanTitle = title
    .replace(/\s*\(\d{4}\)\s*/g, '')
    .replace(/\s*Part\s*\d+\s*/gi, '')
    .replace(/\s*-\s*Part\s*\d+\s*/gi, '')
    .trim();

  const params = new URLSearchParams({
    api_key: TMDB_API_KEY!,
    query: cleanTitle,
  });

  if (year) {
    params.append('year', String(year));
  }

  try {
    const response = await fetch(`${TMDB_BASE_URL}/search/movie?${params}`);
    if (!response.ok) {
      console.error(`  TMDB search failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (data.results && data.results.length > 0) {
      // Return the first result (most relevant)
      return data.results[0];
    }

    // Try without year if no results
    if (year) {
      params.delete('year');
      const retryResponse = await fetch(`${TMDB_BASE_URL}/search/movie?${params}`);
      const retryData = await retryResponse.json();
      if (retryData.results && retryData.results.length > 0) {
        return retryData.results[0];
      }
    }

    return null;
  } catch (error) {
    console.error(`  TMDB search error: ${error}`);
    return null;
  }
}

async function getMovieDetails(movieId: number): Promise<TMDBMovieDetails | null> {
  try {
    const response = await fetch(
      `${TMDB_BASE_URL}/movie/${movieId}?api_key=${TMDB_API_KEY}`
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function getMovieCredits(movieId: number): Promise<TMDBCredits | null> {
  try {
    const response = await fetch(
      `${TMDB_BASE_URL}/movie/${movieId}/credits?api_key=${TMDB_API_KEY}`
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function extractDirectors(credits: TMDBCredits): string[] {
  return credits.crew
    .filter((c) => c.job === 'Director')
    .map((c) => c.name);
}

function extractCinematographers(credits: TMDBCredits): string[] {
  return credits.crew
    .filter((c) => c.job === 'Director of Photography' || c.job === 'Cinematography')
    .map((c) => c.name);
}

function extractTopCast(credits: TMDBCredits, limit: number = 8): string[] {
  return credits.cast
    .sort((a, b) => a.order - b.order)
    .slice(0, limit)
    .map((c) => c.name);
}

function extractComposers(credits: TMDBCredits): string[] {
  return credits.crew
    .filter((c) => c.job === 'Original Music Composer')
    .map((c) => c.name);
}

async function enrichEpisode(episode: EpisodeMetadata): Promise<EpisodeMetadata> {
  // Skip if already enriched
  if (episode.tmdbId) {
    return episode;
  }

  // Skip non-film episodes (like "Dune (1965) Part 1" which is actually a book)
  const skipPatterns = [
    /^Dune \(1965\)/i,  // Book discussions
    /Mailbag/i,
    /Q&A/i,
    /Bonus/i,
    /Live Show/i,
  ];

  if (skipPatterns.some((p) => p.test(episode.film))) {
    console.log(`  Skipping non-film: ${episode.film}`);
    return episode;
  }

  console.log(`  Searching TMDB for: ${episode.film}`);

  const searchResult = await searchMovie(episode.film, episode.filmYear);
  await sleep(RATE_LIMIT_DELAY);

  if (!searchResult) {
    console.log(`    ⚠ No TMDB match found`);
    return episode;
  }

  console.log(`    Found: ${searchResult.title} (${searchResult.release_date?.slice(0, 4) || 'N/A'})`);

  // Get movie details for genres
  const details = await getMovieDetails(searchResult.id);
  await sleep(RATE_LIMIT_DELAY);

  // Get credits for director, cinematographer, cast
  const credits = await getMovieCredits(searchResult.id);
  await sleep(RATE_LIMIT_DELAY);

  const enriched: EpisodeMetadata = {
    ...episode,
    tmdbId: searchResult.id,
    tmdbPosterPath: searchResult.poster_path || undefined,
  };

  if (details?.genres) {
    enriched.genres = details.genres.map((g) => g.name);
    console.log(`    Genres: ${enriched.genres.join(', ')}`);
  }

  if (credits) {
    enriched.directors = extractDirectors(credits);
    enriched.cinematographers = extractCinematographers(credits);
    enriched.cast = extractTopCast(credits);
    enriched.composers = extractComposers(credits);

    if (enriched.directors.length > 0) {
      console.log(`    Director(s): ${enriched.directors.join(', ')}`);
    }
    if (enriched.cinematographers.length > 0) {
      console.log(`    DP: ${enriched.cinematographers.join(', ')}`);
    }
    if (enriched.cast.length > 0) {
      console.log(`    Cast: ${enriched.cast.slice(0, 3).join(', ')}...`);
    }
    if (enriched.composers.length > 0) {
      console.log(`    Composer(s): ${enriched.composers.join(', ')}`);
    }
  }

  return enriched;
}

async function main() {
  if (!TMDB_API_KEY) {
    console.error('Error: TMDB_API_KEY environment variable is required.');
    console.error('Get a free API key at: https://www.themoviedb.org/settings/api');
    console.error('Then run: TMDB_API_KEY=your_key node --import tsx ./scripts/enrich-tmdb.ts');
    process.exit(1);
  }

  const metadataPath = path.join(process.cwd(), 'src', 'lib', 'metadata-data.ts');
  const backupPath = path.join(process.cwd(), 'src', 'lib', 'metadata-data.backup.json');

  console.log('Loading episode metadata...');
  const tsContent = fs.readFileSync(metadataPath, 'utf-8');
  const match = tsContent.match(/export const episodeMetadata[^=]*=\s*(\[[\s\S]*\]);?\s*$/);
  if (!match) {
    throw new Error(`Could not parse episode metadata array from ${metadataPath}`);
  }
  const episodes: MutableEpisodeMetadata[] = JSON.parse(match[1]);
  console.log(`Found ${episodes.length} episodes.\n`);

  // Create backup
  fs.writeFileSync(backupPath, JSON.stringify(episodes, null, 2));
  console.log(`Backup saved to ${backupPath}\n`);

  // Track stats
  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  let alreadyDone = 0;

  console.log('Enriching episodes with TMDB data...\n');

  const enrichedEpisodes: MutableEpisodeMetadata[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i];
    console.log(`[${i + 1}/${episodes.length}] S${episode.season}E${episode.episode}: ${episode.film}`);

    if (episode.tmdbId) {
      console.log('  Already enriched, skipping.\n');
      enrichedEpisodes.push(episode);
      alreadyDone++;
      continue;
    }

    const enrichedEp = await enrichEpisode(episode);
    enrichedEpisodes.push(enrichedEp);

    if (enrichedEp.tmdbId) {
      enriched++;
    } else if (enrichedEp === episode) {
      skipped++;
    } else {
      failed++;
    }

    console.log('');

    // Save progress every 20 episodes
    if ((i + 1) % 20 === 0) {
      const partial = enrichedEpisodes.concat(episodes.slice(i + 1));
      fs.writeFileSync(
        metadataPath,
        `// Auto-generated - do not edit - ${partial.length} episodes - updated ${new Date().toISOString().split('T')[0]}\n` +
        `import { EpisodeMetadata } from '@/types/episode-metadata';\n` +
        `export const episodeMetadata: EpisodeMetadata[] = ${JSON.stringify(partial, null, 2)};\n`
      );
      console.log(`  [Progress saved: ${i + 1}/${episodes.length}]\n`);
    }
  }

  // Final save
  fs.writeFileSync(
    metadataPath,
    `// Auto-generated - do not edit - ${enrichedEpisodes.length} episodes - updated ${new Date().toISOString().split('T')[0]}\n` +
    `import { EpisodeMetadata } from '@/types/episode-metadata';\n` +
    `export const episodeMetadata: EpisodeMetadata[] = ${JSON.stringify(enrichedEpisodes, null, 2)};\n`
  );

  console.log('\n=== TMDB Enrichment Complete ===');
  console.log(`  Enriched: ${enriched}`);
  console.log(`  Already done: ${alreadyDone}`);
  console.log(`  Skipped (non-film): ${skipped}`);
  console.log(`  Failed (no match): ${failed}`);
  console.log(`\nMetadata saved to ${metadataPath}`);
}

main().catch(console.error);
