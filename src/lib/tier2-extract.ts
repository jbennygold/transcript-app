/**
 * Tier 2 LLM extraction: Kev's question and the Tilda picks.
 *
 * Prompt construction and response parsing are pure and unit-tested; the
 * Anthropic call is a thin wrapper around them. A model that returns garbage
 * must yield nulls, never an exception — a missing proposal is fine, a crashed
 * ingest step is not.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DialogueEntry, Transcript } from '@/types/transcript';

const MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_CHARS = 120_000;

/** Speaker labels the Kev voicemail segment appears under after speaker mapping. */
export const KEV_SPEAKER_NAMES = ['kev voicemail', 'kev'] as const;

/** Turns to keep after Kev stops speaking, so the hosts' answers are in context. */
const KEV_TRAILING_TURNS = 12;

export interface KevExtraction {
  question: string | null;
  evidence: string | null;
}

export interface TildaExtraction {
  tildaH: string | null;
  tildaJason: string | null;
  tildaGuest: string | null;
  tildaCorey: string | null;
}

// ── Pure helpers ──

function isKevSpeaker(name: string): boolean {
  return (KEV_SPEAKER_NAMES as readonly string[]).includes(String(name ?? '').trim().toLowerCase());
}

/**
 * The Kev voicemail segment: from Kev's first turn through the following
 * discussion. Matches on the SPEAKER label only — a host saying the word
 * "Kev" is not the segment.
 */
export function findKevSegment(dialogues: DialogueEntry[]): DialogueEntry[] {
  const first = dialogues.findIndex(t => isKevSpeaker(t.name));
  if (first === -1) return [];
  let last = first;
  for (let i = first; i < dialogues.length; i++) {
    if (isKevSpeaker(dialogues[i].name)) last = i;
  }
  return dialogues.slice(first, Math.min(dialogues.length, last + 1 + KEV_TRAILING_TURNS));
}

/** Render turns for a prompt, truncating at a turn boundary. */
export function renderTranscriptForPrompt(
  dialogues: DialogueEntry[],
  maxChars = DEFAULT_MAX_CHARS
): string {
  const lines: string[] = [];
  let used = 0;
  for (const t of dialogues) {
    const line = `[${t.timestamp}] ${t.name}: ${t.text}`;
    // Always include at least one turn, even if it alone exceeds maxChars —
    // truncation happens at turn boundaries, never mid-turn, and never
    // produces empty output.
    if (lines.length > 0 && used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cleanValue(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '' || t.toUpperCase() === 'N/A' || t.toLowerCase() === 'null') return null;
  return t;
}

export function parseKevResponse(raw: string): KevExtraction {
  const obj = extractJson(raw);
  if (!obj) return { question: null, evidence: null };
  return { question: cleanValue(obj.question), evidence: cleanValue(obj.evidence) };
}

export function parseTildaResponse(raw: string): TildaExtraction {
  const obj = extractJson(raw);
  if (!obj) return { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null };
  return {
    tildaH: cleanValue(obj.tildaH),
    tildaJason: cleanValue(obj.tildaJason),
    tildaGuest: cleanValue(obj.tildaGuest),
    tildaCorey: cleanValue(obj.tildaCorey),
  };
}

// ── Anthropic calls ──

async function ask(prompt: string): Promise<string> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = message.content[0];
  return block && block.type === 'text' ? block.text : '';
}

export async function extractKevQuestion(transcript: Transcript): Promise<KevExtraction> {
  const segment = findKevSegment(transcript.dialogues ?? []);
  if (segment.length === 0) return { question: null, evidence: null };

  const prompt = `"Kev" is a listener of the Escape Hatch podcast who leaves a voicemail with one quirky question for the hosts each week. Below is the portion of an episode transcript containing his voicemail and the hosts' reaction.

Extract the single question Kev asked. Return the question as he phrased it, lightly cleaned of transcription artefacts. Do not answer it, summarise the hosts' responses, or invent a question.

If Kev left a voicemail but did not actually ask a question, return null.

Respond with JSON only, no prose:
{"question": "<the question, or null>", "evidence": "<a short quote from Kev's voicemail, or null>"}

Transcript:
${renderTranscriptForPrompt(segment)}`;

  try {
    return parseKevResponse(await ask(prompt));
  } catch {
    return { question: null, evidence: null };
  }
}

export async function extractTildaPicks(transcript: Transcript): Promise<TildaExtraction> {
  const dialogues = transcript.dialogues ?? [];
  if (dialogues.length === 0) {
    return { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null };
  }

  const prompt = `The Escape Hatch podcast has a recurring bit: each participant names which role in the week's film Tilda Swinton should have played. The hosts are Haitch and Jason. Some episodes also have a guest, and some have a listener named Corey.

Read the transcript below and extract each participant's Tilda pick — the role or character they named, in their own words.

Rules:
- Only report a pick that was actually stated. If someone did not give one, return null for them.
- A guest or Corey is often absent. Null is the correct answer then, not a guess.
- Do not merge two people's picks or attribute a pick to the wrong speaker.

Respond with JSON only, no prose:
{"tildaH": "<Haitch's pick or null>", "tildaJason": "<Jason's pick or null>", "tildaGuest": "<the guest's pick or null>", "tildaCorey": "<Corey's pick or null>"}

Transcript:
${renderTranscriptForPrompt(dialogues)}`;

  try {
    return parseTildaResponse(await ask(prompt));
  } catch {
    return { tildaH: null, tildaJason: null, tildaGuest: null, tildaCorey: null };
  }
}
