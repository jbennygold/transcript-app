import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import { upsertEpisodeRow, hasSheetCredentials, PdcSheetValidationError, type PdcRow } from '@/lib/pdc-sheet';

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!hasSheetCredentials()) {
    const hasJson = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
    const hasFile = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
    return NextResponse.json(
      { error: `Google Sheets credentials not configured (JSON: ${hasJson}, FILE: ${hasFile})` },
      { status: 500 }
    );
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
    if (err instanceof PdcSheetValidationError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `Sheet update failed: ${message}` }, { status: 500 });
  }
}
