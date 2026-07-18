import { NextRequest, NextResponse } from 'next/server';
import {
  loadTranscriptionReport,
  writeReport,
  type TranscriptionReport,
} from '@/lib/transcription-report';
import { resolveReportAnchor } from '@/lib/resolve-report-anchor';
import { loadTranscript, saveTranscript } from '@/lib/blob-storage';
import { triggerRebuild } from '@/lib/trigger-rebuild';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let action: unknown;
  try {
    action = (await request.json())?.action;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (action !== 'apply' && action !== 'dismiss') {
    return NextResponse.json({ error: "action must be 'apply' or 'dismiss'" }, { status: 400 });
  }

  const report = await loadTranscriptionReport(id);
  if (!report) {
    return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  }
  if (report.status !== 'pending') {
    return NextResponse.json(
      { error: `Report already ${report.status}` },
      { status: 409 },
    );
  }

  if (action === 'dismiss') {
    const updated: TranscriptionReport = {
      ...report,
      status: 'dismissed',
      resolvedAt: new Date().toISOString(),
    };
    await writeReport(updated);
    return NextResponse.json({ status: 'dismissed', report: updated });
  }

  // action === 'apply' — re-resolve against the CURRENT transcript, authoritatively.
  const transcript = await loadTranscript(report.episodeNumber);
  if (!transcript) {
    const updated: TranscriptionReport = {
      ...report,
      status: 'stale',
      resolvedAt: new Date().toISOString(),
    };
    await writeReport(updated);
    return NextResponse.json(
      { status: 'stale', reason: 'transcript not found', report: updated },
    );
  }

  const resolution = resolveReportAnchor(transcript, report);
  if (resolution.status !== 'match') {
    const updated: TranscriptionReport = {
      ...report,
      status: 'stale',
      resolvedAt: new Date().toISOString(),
    };
    await writeReport(updated);
    return NextResponse.json({ status: 'stale', reason: resolution.status, report: updated });
  }

  // Apply the whole-field replacement to the resolved turn.
  transcript.dialogues[resolution.index][report.correction.field] = report.correction.newValue;
  await saveTranscript(transcript);

  const rebuild = await triggerRebuild(report.episodeNumber);

  const updated: TranscriptionReport = {
    ...report,
    status: 'applied',
    resolvedAt: new Date().toISOString(),
    resolvedTurnIndex: resolution.index,
  };
  await writeReport(updated);

  return NextResponse.json({
    status: 'applied',
    turnIndex: resolution.index,
    rebuildTriggered: rebuild.ok,
    rebuildError: rebuild.ok ? undefined : rebuild.error,
    report: updated,
  });
}
