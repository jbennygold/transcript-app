import type { DialogueEntry } from '@/types/transcript';
import { timestampToSeconds } from '@/lib/timestamps';

/**
 * Thresholds validated against 19 paired episodes (299-317): raw diarization
 * labels vs the human's final mapping, index-aligned. See
 * docs/superpowers/specs/2026-08-05-speaker-mapping-design.md
 *
 * Measured outcomes at these values:
 *   - label classification: exact on 19/19 episodes; no principal label was
 *     ever actually a voicemailer or a category
 *   - caller naming: 59/72 correct, 11 declined, 2 mis-named
 *   - contamination: 53.5% of a caller label's turns on average
 *
 * PRINCIPAL_LONG_SHARE is a SHARE, not an absolute turn count: episodes range
 * 399-1384 turns and absolute thresholds do not survive that range.
 *
 * Do NOT "fix" contamination by narrowing the diarization speaker range in
 * src/lib/transcription-config.ts. That was tried, shipped, and reverted in
 * 7fd3350 — capping at 5 collapsed all five callers into hosts (0/5 distinct)
 * while looking clean by turn-count metrics.
 */
export const LONG_TURN_WORDS = 40;
export const RUN_GAP_SECONDS = 240;
export const PRINCIPAL_LONG_SHARE = 0.10;
export const CALLER_MAX_LONG = 3;
export const RUN_MARGIN_SECONDS = 30;
export const MAX_PLAUSIBLE_CALLERS = 8;
export const CALLER_TURN_WARNING = 60;

export type LabelKind = 'principal' | 'caller' | 'fragment';

export interface ClassifiedLabel {
  label: string;
  kind: LabelKind;
  indices: number[];
  turnCount: number;
  longTurnCount: number;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function isLong(d: DialogueEntry): boolean {
  return countWords(d.text) >= LONG_TURN_WORDS;
}

/**
 * Split raw diarization labels into hosts/guests, voicemail callers, and the
 * leftover short-turn cluster.
 *
 * Note the fragment cluster is NOT where movie samples live. Samples are
 * scattered across principal and caller labels alike (present in 19/19
 * episodes); classification cannot separate them. That is /api/detect-samples'
 * job.
 */
export function classifyLabels(dialogues: DialogueEntry[]): ClassifiedLabel[] {
  const byLabel = new Map<string, number[]>();
  dialogues.forEach((d, i) => {
    const list = byLabel.get(d.name);
    if (list) list.push(i);
    else byLabel.set(d.name, [i]);
  });

  const totalLong = dialogues.filter(isLong).length;

  const out: ClassifiedLabel[] = [];
  for (const [label, indices] of byLabel) {
    const longTurnCount = indices.filter((i) => isLong(dialogues[i])).length;
    const longShare = totalLong > 0 ? longTurnCount / totalLong : 0;

    let kind: LabelKind;
    if (longShare >= PRINCIPAL_LONG_SHARE) kind = 'principal';
    else if (longTurnCount >= 1 && longTurnCount <= CALLER_MAX_LONG) kind = 'caller';
    else kind = 'fragment';

    out.push({ label, kind, indices, turnCount: indices.length, longTurnCount });
  }

  return out.sort((a, b) => b.longTurnCount - a.longTurnCount);
}
