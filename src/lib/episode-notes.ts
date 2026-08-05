/**
 * Engineers Notes store.
 *
 * Contributors submit notes with /pdc-note in #engineers; an admin approves
 * them in /review/submissions; approval appends a bullet to Notable_Moments.
 * Mirrors the lifecycle of src/lib/transcription-report.ts.
 */
import { put, list } from '@vercel/blob';
import { fetchBlobJson, MUTABLE_BLOB_CACHE_MAX_AGE } from './blob-storage';

const PREFIX = 'episode-notes/';
const OPEN_KEY = `${PREFIX}open.json`;

/** A note becomes one bullet, so it must fit on one line and in one cell. */
const MIN_NOTE_LENGTH = 5;
const MAX_NOTE_LENGTH = 1000;

export type NoteStatus = 'pending' | 'approved' | 'rejected';

/**
 * Where a note came from. 'command' is /pdc-note (admin-approved in
 * /review/submissions); 'thread' is a comment in the episode thread that an
 * admin reacted to and /pdc-sync-notes collected.
 */
export type NoteSource = 'command' | 'thread';

export interface EpisodeNote {
  id: string;
  episode: string;
  note: string;
  /** Discord tag of the submitter, so every note is attributable. */
  submittedBy: string;
  createdAt: string;
  status: NoteStatus;
  resolvedAt?: string;
  /**
   * Set for thread-sourced notes. This is the idempotency key: a comment whose
   * id is already stored is skipped without touching the sheet, so re-running
   * /pdc-sync-notes on the same thread is safe.
   */
  discordMessageId?: string;
  /** Absent on notes stored before this field existed; treat as 'command'. */
  source?: NoteSource;
}

export interface OpenEpisode {
  episode: string;
  film: string;
  openedAt: string;
  /**
   * The Discord thread comments are collected from. null when thread creation
   * failed or the pointer predates the thread redesign — /pdc-note still works,
   * only /pdc-sync-notes needs this.
   */
  threadId: string | null;
}

export function newNoteId(now: number, rand: string): string {
  return `note_${String(now).padStart(15, '0')}_${rand}`;
}

/**
 * Collapse newlines and enforce the length bounds a Notable_Moments bullet
 * must fit within. Shared by the submit-time validator (`validateNoteInput`)
 * and the admin-edit path in the resolve route, so an edited note is held to
 * the same shape as a freshly submitted one — no raw newlines can reach the
 * sheet either way.
 */
export function normaliseNoteText(
  raw: string
): { ok: true; value: string } | { ok: false; reason: string } {
  // One note is one bullet, so collapse any newlines the client sent
  // (including a lone \r, which \n-only patterns miss).
  const note = String(raw ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (note.length < MIN_NOTE_LENGTH) {
    return { ok: false, reason: `note must be at least ${MIN_NOTE_LENGTH} characters` };
  }
  if (note.length > MAX_NOTE_LENGTH) {
    return { ok: false, reason: `note must be at most ${MAX_NOTE_LENGTH} characters` };
  }
  return { ok: true, value: note };
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

  const normalised = normaliseNoteText(String(o.note ?? ''));
  if (!normalised.ok) return normalised;

  return { ok: true, value: { episode, note: normalised.value, submittedBy } };
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

/**
 * Guards a parsed Blob document before it is trusted as an OpenEpisode.
 *
 * `threadId` is deliberately optional here: pointers written before the thread
 * redesign have no such field, and rejecting them would break /pdc-note for
 * every already-open episode. Callers normalise a missing value to null.
 */
export function isOpenEpisode(value: unknown): value is OpenEpisode {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.episode !== 'string' ||
    typeof v.film !== 'string' ||
    typeof v.openedAt !== 'string'
  ) {
    return false;
  }
  return v.threadId === undefined || v.threadId === null || typeof v.threadId === 'string';
}

/**
 * A thread comment arrives already approved — the admin's reaction was the
 * approval, and the caller appends to the sheet before this note is stored.
 * There is no pending state for it to sit in.
 */
export function buildThreadNote(
  value: { episode: string; note: string; submittedBy: string; discordMessageId: string },
  id: string,
  createdAt: string
): EpisodeNote {
  return {
    id,
    episode: value.episode,
    note: value.note,
    submittedBy: value.submittedBy,
    discordMessageId: value.discordMessageId,
    createdAt,
    status: 'approved',
    resolvedAt: createdAt,
    source: 'thread',
  };
}

/** The set of Discord message ids already synced, for skip-without-sheet-write. */
export function listSyncedMessageIds(notes: EpisodeNote[]): Set<string> {
  const ids = new Set<string>();
  for (const n of notes) {
    if (typeof n.discordMessageId === 'string' && n.discordMessageId !== '') {
      ids.add(n.discordMessageId);
    }
  }
  return ids;
}

// ── Blob I/O ──

/**
 * Status transitions overwrite the note in place, so without a short TTL the
 * CDN can keep serving the pre-transition version — an approved note reading as
 * pending. Reads verify against `list()` metadata; see fetchBlobJson().
 */
export async function saveNote(note: EpisodeNote): Promise<void> {
  await put(`${PREFIX}${note.id}.json`, JSON.stringify(note, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
  });
}

export async function listNotes(status: NoteStatus | 'all' = 'all'): Promise<EpisodeNote[]> {
  const { blobs } = await list({ prefix: PREFIX });
  const notes: EpisodeNote[] = [];
  for (const blob of blobs) {
    if (!blob.pathname.endsWith('.json')) continue;
    if (blob.pathname === OPEN_KEY) continue;
    try {
      const result = await fetchBlobJson<unknown>(blob.url, blob.size, 'fast');
      if (result && isEpisodeNote(result.data)) notes.push(result.data);
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
    const result = await fetchBlobJson<unknown>(match.url, match.size, 'fast');
    if (!result) return null;
    return isEpisodeNote(result.data) ? result.data : null;
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
    cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
  });
}

export async function getOpenEpisode(): Promise<OpenEpisode | null> {
  const { blobs } = await list({ prefix: OPEN_KEY });
  const match = blobs.find(b => b.pathname === OPEN_KEY);
  if (!match) return null;
  try {
    const result = await fetchBlobJson<unknown>(match.url, match.size, 'fast');
    if (!result) return null;
    if (!isOpenEpisode(result.data)) {
      console.warn('[episode-notes] open.json failed the OpenEpisode guard — ignoring.');
      return null;
    }
    // Legacy pointers have no threadId; normalise so callers never see undefined.
    return { ...result.data, threadId: result.data.threadId ?? null };
  } catch (err) {
    console.warn(
      `[episode-notes] could not read open.json: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
