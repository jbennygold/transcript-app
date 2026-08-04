/**
 * Deterministic counts for the two recurring-tic columns.
 *
 * These are not LLM calls — the rule is a regex, so it must be written down,
 * testable, and measurable against the ~300 hand-counted historical rows
 * before anyone trusts it. See scripts/calibrate-counters.ts.
 *
 * Known ambiguity, deliberately not resolved in code:
 *  - MMM_Count was MEASURED AND DROPPED from Tier 2's proposable columns.
 *    Calibration over 312 episodes: 0.0% exact, mean absolute error and mean
 *    signed error both 31.9 — identical magnitudes, so it undercounts on every
 *    single episode. Ep 141: hand count 101, transcript contains 3 bare m-runs.
 *    Only 23 of 327 transcripts contain any m-run. The ASR does not render this
 *    non-lexical vocalization as text, so no regex over a transcript can count
 *    it — widening the pattern to include "hmm" yields 8 against 101. countMmm
 *    is retained ONLY so scripts/calibrate-counters.ts can re-measure if the
 *    transcription setup changes. Do not wire it into proposals.
 *  - "that's great" has a literal sense as well as the catchphrase sense. We
 *    count both; calibration reveals the bias.
 */
import type { DialogueEntry } from '@/types/transcript';

/** Bare runs of two or more m's, as a whole word. Excludes hmm and mm-hmm. */
export const MMM_PATTERN = /(?<![a-z-])m{2,}(?![a-z-])/gi;

/** "that's great" / "thats great" / curly apostrophe, any inter-word spacing. */
export const THATS_GREAT_PATTERN = /\bthat[’']?s\s+great\b/gi;

export interface CountResult {
  total: number;
  bySpeaker: Record<string, number>;
}

function countWith(dialogues: DialogueEntry[], pattern: RegExp): CountResult {
  const bySpeaker: Record<string, number> = {};
  let total = 0;

  for (const turn of dialogues) {
    // Fresh lastIndex per turn: the pattern is global and stateful.
    const matches = String(turn.text ?? '').match(new RegExp(pattern.source, pattern.flags));
    const n = matches ? matches.length : 0;
    if (n === 0) continue;
    total += n;
    bySpeaker[turn.name] = (bySpeaker[turn.name] ?? 0) + n;
  }

  return { total, bySpeaker };
}

export function countMmm(dialogues: DialogueEntry[]): CountResult {
  return countWith(dialogues, MMM_PATTERN);
}

export function countThatsGreat(dialogues: DialogueEntry[]): CountResult {
  return countWith(dialogues, THATS_GREAT_PATTERN);
}
