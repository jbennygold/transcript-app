import { NextRequest, NextResponse } from 'next/server';
import { validateExternalKey } from '@/lib/external-auth';
import { checkRateLimit } from '@/lib/external-rate-limit';
import { checkAuth } from '@/lib/podreview-auth';
import {
  validateNoteInput,
  buildNote,
  newNoteId,
  saveNote,
  listNotes,
  getOpenEpisode,
  type NoteStatus,
} from '@/lib/episode-notes';

const STATUSES: Array<NoteStatus | 'all'> = ['pending', 'approved', 'rejected', 'all'];

/**
 * Submit a note. Called by the Discord bot's /pdc-note command, so it uses the
 * same x-eh-key auth as the other external endpoints.
 *
 * `episode` is optional: when omitted the note attaches to the currently open
 * episode, which is what makes /pdc-note a one-argument command.
 */
export async function POST(request: NextRequest) {
  const auth = validateExternalKey(request.headers.get('x-eh-key'));
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.reason === 'missing' ? 'Missing x-eh-key header' : 'Invalid key' },
      { status: 401 }
    );
  }

  const rl = checkRateLimit(auth.keyId);
  if (!rl.allowed) {
    const headers: Record<string, string> = {};
    if (rl.retryAfterSec) headers['Retry-After'] = String(rl.retryAfterSec);
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429, headers });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  let episode = String(body.episode ?? '').trim();
  if (episode === '') {
    const open = await getOpenEpisode();
    if (!open) {
      return NextResponse.json(
        { error: 'No episode is open for notes — pass ep explicitly.' },
        { status: 400 }
      );
    }
    episode = open.episode;
  }

  const validated = validateNoteInput({ ...body, episode });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 400 });
  }

  const id = newNoteId(Date.now(), Math.random().toString(36).slice(2, 10));
  const note = buildNote(validated.value, id, new Date().toISOString());
  await saveNote(note);

  return NextResponse.json({ ok: true, id, episode }, { status: 201 });
}

/** List notes for the review UI. Bearer-authed, same as the other review APIs. */
export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('status') ?? 'pending';
  const status = (STATUSES as string[]).includes(raw) ? (raw as NoteStatus | 'all') : 'pending';

  try {
    return NextResponse.json({ notes: await listNotes(status) });
  } catch {
    return NextResponse.json({ error: 'Failed to list notes' }, { status: 500 });
  }
}
