import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import { loadNote, saveNote, normaliseNoteText, type NoteStatus } from '@/lib/episode-notes';
import { appendToCell } from '@/lib/pdc-sheet';

interface Decision {
  id: string;
  status: NoteStatus;
  /** Optional edited text — an admin may fix a note before approving it. */
  note?: string;
}

/**
 * Approve or reject notes in batch.
 *
 * Approving appends the note to Notable_Moments and only then marks it
 * approved, so a failed sheet write leaves the note pending and retryable
 * rather than silently lost.
 */
export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const decisions = (body as Record<string, unknown> | null)?.decisions;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return NextResponse.json({ error: 'decisions must be a non-empty array' }, { status: 400 });
  }

  const results: Array<{ id: string; outcome: string }> = [];

  for (const d of decisions as Decision[]) {
    if (!d?.id || (d.status !== 'approved' && d.status !== 'rejected')) {
      results.push({ id: String(d?.id ?? ''), outcome: 'invalid_decision' });
      continue;
    }

    const note = await loadNote(d.id);
    if (!note) {
      results.push({ id: d.id, outcome: 'not_found' });
      continue;
    }
    if (note.status !== 'pending') {
      results.push({ id: d.id, outcome: `already_${note.status}` });
      continue;
    }

    if (d.status === 'rejected') {
      await saveNote({ ...note, status: 'rejected', resolvedAt: new Date().toISOString() });
      results.push({ id: d.id, outcome: 'rejected' });
      continue;
    }

    // An admin-edited note comes from a <textarea>, so it can carry raw
    // newlines and arbitrary length. Hold it to the same shape the submit
    // path enforces before it ever reaches the sheet. An unedited note was
    // already normalised at submit time, so it's used as-is.
    let text = note.note;
    if (typeof d.note === 'string' && d.note.trim() !== '') {
      const normalised = normaliseNoteText(d.note);
      if (!normalised.ok) {
        results.push({ id: d.id, outcome: 'invalid_note' });
        continue; // stays pending
      }
      text = normalised.value;
    }

    try {
      const outcome = await appendToCell(note.episode, 'Notable_Moments', text);
      if (outcome === 'no_row') {
        results.push({ id: d.id, outcome: 'no_sheet_row' });
        continue; // stays pending
      }
      await saveNote({
        ...note,
        note: text,
        status: 'approved',
        resolvedAt: new Date().toISOString(),
      });
      results.push({ id: d.id, outcome });
    } catch (err) {
      console.error('Notable_Moments append failed:', err);
      results.push({ id: d.id, outcome: 'append_failed' }); // stays pending
    }
  }

  return NextResponse.json({ ok: true, results });
}
