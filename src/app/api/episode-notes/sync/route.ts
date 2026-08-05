import { NextRequest, NextResponse } from 'next/server';
import { validateExternalKey } from '@/lib/external-auth';
import { checkRateLimit } from '@/lib/external-rate-limit';
import { listNotes, saveNote, newNoteId } from '@/lib/episode-notes';
import { appendToCell } from '@/lib/pdc-sheet';
import { validateSyncInput, syncComments } from '@/lib/note-sync';

/**
 * Batch-append admin-reacted thread comments to Notable_Moments.
 *
 * Called by the Discord bot's /pdc-sync-notes, so it uses the same x-eh-key
 * auth as the other external endpoints. All the interesting logic — including
 * the append-before-record ordering — lives in src/lib/note-sync.ts, which is
 * unit-tested; this handler only supplies the real effects.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const validated = validateSyncInput(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 400 });
  }

  const stamp = Date.now();
  try {
    const { results, summary } = await syncComments(validated.value, {
      listNotes,
      appendToCell,
      saveNote,
      now: () => new Date().toISOString(),
      newId: (i: number) => newNoteId(stamp + i, Math.random().toString(36).slice(2, 10)),
    });
    return NextResponse.json({ ok: true, results, summary });
  } catch (err) {
    console.error('[episode-notes/sync] batch failed:', err);
    return NextResponse.json({ error: 'Sync failed — nothing was appended.' }, { status: 500 });
  }
}
