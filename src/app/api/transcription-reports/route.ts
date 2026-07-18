import { NextRequest, NextResponse } from 'next/server';
import {
  validateReportInput,
  buildReport,
  newReportId,
  saveTranscriptionReport,
  listTranscriptionReports,
  type ReportStatus,
} from '@/lib/transcription-report';
import { getEpisodeByNumber } from '@/lib/metadata-store';
import { notifyNewReport } from '@/lib/discord-notify';

const STATUSES: (ReportStatus | 'all')[] = ['pending', 'applied', 'dismissed', 'stale', 'all'];

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = validateReportInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  if (!getEpisodeByNumber(parsed.value.episodeNumber)) {
    return NextResponse.json(
      { error: `Unknown episode ${parsed.value.episodeNumber}` },
      { status: 400 },
    );
  }

  const report = buildReport(parsed.value, {
    id: newReportId(Date.now(), Math.random().toString(36).slice(2, 11)),
    createdAt: new Date().toISOString(),
    source: 'internal',
  });

  try {
    await saveTranscriptionReport(report);
  } catch (err) {
    console.error('Failed to save internal transcription report:', err);
    return NextResponse.json({ error: 'Failed to store report' }, { status: 500 });
  }

  await notifyNewReport(report);
  return NextResponse.json({ id: report.id }, { status: 201 });
}

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
