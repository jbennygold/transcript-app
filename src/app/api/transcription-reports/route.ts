import { NextRequest, NextResponse } from 'next/server';
import {
  listTranscriptionReports,
  type ReportStatus,
} from '@/lib/transcription-report';

const STATUSES: (ReportStatus | 'all')[] = ['pending', 'applied', 'dismissed', 'stale', 'all'];

/**
 * GET /api/transcription-reports?status=pending|applied|dismissed|stale|all&episode=N
 * Lists transcription-error reports for the /review/submissions page.
 * Reports are filed by the external ingest endpoint
 * (POST /api/external/transcription-error); there is no internal file path here.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const statusParam = (searchParams.get('status') ?? 'pending') as ReportStatus | 'all';
  const status = STATUSES.includes(statusParam) ? statusParam : 'pending';
  const episodeParam = searchParams.get('episode');

  try {
    let reports = await listTranscriptionReports(status);
    if (episodeParam) {
      const epNum = parseInt(episodeParam, 10);
      reports = reports.filter((r) => r.episodeNumber === epNum);
    }
    return NextResponse.json({ total: reports.length, reports });
  } catch (err) {
    console.error('Failed to list transcription reports:', err);
    return NextResponse.json({ error: 'Failed to list reports' }, { status: 500 });
  }
}
