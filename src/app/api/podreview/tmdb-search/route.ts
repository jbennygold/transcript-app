import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import { searchTmdb, fetchTmdbDetails } from '@/lib/episode-sources';

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get('q');
  if (!query || query.trim().length < 2) {
    return NextResponse.json({ results: [] });
  }

  if (!process.env.TMDB_API_KEY) {
    return NextResponse.json({ error: 'TMDB_API_KEY not configured' }, { status: 500 });
  }

  const results = await searchTmdb(query);
  if (results === null) {
    return NextResponse.json({ error: 'TMDB search failed' }, { status: 502 });
  }
  return NextResponse.json({ results });
}

// Fetch details for a selected movie (IMDB ID, Letterboxd slug).
export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { tmdbId } = await request.json();
  if (!tmdbId) {
    return NextResponse.json({ error: 'tmdbId required' }, { status: 400 });
  }

  if (!process.env.TMDB_API_KEY) {
    return NextResponse.json({ error: 'TMDB_API_KEY not configured' }, { status: 500 });
  }

  const details = await fetchTmdbDetails(Number(tmdbId));
  if (!details) {
    return NextResponse.json({ error: 'TMDB fetch failed' }, { status: 502 });
  }

  return NextResponse.json(details);
}
