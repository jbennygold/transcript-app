import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import { fetchSpotifyMatch, fetchPatreonMatch } from '@/lib/episode-sources';

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get('q');
  if (!query || query.trim().length < 2) {
    return NextResponse.json({ error: 'Query too short' }, { status: 400 });
  }

  const [spotify, patreon] = await Promise.all([
    fetchSpotifyMatch(query),
    fetchPatreonMatch(query),
  ]);

  return NextResponse.json({ spotify, patreon });
}
