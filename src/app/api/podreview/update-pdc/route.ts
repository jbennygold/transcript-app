import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import { upsertEpisodeRow, type PdcRow } from '@/lib/pdc-sheet';

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await request.json();

  const required = ['film', 'episode', 'pod', 'season', 'reviewer'];
  const missing = required.filter(f => !data[f] && data[f] !== 0);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(', ')}` },
      { status: 400 }
    );
  }

  const rowData: PdcRow = {
    Pod: data.pod || 'EH',
    Season: String(data.season ?? 0),
    Ep: String(data.episode),
    Film: data.film,
    Release_Date: data.releaseDate || '',
    Length: data.length || '',
    Length_minutes: data.lengthMinutes || '',
    Reviewer: data.reviewer || '',
    Guest: data.guest || '',
    MMM_Count: String(data.mmmCount ?? 0),
    Thats_Great_Count: String(data.thatsGreatCount ?? 0),
    Notable_Moments: data.notableMoments || '',
    H_Flex: data.hFlex || '',
    J_Flex: data.jFlex || '',
    Kevs_Question: data.kevsQuestion || '',
    TildaH: data.tildaH || '',
    TildaJason: data.tildaJason || '',
    TildaGuest: data.tildaGuest || '',
    TildaCorey: data.tildaCorey || '',
    Chuckle_Hut_Favorites: '',
    Show_Link: data.showLink || '',
    Artwork_Link: data.artworkLink || '',
    Letterboxd_Link: data.letterboxdLink || '',
    IMDB_Link: data.imdbLink || '',
  };

  try {
    const result = await upsertEpisodeRow(rowData, 'overwrite');

    if (result.action === 'no_change') {
      return NextResponse.json({
        ok: true,
        action: 'no_change',
        message: `Episode ${data.episode} — no fields changed.`,
      });
    }

    if (result.action === 'inserted') {
      return NextResponse.json({
        ok: true,
        action: 'inserted',
        message: `Inserted new row for episode ${data.episode}.`,
      });
    }

    const n = result.changedFields.length;
    return NextResponse.json({
      ok: true,
      action: 'updated',
      message: `Updated episode ${data.episode} (${n} field${n === 1 ? '' : 's'} changed: ${result.changedFields.join(', ')}).`,
    });
  } catch (err: unknown) {
    console.error('Google Sheets update error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message.startsWith('Google Sheets credentials') ? 500 : 500;
    return NextResponse.json({ error: `Sheet update failed: ${message}` }, { status });
  }
}
