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

/**
 * Turn-count elimination ("the guest talks least") for identifying Jason
 * among the non-Haitch principals scored only 9/17 correct across paired
 * episodes with a guest — a coin flip, and its failure mode was a two-name
 * swap (Jason <-> guest) on the episode's two largest labels whenever the
 * guest out-talked Jason. Replaced with a positive signal: among the
 * non-Haitch principals, Jason is the one most often addressed by name by
 * someone else. Measured 17/17 correct with a minimum margin of 1.43x; this
 * constant is set below that observed minimum so it does not reject real
 * cases.
 */
export const JASON_ADDRESS_MARGIN = 1.25;

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

/**
 * Recurring voicemailers and the spellings they appear under. Keys are the
 * canonical names used by SEGMENT_CONFIGS in scripts/ingest.ts — segment
 * sub-chunking keys on these exact strings.
 *
 * This roster is deliberately incomplete. Across 19 episodes there is a long
 * tail of one-off callers (Griffin, ctcher, Rusty Surfer, Buddha LeDread,
 * Space monkey, Silly Oswald, Proto, Derek, Sam, Bijani). They come back null
 * and the human names them. An LLM fallback would not know them either.
 */
export const VOICEMAILER_ALIASES: Record<string, string[]> = {
  'Corey': ['corey'],
  'kev voicemail': ['kev'],
  'birria': ['birria', 'truthsayer'],
  'Mr Java': ['mr\\.? ?java'],
  'Lizzen': ['lizzen'],
  'Animal Mother': ['animal mother'],
  'Ethan': ['ethan'],
};

function countMatches(text: string, aliases: string[]): number {
  return aliases.reduce((sum, alias) => {
    const matches = text.match(new RegExp(`\\b${alias}\\b`, 'ig'));
    return sum + (matches ? matches.length : 0);
  }, 0);
}

/**
 * Name a caller from the roster.
 *
 * The window anchors on the caller's FIRST long turn, not the whole run.
 * Voicemails run back-to-back, so a full-run window bleeds into the next
 * caller's intro cue: that fix took mis-names from 5 to 2 with no loss of
 * correct names.
 *
 * Signals, in weight order:
 *   - self-ID in the caller's own words ("it's Kev here") — weight 3
 *   - self-ID in a short turn of theirs just before the body
 *     ("This is your brother, Animal Mother") — weight 3
 *   - the host's intro cue in the 3 turns before ("Lay it on us, Ethan") — weight 1
 *
 * REVERTED EXPERIMENT — do not re-attempt: proximity tie-breaking on chained
 * handoffs ("thanks Kev, here is Corey" -> prefer the name nearest the body)
 * took mis-names 2 -> 3 and gained zero correct names.
 */
export function nameCaller(dialogues: DialogueEntry[], run: number[]): string | null {
  if (run.length === 0) return null;

  const firstLong = run.find((i) => countWords(dialogues[i].text) >= LONG_TURN_WORDS) ?? run[0];
  const intro = dialogues.slice(Math.max(0, firstLong - 3), firstLong).map((d) => d.text).join(' ');
  const body = dialogues[firstLong].text;
  const ownPreamble = run
    .filter((i) => i < firstLong && i >= firstLong - 6)
    .map((i) => dialogues[i].text)
    .join(' ');

  const scores = Object.entries(VOICEMAILER_ALIASES)
    .map(([name, aliases]) => ({
      name,
      score:
        countMatches(body, aliases) * 3 +
        countMatches(ownPreamble, aliases) * 3 +
        countMatches(intro, aliases),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scores.length === 0) return null;
  // Refuse on a tie: a wrong name silently corrupts segment chunks.
  if (scores.length > 1 && scores[0].score === scores[1].score) return null;
  return scores[0].name;
}

const HOST_SELF_INTRO = /\bit'?s\s+haitch\b/i;
const COLD_OPEN_TURNS = 25;
const JASON_MENTION = /\bJason\b/i;

/**
 * How often label L is addressed by name as "Jason" by someone else.
 *
 * Scans every turn belonging to L; a turn counts (at most once) if either of
 * the 2 immediately preceding turns (a) belongs to a different label and (b)
 * mentions "Jason". This is a positive identification signal, not
 * elimination — it does not care how much L talks, only whether other
 * speakers address L as Jason.
 */
function jasonAddressScore(dialogues: DialogueEntry[], label: string): number {
  let score = 0;
  for (let i = 0; i < dialogues.length; i++) {
    if (dialogues[i].name !== label) continue;
    const addressed = [i - 1, i - 2].some(
      (j) => j >= 0 && dialogues[j].name !== label && JASON_MENTION.test(dialogues[j].text),
    );
    if (addressed) score++;
  }
  return score;
}

/**
 * Identify Jason among candidate (non-Haitch) principals by "addressed as
 * Jason" score. Requires a nonzero top score, and — when a runner-up exists —
 * requires the top score to lead it by at least JASON_ADDRESS_MARGIN. Either
 * failing means decline: do not fall through to elimination.
 */
function identifyJason(dialogues: DialogueEntry[], candidates: ClassifiedLabel[]): ClassifiedLabel | null {
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((c) => ({ candidate: c, score: jasonAddressScore(dialogues, c.label) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (top.score <= 0) return null;
  if (scored.length > 1 && top.score < JASON_ADDRESS_MARGIN * scored[1].score) return null;

  return top.candidate;
}

/**
 * Name the host/Jason/guest labels.
 *
 * Resolution order, each step positively identifying a label rather than
 * guessing from what's left:
 *   1. Haitch self-names in the cold open ("Hey everybody, it's Haitch, and
 *      welcome to...") — identifies his label directly.
 *   2. Jason is identified by identifyJason() (see above) among the
 *      non-Haitch principals — NOT by turn count. An earlier "guest talks
 *      least" elimination heuristic scored only 9/17 correct across paired
 *      episodes with a guest, with a two-name swap failure mode (Jason and
 *      the guest trade names) whenever the guest out-talked Jason. See
 *      JASON_ADDRESS_MARGIN's comment.
 *   3. The guest name arrives from sheet metadata via guestName and is bound
 *      only when exactly one principal remains after Haitch and Jason are
 *      resolved — two or more remaining (e.g. episodes with two guests) or
 *      none remaining means decline rather than guess which one.
 *
 * This is the weakest link in the chain and is exactly what the human confirms
 * in the cast panel. Labels that cannot be determined are omitted from the map
 * rather than guessed — mirroring nameCaller's tie refusal.
 *
 * Steps 2 and 3 only run once Haitch's self-intro has actually anchored a
 * principal label — without that anchor there is no positively-identified
 * starting point to reason from.
 */
export function namePrincipals(
  dialogues: DialogueEntry[],
  principals: ClassifiedLabel[],
  guestName?: string | null,
): Map<string, string> {
  const names = new Map<string, string>();
  if (principals.length === 0) return names;

  const coldOpen = dialogues.slice(0, COLD_OPEN_TURNS);
  const haitchLabel = coldOpen.find((d) => HOST_SELF_INTRO.test(d.text))?.name;
  const isPrincipal = (label: string) => principals.some((p) => p.label === label);
  const anchored = !!haitchLabel && isPrincipal(haitchLabel);

  if (anchored) names.set(haitchLabel!, 'Matt Haitch');

  // No anchor means no positively-identified starting point: return only
  // what was actually found (nothing) rather than guess.
  if (!anchored) return names;

  const nonHaitch = principals.filter((p) => p.label !== haitchLabel);
  const jason = identifyJason(dialogues, nonHaitch);
  if (jason) names.set(jason.label, 'Jason Goldman');

  const remaining = nonHaitch.filter((p) => !names.has(p.label));
  const trimmedGuest = guestName?.trim();
  if (trimmedGuest && remaining.length === 1) {
    names.set(remaining[0].label, trimmedGuest);
  }

  return names;
}
