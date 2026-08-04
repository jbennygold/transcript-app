/**
 * Deterministic counts for the two recurring-tic columns.
 *
 * These are not LLM calls — the rule is a regex, so it must be written down,
 * testable, and measurable against the ~300 hand-counted historical rows
 * before anyone trusts it. See scripts/calibrate-counters.ts.
 *
 * Known ambiguity, deliberately not resolved in code:
 *  - ASR renders the tic as "mm", "mmm", "mmmm", and sometimes "hmm". We count
 *    only bare m-runs, because "hmm" is a different vocalisation and "mm-hmm"
 *    is assent rather than the bit. If calibration shows we undercount, widen
 *    the pattern here and re-measure — do not special-case at the call site.
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
