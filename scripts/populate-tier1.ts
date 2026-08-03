#!/usr/bin/env node
/**
 * populate-tier1.ts — fill the deterministic Pod Data Central columns.
 *
 * Fills Length, Length_minutes, Show_Link, Artwork_Link, Letterboxd_Link and
 * IMDB_Link from Spotify, Patreon and TMDB. Writes in 'fill-empty' mode, so a
 * cell somebody already typed into is never touched. Safe to re-run.
 *
 * Usage:
 *   npm run populate-tier1 -- --episodes=317,318
 *   npm run populate-tier1 -- --fill-gaps          # 15 most recent rows with holes
 *   npm run populate-tier1 -- --episodes=317 --dry-run
 */
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import {
  upsertEpisodeRow,
  hasSheetCredentials,
  type PdcRow,
} from '../src/lib/pdc-sheet';
import {
  fetchSpotifyMatch,
  fetchPatreonMatch,
  searchTmdb,
  fetchTmdbDetails,
  type SpotifyMatch,
  type PatreonMatch,
  type TmdbDetails,
} from '../src/lib/episode-sources';
import { episodeSortKey, parseEpisodeId } from '../src/lib/episode-format';

// Match the module-scope pattern already used by scripts/notify-discord.ts so
// the entrypoint guard below works under tsx.
const __filename = fileURLToPath(import.meta.url);

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

/** Upper bound on episodes touched per --fill-gaps run, to cap API fan-out. */
const GAP_LIMIT = 15;

function log(msg: string) {
  console.log(`[populate-tier1] ${msg}`);
}

/** Assemble the sheet row from whatever the sources returned. Blank values are omitted. */
export function buildTier1Row(
  episode: string,
  spotify: SpotifyMatch | null,
  patreon: PatreonMatch | null,
  tmdb: TmdbDetails | null
): PdcRow {
  const row: PdcRow = { Ep: episode };
  const set = (key: keyof PdcRow, value: string | undefined | null) => {
    if (value && value.trim() !== '') row[key] = value;
  };

  set('Length', spotify?.duration);
  set('Length_minutes', spotify?.durationMinutes);
  set('Artwork_Link', spotify?.artworkUrl);
  set('Show_Link', patreon?.showLink);
  set('IMDB_Link', tmdb?.imdbLink);
  set('Letterboxd_Link', tmdb?.letterboxdLink);

  return row;
}

async function resolveTmdb(film: string, tmdbId?: number): Promise<TmdbDetails | null> {
  if (tmdbId) return fetchTmdbDetails(tmdbId);
  const results = await searchTmdb(film);
  return results && results.length > 0 ? fetchTmdbDetails(results[0].id) : null;
}

function getArgValue(args: string[], flag: string): string | undefined {
  const hit = args.find(a => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fillGaps = args.includes('--fill-gaps');
  const episodesArg = getArgValue(args, '--episodes');

  if (!hasSheetCredentials()) {
    log('No Google Sheets credentials — skipping.');
    return;
  }

  const { loadEpisodeMetadata, getEpisodeByNumber } = await import('../src/lib/metadata-store');

  let targets: string[];
  if (episodesArg) {
    targets = episodesArg.split(',').map(s => s.trim()).filter(Boolean);
  } else if (fillGaps) {
    targets = loadEpisodeMetadata()
      .filter(ep => !ep.length || !ep.showLink || !ep.artworkLink || !ep.imdbLink || !ep.letterboxdLink)
      .sort((a, b) => episodeSortKey(b.episode) - episodeSortKey(a.episode))
      .slice(0, GAP_LIMIT)
      .map(ep => String(ep.episode));
    log(`--fill-gaps selected ${targets.length} episode(s) (cap ${GAP_LIMIT}).`);
  } else {
    log('Nothing to do — pass --episodes=<list> or --fill-gaps.');
    return;
  }

  for (const episode of targets) {
    // getEpisodeByNumber compares with strict equality against metadata's
    // `episode` field, which is a number for regular episodes but a string
    // for bonus episodes (e.g. "147b1"). parseEpisodeId matches that typing
    // so both kinds resolve correctly.
    const meta = getEpisodeByNumber(parseEpisodeId(episode));
    if (!meta) {
      log(`Episode ${episode}: no matching row in metadata — skipping.`);
      continue;
    }
    if (!meta.film) {
      log(`Episode ${episode}: metadata row has no film title — skipping.`);
      continue;
    }

    const [spotify, patreon, tmdb] = await Promise.all([
      fetchSpotifyMatch(meta.film).catch(() => null),
      fetchPatreonMatch(meta.film).catch(() => null),
      resolveTmdb(meta.film, meta.tmdbId).catch(() => null),
    ]);

    const row = buildTier1Row(episode, spotify, patreon, tmdb);
    const fieldCount = Object.keys(row).length - 1; // minus Ep
    if (fieldCount === 0) {
      log(`Episode ${episode} (${meta.film}): no source data found.`);
      continue;
    }

    if (dryRun) {
      log(`Episode ${episode} (${meta.film}) would fill: ${JSON.stringify(row)}`);
      continue;
    }

    try {
      const result = await upsertEpisodeRow(row, 'fill-empty');
      if (result.action === 'no_change') {
        log(`Episode ${episode} (${meta.film}): already complete.`);
      } else {
        log(`Episode ${episode} (${meta.film}): filled ${result.changedFields.join(', ')}.`);
      }
    } catch (err) {
      log(`Episode ${episode}: write failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

if (process.argv[1] === __filename) {
  main().catch(err => {
    console.error('[populate-tier1] Fatal error:', err);
    process.exit(1);
  });
}
