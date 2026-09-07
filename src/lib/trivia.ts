import type { Transcript } from '@/types/transcript';

/** One trivia candidate as returned by the model: it cites the turn it drew from. */
export interface TriviaCandidate {
  fact: string;
  turn: number;
  quote: string;
}

/** A candidate whose quote was verified against the transcript. */
export interface VerifiedTrivia {
  fact: string;
  quote: string;
  speaker: string;
  timestamp: string;
}

/** Roughly 4 chars/token; keeps a long episode comfortably inside Haiku's window. */
export const DEFAULT_PROMPT_CHAR_BUDGET = 160_000;

/**
 * Render the transcript as numbered turns so the model can cite a turn index
 * instead of guessing timestamps. Truncates on a turn boundary.
 */
export function formatTranscriptForPrompt(
  transcript: Transcript,
  maxChars: number = DEFAULT_PROMPT_CHAR_BUDGET
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < transcript.dialogues.length; i++) {
    const d = transcript.dialogues[i];
    const line = `[${i}] ${d.name}: ${d.text.trim()}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    lines.push(line);
    used += cost;
  }
  return lines.join('\n');
}

/** Extract a JSON array of candidates from model output, tolerating fences and prose. */
export function parseTriviaCandidates(raw: string): TriviaCandidate[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: TriviaCandidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const { fact, turn, quote } = item as Record<string, unknown>;
    if (typeof fact !== 'string' || typeof quote !== 'string') continue;
    if (typeof turn !== 'number' || !Number.isInteger(turn)) continue;
    out.push({ fact, turn, quote });
  }
  return out;
}

/** Lowercase, drop punctuation (incl. curly quotes), collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A candidate is only trusted when its quote actually appears in the turn it
 * cites. Returns the resolved speaker/timestamp, or null when it fails.
 */
export function verifyCandidate(
  candidate: TriviaCandidate,
  transcript: Transcript
): VerifiedTrivia | null {
  const fact = candidate.fact.trim();
  const quote = normalize(candidate.quote);
  if (!fact || !quote) return null;

  const entry = transcript.dialogues[candidate.turn];
  if (!entry) return null;
  if (!normalize(entry.text).includes(quote)) return null;

  return {
    fact,
    quote: candidate.quote.trim(),
    speaker: entry.name,
    timestamp: entry.timestamp,
  };
}

/** Verify every candidate and pick one at random from those that survive. */
export function pickVerifiedTrivia(
  candidates: TriviaCandidate[],
  transcript: Transcript,
  random: () => number = Math.random
): VerifiedTrivia | null {
  const verified = candidates
    .map((c) => verifyCandidate(c, transcript))
    .filter((v): v is VerifiedTrivia => v !== null);
  if (verified.length === 0) return null;
  const idx = Math.min(verified.length - 1, Math.floor(random() * verified.length));
  return verified[idx];
}

/**
 * Pick a random film from the episode list. Only numbered episodes with a
 * non-empty film qualify; bonus episodes with ids like "49b1" are skipped
 * because the transcript path keys off a numeric episode number.
 */
export function pickRandomFilm(
  episodes: ReadonlyArray<{ episode: number | string; film: string }>,
  random: () => number = Math.random
): string | null {
  const eligible = episodes.filter(
    (e) => typeof e.episode === 'number' && e.film.trim().length > 0
  );
  if (eligible.length === 0) return null;
  const idx = Math.min(eligible.length - 1, Math.floor(random() * eligible.length));
  return eligible[idx].film;
}
