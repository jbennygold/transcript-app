import { NextRequest, NextResponse } from 'next/server';
import { validateExternalKey } from '@/lib/external-auth';
import { getOpenEpisode } from '@/lib/episode-notes';

/**
 * Read the currently open episode, including the thread its comments live in.
 *
 * The bot calls this to resolve threadId for /pdc-sync-notes when the command
 * is run outside the thread. x-eh-key authed like the other bot-facing routes.
 */
export async function GET(request: NextRequest) {
  const auth = validateExternalKey(request.headers.get('x-eh-key'));
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.reason === 'missing' ? 'Missing x-eh-key header' : 'Invalid key' },
      { status: 401 }
    );
  }

  try {
    const open = await getOpenEpisode();
    return NextResponse.json({ open });
  } catch (err) {
    console.error('[episode-notes/open] read failed:', err);
    return NextResponse.json({ error: 'Failed to read the open episode' }, { status: 500 });
  }
}
