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
import * as fs from 'node:fs';
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
  type TmdbSearchResult,
} from '../src/lib/episode-sources';
import { episodeSortKey, parseEpisodeId, type EpisodeId } from '../src/lib/episode-format';

// Match the module-scope pattern already used by scripts/notify-discord.ts so
// the entrypoint guard below works under tsx.
const __filename = fileURLToPath(import.meta.url);

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

/** Upper bound on episodes touched per --fill-gaps run, to cap API fan-out. */
const GAP_LIMIT = 15;

/**
 * Tier 1 is a go-forward mechanism, not an archive backfill: it fills columns
 * for episodes as they publish and retries on later passes for rows whose
 * Spotify/Patreon entries landed late. Everything below this episode predates
 * the feature and is left alone — historical rows carry whatever a human
 * entered, including deliberate blanks.
 *
 * Explicit --episodes=N is NOT subject to this floor; asking for a specific
 * episode means you want that episode.
 */
const TIER1_MIN_EPISODE = 315;

function log(msg: string) {
  console.log(`[populate-tier1] ${msg}`);
}

/**
 * Surface a one-line summary in the GitHub Actions job UI (same pattern as
 * check-new-episodes.ts's writeReport) so a revoked sheet grant or expired
 * credential shows up outside a collapsed log step instead of behind a green
 * check with no signal. Never fatal: main() still exits 0 either way, and a
 * failure writing the file itself is only logged, never thrown.
 */
function writeStepSummary(line: string) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, line + '\n');
  } catch (err) {
    log(`Could not write GITHUB_STEP_SUMMARY: ${err instanceof Error ? err.message : String(err)}`);
  }
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

/** Minimal shape needed to decide whether a row still needs Tier 1 columns. */
export interface Tier1Candidate {
  episode: EpisodeId;
  length?: string;
  showLink?: string;
  artworkLink?: string;
  imdbLink?: string;
  letterboxdLink?: string;
}

/**
 * Episodes at or above `floor` that still have at least one blank Tier 1
 * column, most recent first, capped at `limit`.
 */
export function selectGapTargets(
  episodes: Tier1Candidate[],
  floor: number,
  limit: number
): EpisodeId[] {
  return episodes
    .filter(ep => episodeSortKey(ep.episode) >= floor)
    .filter(ep => !ep.length || !ep.showLink || !ep.artworkLink || !ep.imdbLink || !ep.letterboxdLink)
    .sort((a, b) => episodeSortKey(b.episode) - episodeSortKey(a.episode))
    .slice(0, limit)
    .map(ep => ep.episode);
}

/**
 * Pick the TMDB result matching a known release year.
 * With no known year, falls back to the top hit. With a known year and no
 * agreeing result, returns null — writing nothing beats writing a wrong link
 * we can never correct.
 */
export function pickTmdbMatch(
  results: TmdbSearchResult[],
  filmYear: number | null
): TmdbSearchResult | null {
  if (results.length === 0) return null;
  if (filmYear === null) return results[0];
  return results.find(r => r.year === String(filmYear)) ?? null;
}

async function resolveTmdb(
  film: string,
  filmYear: number | null,
  tmdbId?: number
): Promise<TmdbDetails | null> {
  if (tmdbId) return fetchTmdbDetails(tmdbId);
  // meta.film carries a "(YYYY)" suffix; TMDB's query param does not parse a
  // year out of it, so strip it before searching and verify the hit against
  // the known year instead of trusting popularity ranking (see pickTmdbMatch).
  const query = film.replace(/\s*\(\d{4}\)\s*$/, '');
  const results = await searchTmdb(query);
  const match = results ? pickTmdbMatch(results, filmYear) : null;
  return match ? fetchTmdbDetails(match.id) : null;
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
    targets = selectGapTargets(loadEpisodeMetadata(), TIER1_MIN_EPISODE, GAP_LIMIT).map(ep => String(ep));
    log(`--fill-gaps selected ${targets.length} episode(s) at or above ep ${TIER1_MIN_EPISODE} (cap ${GAP_LIMIT}).`);
  } else {
    log('Nothing to do — pass --episodes=<list> or --fill-gaps.');
    return;
  }

  let filled = 0;
  let skipped = 0;
  let failed = 0;

  for (const episode of targets) {
    // getEpisodeByNumber compares with strict equality against metadata's
    // `episode` field, which is a number for regular episodes but a string
    // for bonus episodes (e.g. "147b1"). parseEpisodeId matches that typing
    // so both kinds resolve correctly.
    const meta = getEpisodeByNumber(parseEpisodeId(episode));
    if (!meta) {
      log(`Episode ${episode}: no matching row in metadata — skipping.`);
      skipped++;
      continue;
    }
    if (!meta.film) {
      log(`Episode ${episode}: metadata row has no film title — skipping.`);
      skipped++;
      continue;
    }

    const [spotify, patreon, tmdb] = await Promise.all([
      // Unattended writes require an exact normalized-title match:
      // interactive /podreview has a human reviewing the result, so its
      // lenient floor (the fetch* default) is fine; a cron job is not, and a
      // 0.8 containment near-miss (e.g. "Her" inside "the godfather") would
      // get written into a blank cell permanently.
      fetchSpotifyMatch(meta.film, true).catch(() => null),
      fetchPatreonMatch(meta.film, true).catch(() => null),
      resolveTmdb(meta.film, meta.filmYear, meta.tmdbId).catch(() => null),
    ]);

    const row = buildTier1Row(episode, spotify, patreon, tmdb);
    const fieldCount = Object.keys(row).length - 1; // minus Ep
    if (fieldCount === 0) {
      log(`Episode ${episode} (${meta.film}): no source data found.`);
      skipped++;
      continue;
    }

    if (dryRun) {
      log(`Episode ${episode} (${meta.film}) would fill: ${JSON.stringify(row)}`);
      continue;
    }

    try {
      const result = await upsertEpisodeRow(row, 'fill-empty');
      if (result.action === 'skipped_no_row') {
        // Tier 1 never creates a row — a human stubs it first. No matching
        // Ep means sheet drift (renumbered/deleted row, zero-padded Ep),
        // not "nothing to fill", so this gets its own log line rather than
        // being folded into "already complete".
        log(`Episode ${episode} (${meta.film}): no matching sheet row — skipping (Tier 1 never inserts).`);
        skipped++;
      } else if (result.action === 'no_change') {
        log(`Episode ${episode} (${meta.film}): already complete.`);
        skipped++;
      } else {
        log(`Episode ${episode} (${meta.film}): filled ${result.changedFields.join(', ')}.`);
        filled++;
      }
    } catch (err) {
      log(`Episode ${episode}: write failed — ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  if (!dryRun) {
    writeStepSummary(`Tier 1: ${filled} filled, ${skipped} skipped, ${failed} failed.`);
  }
}

if (process.argv[1] === __filename) {
  main().catch(err => {
    console.error('[populate-tier1] Fatal error:', err);
    process.exit(1);
  });
}
