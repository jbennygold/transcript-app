/**
 * Batch sync of admin-reacted thread comments into Notable_Moments.
 *
 * The effects (sheet write, note store, clock, id generation) are injected so
 * the ordering invariant this module exists to protect — append to the sheet
 * BEFORE recording the note — can be asserted in a unit test. The route
 * handler in src/app/api/episode-notes/sync/route.ts is a thin shell that
 * supplies the real implementations.
 */
import {
  buildThreadNote,
  listSyncedMessageIds,
  normaliseNoteText,
  type EpisodeNote,
} from './episode-notes';
import type { PdcColumnKey } from './pdc-sheet';

export interface SyncComment {
  discordMessageId: string;
  text: string;
  submittedBy: string;
}

export interface SyncInput {
  episode: string;
  comments: SyncComment[];
}

export type SyncOutcome =
  | 'appended'
  | 'duplicate'
  | 'already_synced'
  | 'invalid_note'
  | 'no_sheet_row'
  | 'append_failed';

export interface SyncResult {
  discordMessageId: string;
  outcome: SyncOutcome;
}

export interface SyncSummary {
  considered: number;
  appended: number;
  duplicate: number;
  alreadySynced: number;
  failed: number;
}

export interface SyncDeps {
  listNotes: (status?: 'pending' | 'approved' | 'rejected' | 'all') => Promise<EpisodeNote[]>;
  appendToCell: (
    episode: string,
    column: PdcColumnKey,
    line: string
  ) => Promise<'appended' | 'duplicate' | 'no_row'>;
  saveNote: (note: EpisodeNote) => Promise<void>;
  now: () => string;
  newId: (index: number) => string;
}

/** A batch of thread comments is capped so one command cannot flood the sheet. */
const MAX_COMMENTS = 50;

export function validateSyncInput(
  input: unknown
): { ok: true; value: SyncInput } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'body must be an object' };
  }
  const o = input as Record<string, unknown>;

  const episode = String(o.episode ?? '').trim();
  if (episode === '') return { ok: false, reason: 'episode is required' };

  if (!Array.isArray(o.comments)) {
    return { ok: false, reason: 'comments must be an array' };
  }

  const comments: SyncComment[] = [];
  for (const raw of o.comments) {
    if (typeof raw !== 'object' || raw === null) continue;
    const c = raw as Record<string, unknown>;
    const discordMessageId = String(c.discordMessageId ?? '').trim();
    // No id means no idempotency key, so it could be appended twice on a
    // re-run. Drop it rather than risk a duplicate the sheet guard may miss.
    if (discordMessageId === '') continue;
    comments.push({
      discordMessageId,
      text: String(c.text ?? ''),
      submittedBy: String(c.submittedBy ?? '').trim() || 'unknown',
    });
  }

  if (comments.length === 0) {
    return { ok: false, reason: 'comments must contain at least one identified comment' };
  }
  if (comments.length > MAX_COMMENTS) {
    return { ok: false, reason: `at most ${MAX_COMMENTS} comments per sync` };
  }

  return { ok: true, value: { episode, comments } };
}

export async function syncComments(
  input: SyncInput,
  deps: SyncDeps
): Promise<{ results: SyncResult[]; summary: SyncSummary }> {
  // First idempotency layer: a comment already stored is skipped without any
  // sheet traffic. The second layer is appendBullet's duplicate detection,
  // which catches a comment edited to match text already in the cell.
  let synced: Set<string>;
  try {
    synced = listSyncedMessageIds(await deps.listNotes('all'));
  } catch (err) {
    // Without the stored ids we would re-append everything. Fail the batch
    // rather than risk duplicates; the command is retryable.
    console.error('[note-sync] could not list notes:', err);
    throw err;
  }

  const results: SyncResult[] = [];

  for (let i = 0; i < input.comments.length; i += 1) {
    const c = input.comments[i];

    if (synced.has(c.discordMessageId)) {
      results.push({ discordMessageId: c.discordMessageId, outcome: 'already_synced' });
      continue;
    }

    const normalised = normaliseNoteText(c.text);
    if (!normalised.ok) {
      console.warn(`[note-sync] skipping ${c.discordMessageId}: ${normalised.reason}`);
      results.push({ discordMessageId: c.discordMessageId, outcome: 'invalid_note' });
      continue;
    }

    try {
      const outcome = await deps.appendToCell(input.episode, 'Notable_Moments', normalised.value);
      if (outcome === 'no_row') {
        console.warn(`[note-sync] no sheet row for episode ${input.episode}`);
        results.push({ discordMessageId: c.discordMessageId, outcome: 'no_sheet_row' });
        continue; // nothing recorded — retryable once the row exists
      }

      // Recorded only after the sheet write succeeded. A 'duplicate' is still
      // recorded: the text is already in the cell, so re-attempting it every
      // sync would be pure noise.
      const at = deps.now();
      await deps.saveNote(
        buildThreadNote(
          {
            episode: input.episode,
            note: normalised.value,
            submittedBy: c.submittedBy,
            discordMessageId: c.discordMessageId,
          },
          deps.newId(i),
          at
        )
      );
      results.push({ discordMessageId: c.discordMessageId, outcome });
    } catch (err) {
      console.error(`[note-sync] append failed for ${c.discordMessageId}:`, err);
      results.push({ discordMessageId: c.discordMessageId, outcome: 'append_failed' });
    }
  }

  const summary: SyncSummary = {
    considered: results.length,
    appended: results.filter(r => r.outcome === 'appended').length,
    duplicate: results.filter(r => r.outcome === 'duplicate').length,
    alreadySynced: results.filter(r => r.outcome === 'already_synced').length,
    failed: results.filter(
      r => r.outcome === 'append_failed' || r.outcome === 'no_sheet_row' || r.outcome === 'invalid_note'
    ).length,
  };

  return { results, summary };
}
