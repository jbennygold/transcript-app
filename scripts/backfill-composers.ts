#!/usr/bin/env node
/**
 * backfill-composers.ts — One-shot script to populate the `composers` field
 * on already-enriched episodes. enrich-tmdb.ts now extracts composers for
 * new episodes; this walks existing entries (tmdbId set, composers missing)
 * and fetches TMDB credits just for them.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { EpisodeMetadata } from '@/types/episode-metadata';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const RATE_LIMIT_DELAY = 260;

type MutableEpisodeMetadata = EpisodeMetadata & { composers?: string[] };

interface TMDBCredits {
  cast: Array<{ name: string; order: number }>;
  crew: Array<{ name: string; job: string; department: string }>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getMovieCredits(movieId: number): Promise<TMDBCredits | null> {
  const response = await fetch(
    `${TMDB_BASE_URL}/movie/${movieId}/credits?api_key=${TMDB_API_KEY}`
  );
  if (!response.ok) {
    console.log(`    ⚠ credits fetch failed: ${response.status}`);
    return null;
  }
  return response.json() as Promise<TMDBCredits>;
}

function extractComposers(credits: TMDBCredits): string[] {
  return credits.crew
    .filter((c) => c.job === 'Original Music Composer')
    .map((c) => c.name);
}

async function main() {
  if (!TMDB_API_KEY) {
    console.error('TMDB_API_KEY environment variable is required.');
    process.exit(1);
  }

  const metadataPath = path.join(process.cwd(), 'src', 'lib', 'metadata-data.ts');
  const backupPath = path.join(process.cwd(), 'src', 'lib', 'metadata-data.backup.json');

  const tsContent = fs.readFileSync(metadataPath, 'utf-8');
  const match = tsContent.match(/export const episodeMetadata[^=]*=\s*(\[[\s\S]*\]);?\s*$/);
  if (!match) {
    throw new Error(`Could not parse episode metadata array from ${metadataPath}`);
  }

  const episodes: MutableEpisodeMetadata[] = JSON.parse(match[1]);
  const targets = episodes.filter((e) => e.tmdbId && e.composers === undefined);
  console.log(`${episodes.length} total episodes, ${targets.length} to backfill.\n`);

  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  fs.writeFileSync(backupPath, JSON.stringify(episodes, null, 2));
  console.log(`Backup saved to ${backupPath}\n`);

  let filled = 0;
  let empty = 0;
  let failed = 0;

  function save() {
    fs.writeFileSync(
      metadataPath,
      `// Auto-generated - do not edit - ${episodes.length} episodes - updated ${new Date().toISOString().split('T')[0]}\n` +
      `import { EpisodeMetadata } from '@/types/episode-metadata';\n` +
      `export const episodeMetadata: EpisodeMetadata[] = ${JSON.stringify(episodes, null, 2)};\n`
    );
  }

  for (let i = 0; i < targets.length; i++) {
    const ep = targets[i];
    console.log(`[${i + 1}/${targets.length}] S${ep.season}E${ep.episode}: ${ep.film}`);
    const credits = await getMovieCredits(ep.tmdbId!);
    await sleep(RATE_LIMIT_DELAY);

    if (!credits) {
      ep.composers = [];
      failed++;
    } else {
      ep.composers = extractComposers(credits);
      if (ep.composers.length > 0) {
        console.log(`    Composer(s): ${ep.composers.join(', ')}`);
        filled++;
      } else {
        console.log('    (no composer listed on TMDB)');
        empty++;
      }
    }

    if ((i + 1) % 20 === 0) {
      save();
      console.log(`  [Progress saved: ${i + 1}/${targets.length}]\n`);
    }
  }

  save();
  console.log(`\nDone: ${filled} filled, ${empty} empty, ${failed} failed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
