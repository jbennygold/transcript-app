#!/usr/bin/env node
/**
 * generate-proposals.ts — build Tier 2 proposals for one episode.
 *
 * Runs after ingest, so the transcript is speaker-mapped. Writes proposals to
 * Blob; NEVER writes to the sheet. A human accepts or rejects each field in
 * /podreview and that acceptance is the only thing that touches the sheet.
 *
 * Usage:
 *   npm run generate-proposals -- --episode=317
 *   npm run generate-proposals -- --episode=317 --dry-run
 */
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import {
  buildProposals,
  saveProposals,
  type FieldProposal,
} from '../src/lib/pdc-proposals';
import { countThatsGreat } from '../src/lib/tier2-counters';
import {
  extractKevQuestion,
  extractTildaPicks,
  isSpeakerMapped,
  type KevExtraction,
  type TildaExtraction,
} from '../src/lib/tier2-extract';
import { parseEpisodeId } from '../src/lib/episode-format';
import { searchTmdb, fetchTmdbDetails } from '../src/lib/episode-sources';
import { pickTmdbMatch } from './populate-tier1';

const __filename = fileURLToPath(import.meta.url);

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

function log(msg: string) {
  console.log(`[generate-proposals] ${msg}`);
}

export interface CurrentValues {
  film: string;
  kevsQuestion: string;
  tildaH: string;
  tildaJason: string;
  tildaGuest: string | null;
  tildaCorey: string | null;
  thatsGreatCount: number;
}

export interface ProposalInput {
  current: CurrentValues;
  kev: KevExtraction;
  tilda: TildaExtraction;
  thatsGreat: number | null;
  canonicalFilm: string | null;
}

/** The sheet stores "N/A" for an unanswered field; surface that as null. */
function normaliseCurrent(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  return t === '' || t.toUpperCase() === 'N/A' ? null : t;
}

export function buildProposalFields(
  input: ProposalInput
): Array<Omit<FieldProposal, 'status'>> {
  const out: Array<Omit<FieldProposal, 'status'>> = [];

  const add = (
    column: FieldProposal['column'],
    proposed: string | null,
    current: string | null,
    confidence: FieldProposal['confidence'],
    evidence?: string | null
  ) => {
    if (proposed === null || proposed.trim() === '') return;
    const cur = normaliseCurrent(current);
    if (cur !== null && cur === proposed.trim()) return; // already correct
    out.push({
      column,
      proposed: proposed.trim(),
      current: cur,
      confidence,
      ...(evidence ? { evidence } : {}),
    });
  };

  if (input.canonicalFilm && input.canonicalFilm !== input.current.film) {
    add('Film', input.canonicalFilm, input.current.film, 'low');
  }

  add('Kevs_Question', input.kev.question, input.current.kevsQuestion, 'high', input.kev.evidence);

  add('TildaH', input.tilda.tildaH, input.current.tildaH, 'high');
  add('TildaJason', input.tilda.tildaJason, input.current.tildaJason, 'high');
  add('TildaGuest', input.tilda.tildaGuest, input.current.tildaGuest, 'low');
  add('TildaCorey', input.tilda.tildaCorey, input.current.tildaCorey, 'low');

  if (input.thatsGreat !== null) {
    // `|| ''` would turn a genuine 0 into '', defeating the "already
    // correct" dedup below and proposing "0" on every zero-count episode.
    add('Thats_Great_Count', String(input.thatsGreat), String(input.current.thatsGreatCount), 'low');
  }

  return out;
}

/**
 * The canonical `Title (YYYY)` form TMDB knows the film by, or null.
 *
 * Title mismatch is a known failure mode in this codebase: findFilmFromQuery()
 * matches against canonical titles with year suffixes, and normalizeEpisodeTitle()
 * exists solely to reconcile the two forms. Proposing the canonical form keeps
 * retrieval working; it is staged rather than written because Film is never blank.
 */
async function resolveCanonicalFilm(film: string, filmYear: number | null): Promise<string | null> {
  const results = await searchTmdb(film.replace(/\s*\(\d{4}\)\s*$/, ''));
  if (!results) return null;
  const hit = pickTmdbMatch(results, filmYear);
  if (!hit) return null;
  const details = await fetchTmdbDetails(hit.id);
  if (!details || !details.title) return null;
  return details.year ? `${details.title} (${details.year})` : details.title;
}

function getArg(args: string[], flag: string): string | undefined {
  const hit = args.find(a => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const raw = getArg(args, '--episode');
  if (!raw) {
    log('Nothing to do — pass --episode=<id>.');
    return;
  }
  // The ingest workflow passes the app's identifier ("episode_317"); strip it.
  const episode = raw.replace(/^episode_/, '').trim();

  const { getEpisodeByNumber } = await import('../src/lib/metadata-store');
  const { loadTranscript } = await import('../src/lib/blob-storage');

  const meta = getEpisodeByNumber(parseEpisodeId(episode));
  if (!meta) {
    log(`Episode ${episode}: no matching row in metadata — skipping.`);
    return;
  }

  const epNum = Number(episode);
  if (!Number.isFinite(epNum)) {
    log(`Episode ${episode}: transcripts are keyed by number; bonus ids are not supported — skipping.`);
    return;
  }
  const transcript = await loadTranscript(epNum);
  if (!transcript) {
    log(`Episode ${episode}: no transcript in Blob — skipping.`);
    return;
  }

  const dialogues = transcript.dialogues ?? [];
  const tgDerived = countThatsGreat(dialogues).total;
  log(`Derived That's Great count: ${tgDerived}`);

  if (!isSpeakerMapped(dialogues)) {
    log(`Episode ${episode}: transcript is not speaker-mapped — Tilda picks skipped.`);
  }

  // TMDB canonical title. Reuses Tier 1's year-verified selection, so a remake
  // cannot masquerade as the episode's film. A null year or no year-agreeing
  // result yields no proposal rather than a guess.
  const canonicalFilm = await resolveCanonicalFilm(meta.film, meta.filmYear).catch(() => null);

  // extractKevQuestion and extractTildaPicks already guarantee they never
  // throw (they catch and console.warn internally, returning all-nulls) — a
  // second .catch() here would only swallow that signal a layer deeper
  // without adding any safety, so none is added.
  const [kev, tilda] = await Promise.all([
    extractKevQuestion(transcript),
    extractTildaPicks(transcript),
  ]);

  const fields = buildProposalFields({
    current: {
      film: meta.film,
      kevsQuestion: meta.kevsQuestion,
      tildaH: meta.tildaH,
      tildaJason: meta.tildaJason,
      tildaGuest: meta.tildaGuest,
      tildaCorey: meta.tildaCorey,
      thatsGreatCount: meta.thatsGreatCount,
    },
    kev,
    tilda,
    thatsGreat: tgDerived,
    canonicalFilm,
  });

  if (fields.length === 0) {
    log(`Episode ${episode}: nothing to propose.`);
    return;
  }

  const doc = buildProposals(episode, meta.film, new Date().toISOString(), fields);

  if (dryRun) {
    log(`Would save ${fields.length} proposal(s): ${JSON.stringify(doc, null, 2)}`);
    return;
  }

  await saveProposals(doc);
  log(`Episode ${episode}: saved ${fields.length} proposal(s) — ${fields.map(f => f.column).join(', ')}`);

  // Let the workflow trigger the "proposals ready" Discord notification —
  // without this, proposals accumulate in Blob with nobody told to look.
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    try {
      const fs = await import('node:fs');
      const film = meta.film.replace(/\r?\n/g, ' ');
      fs.appendFileSync(githubOutput, `proposal_count=${fields.length}\nproposal_film=${film}\n`);
    } catch {
      // never fatal
    }
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      const fs = await import('node:fs');
      fs.appendFileSync(
        summaryPath,
        `\nTier 2: ${fields.length} proposal(s) for episode ${episode} — review at /podreview\n`
      );
    } catch {
      // never fatal
    }
  }
}

if (process.argv[1] === __filename) {
  main().catch(err => {
    console.error('[generate-proposals] Fatal error:', err);
    process.exit(1);
  });
}
