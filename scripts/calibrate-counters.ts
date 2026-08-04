#!/usr/bin/env node
/**
 * calibrate-counters.ts — measure the Tier 2 counters against hand-entered history.
 *
 * The counters do not propose anything until this has been run and its output
 * accepted. ~300 episodes carry a human count; that is the eval set.
 *
 * Usage:
 *   npm run calibrate-counters
 *   npm run calibrate-counters -- --field=MMM_Count
 *   npm run calibrate-counters -- --worst=20
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';
import { countMmm, countThatsGreat } from '../src/lib/tier2-counters';
import type { Transcript } from '../src/types/transcript';

const __filename = fileURLToPath(import.meta.url);

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

export interface CalibrationRow {
  episode: string;
  field: 'MMM_Count' | 'Thats_Great_Count' | string;
  expected: number;
  actual: number;
}

export interface CalibrationSummary {
  n: number;
  exact: number;
  meanAbsoluteError: number;
  meanSignedError: number;
  /** Share of rows within +/- 2 of the human count. */
  withinTwo: number;
}

export function summarise(rows: CalibrationRow[]): CalibrationSummary {
  if (rows.length === 0) {
    return { n: 0, exact: 0, meanAbsoluteError: 0, meanSignedError: 0, withinTwo: 0 };
  }
  let exact = 0;
  let absSum = 0;
  let signedSum = 0;
  let within = 0;
  for (const r of rows) {
    const d = r.actual - r.expected;
    if (d === 0) exact++;
    if (Math.abs(d) <= 2) within++;
    absSum += Math.abs(d);
    signedSum += d;
  }
  return {
    n: rows.length,
    exact,
    meanAbsoluteError: absSum / rows.length,
    meanSignedError: signedSum / rows.length,
    withinTwo: within / rows.length,
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const hit = args.find(a => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const only = getArg(args, '--field');
  const worstN = parseInt(getArg(args, '--worst') ?? '15', 10);

  const { loadEpisodeMetadata } = await import('../src/lib/metadata-store');
  const metadata = loadEpisodeMetadata();
  const transcriptsDir = path.resolve(__dirname, '..', 'transcripts');

  const rows: CalibrationRow[] = [];
  let missingTranscripts = 0;

  for (const ep of metadata) {
    const file = path.join(transcriptsDir, `episode_${ep.episode}.json`);
    if (!fs.existsSync(file)) {
      missingTranscripts++;
      continue;
    }
    let transcript: Transcript;
    try {
      transcript = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const dialogues = transcript.dialogues ?? [];

    if ((!only || only === 'MMM_Count') && ep.mmmCount > 0) {
      rows.push({
        episode: String(ep.episode),
        field: 'MMM_Count',
        expected: ep.mmmCount,
        actual: countMmm(dialogues).total,
      });
    }
    if ((!only || only === 'Thats_Great_Count') && ep.thatsGreatCount > 0) {
      rows.push({
        episode: String(ep.episode),
        field: 'Thats_Great_Count',
        expected: ep.thatsGreatCount,
        actual: countThatsGreat(dialogues).total,
      });
    }
  }

  console.log(`Transcripts missing on disk (skipped): ${missingTranscripts}`);
  console.log(`Rows with a human count: ${rows.length}\n`);

  for (const field of ['MMM_Count', 'Thats_Great_Count']) {
    const subset = rows.filter(r => r.field === field);
    if (subset.length === 0) continue;
    const s = summarise(subset);
    console.log(`--- ${field} ---`);
    console.log(`  episodes measured : ${s.n}`);
    console.log(`  exact matches     : ${s.exact} (${((s.exact / s.n) * 100).toFixed(1)}%)`);
    console.log(`  within +/-2       : ${(s.withinTwo * 100).toFixed(1)}%`);
    console.log(`  mean abs error    : ${s.meanAbsoluteError.toFixed(2)}`);
    console.log(`  mean signed error : ${s.meanSignedError.toFixed(2)} (negative = undercounting)`);

    const worst = [...subset]
      .sort((a, b) => Math.abs(b.actual - b.expected) - Math.abs(a.actual - a.expected))
      .slice(0, worstN);
    console.log(`  worst ${worst.length}:`);
    for (const r of worst) {
      console.log(`    ep ${r.episode.padStart(5)}  human ${String(r.expected).padStart(4)}  derived ${String(r.actual).padStart(4)}  diff ${r.actual - r.expected > 0 ? '+' : ''}${r.actual - r.expected}`);
    }
    console.log();
  }
}

if (process.argv[1] === __filename) {
  main().catch(err => {
    console.error('[calibrate-counters] Fatal error:', err);
    process.exit(1);
  });
}
