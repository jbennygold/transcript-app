/**
 * Engineers Notes store.
 *
 * Contributors submit notes with /pdc-note in #engineers; an admin approves
 * them in /review/submissions; approval appends a bullet to Notable_Moments.
 * Mirrors the lifecycle of src/lib/transcription-report.ts.
 */
import { put, list } from '@vercel/blob';

const PREFIX = 'episode-notes/';
const OPEN_KEY = `${PREFIX}open.json`;

/** A note becomes one bullet, so it must fit on one line and in one cell. */
const MIN_NOTE_LENGTH = 5;
const MAX_NOTE_LENGTH = 1000;

export type NoteStatus = 'pending' | 'approved' | 'rejected';

export interface EpisodeNote {
  id: string;
  episode: string;
  note: string;
  /** Discord tag of the submitter, so every note is attributable. */
  submittedBy: string;
  createdAt: string;
  status: NoteStatus;
  resolvedAt?: string;
}

export interface OpenEpisode {
  episode: string;
  film: string;
  openedAt: string;
}

export function newNoteId(now: number, rand: string): string {
  return `note_${String(now).padStart(15, '0')}_${rand}`;
}

export function validateNoteInput(
  input: unknown
):
  | { ok: true; value: { episode: string; note: string; submittedBy: string } }
  | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'body must be an object' };
  }
  const o = input as Record<string, unknown>;

  const episode = String(o.episode ?? '').trim();
  if (episode === '') return { ok: false, reason: 'episode is required' };

  const submittedBy = String(o.submittedBy ?? '').trim();
  if (submittedBy === '') return { ok: false, reason: 'submittedBy is required' };

  // One note is one bullet, so collapse any newlines the client sent
  // (including a lone \r, which \n-only patterns miss).
  const note = String(o.note ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (note.length < MIN_NOTE_LENGTH) {
    return { ok: false, reason: `note must be at least ${MIN_NOTE_LENGTH} characters` };
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return { ok: false, reason: `note must be at most ${MAX_NOTE_LENGTH} characters` };
  }

  return { ok: true, value: { episode, note, submittedBy } };
}

/**
 * Guards a parsed Blob document before it is trusted as an EpisodeNote.
 *
 * A document that parses as valid JSON but lacks a required field (partial
 * write, schema change, `{}`) must not reach `.sort()` — `undefined
 * .localeCompare(...)` on a missing `createdAt` throws and rejects the whole
 * listing, not just the bad entry. Mirrors `isEpisodeProposals` in
 * ./pdc-proposals.ts.
 */
export function isEpisodeNote(value: unknown): value is EpisodeNote {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.episode === 'string' &&
    typeof v.note === 'string' &&
    typeof v.submittedBy === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.status === 'string'
  );
}

export function buildNote(
  value: { episode: string; note: string; submittedBy: string },
  id: string,
  createdAt: string
): EpisodeNote {
  return { id, ...value, createdAt, status: 'pending' };
}

// ── Blob I/O ──

export async function saveNote(note: EpisodeNote): Promise<void> {
  await put(`${PREFIX}${note.id}.json`, JSON.stringify(note, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function listNotes(status: NoteStatus | 'all' = 'all'): Promise<EpisodeNote[]> {
  const { blobs } = await list({ prefix: PREFIX });
  const notes: EpisodeNote[] = [];
  for (const blob of blobs) {
    if (!blob.pathname.endsWith('.json')) continue;
    if (blob.pathname === OPEN_KEY) continue;
    try {
      const resp = await fetch(blob.url, { cache: 'no-store' });
      if (resp.ok) {
        const parsed: unknown = await resp.json();
        if (isEpisodeNote(parsed)) notes.push(parsed);
      }
    } catch {
      // skip corrupt entries
    }
  }
  const filtered = status === 'all' ? notes : notes.filter(n => n.status === status);
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadNote(id: string): Promise<EpisodeNote | null> {
  const key = `${PREFIX}${id}.json`;
  const { blobs } = await list({ prefix: key });
  const match = blobs.find(b => b.pathname === key);
  if (!match) return null;
  try {
    const resp = await fetch(match.url, { cache: 'no-store' });
    if (!resp.ok) return null;
    const parsed: unknown = await resp.json();
    return isEpisodeNote(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** One episode is open for notes at a time; a new one replaces the previous. */
export async function setOpenEpisode(open: OpenEpisode): Promise<void> {
  await put(OPEN_KEY, JSON.stringify(open, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function getOpenEpisode(): Promise<OpenEpisode | null> {
  const { blobs } = await list({ prefix: OPEN_KEY });
  const match = blobs.find(b => b.pathname === OPEN_KEY);
  if (!match) return null;
  try {
    const resp = await fetch(match.url, { cache: 'no-store' });
    if (!resp.ok) return null;
    return (await resp.json()) as OpenEpisode;
  } catch {
    return null;
  }
}
