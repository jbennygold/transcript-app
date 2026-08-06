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

/** Group indices into runs separated by more than RUN_GAP_SECONDS of silence. */
function groupByTimeGap(dialogues: DialogueEntry[], indices: number[]): number[][] {
  const groups: number[][] = [];
  let current: number[] | null = null;
  let lastSeconds = Number.NEGATIVE_INFINITY;

  for (const i of indices) {
    const seconds = timestampToSeconds(dialogues[i].timestamp);
    if (current && seconds - lastSeconds < RUN_GAP_SECONDS) {
      current.push(i);
    } else {
      current = [i];
      groups.push(current);
    }
    lastSeconds = seconds;
  }
  return groups;
}

/**
 * Isolate a caller's genuine voicemail from the backchannel contaminating its
 * label. Seeds on the label's LONG turns only — seeding on all turns lets the
 * scattered one-word tail drag the run across the whole episode.
 *
 * A caller may have more than one long turn separated by more than
 * RUN_GAP_SECONDS (up to CALLER_MAX_LONG of them) — e.g. the voicemail
 * resumes after a long pause, or the label picks up an unrelated call later
 * in the episode. Every long turn is by definition genuine speech (40+
 * words is not backchannel), so none may ever be excluded: the window is
 * the UNION of a margin around each long-turn group, not just the single
 * heaviest one. Short turns are admitted only when they fall within
 * RUN_MARGIN_SECONDS of some long-turn group — contamination far from every
 * long turn stays excluded.
 *
 * Returns the turns to keep. Everything else on the label is contamination.
 */
export function isolateCallerRun(dialogues: DialogueEntry[], indices: number[]): number[] {
  const longIndices = indices.filter((i) => countWords(dialogues[i].text) >= LONG_TURN_WORDS);
  if (longIndices.length === 0) return [];

  const groups = groupByTimeGap(dialogues, longIndices);
  const windows = groups.map((group) => ({
    start: timestampToSeconds(dialogues[group[0]].timestamp) - RUN_MARGIN_SECONDS,
    end: timestampToSeconds(dialogues[group[group.length - 1]].timestamp) + RUN_MARGIN_SECONDS,
  }));

  return indices.filter((i) => {
    const seconds = timestampToSeconds(dialogues[i].timestamp);
    return windows.some((w) => seconds >= w.start && seconds <= w.end);
  });
}
