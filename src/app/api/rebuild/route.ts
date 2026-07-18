import { NextRequest, NextResponse } from 'next/server';
import { triggerRebuild } from '@/lib/trigger-rebuild';

/**
 * POST /api/rebuild
 * Trigger the ingest-episode GitHub Actions workflow for a specific episode.
 * Body: { episode: number }
 */
export async function POST(request: NextRequest) {
  let episode: string;
  try {
    const body = await request.json();
    episode = String(body.episode);
    if (!episode || episode === 'undefined') {
      return NextResponse.json(
        { error: 'Missing episode number in request body' },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body — expected { episode: number }' },
      { status: 400 },
    );
  }

  const result = await triggerRebuild(episode);
  if (!result.ok) {
    const status = result.error === 'GITHUB_PAT not configured' ? 500 : (result.status ?? 500);
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ success: true, episode });
}

/**
 * GET /api/rebuild
 * Check if rebuild is configured
 */
export async function GET() {
  const isConfigured = !!process.env.GITHUB_PAT;

  return NextResponse.json({
    configured: isConfigured,
    message: isConfigured
      ? 'Ingest workflow trigger is configured'
      : 'GITHUB_PAT not set',
  });
}
