import { NextRequest, NextResponse } from 'next/server';
import {
  loadTranscriptionReport,
  writeReport,
  type TranscriptionReport,
} from '@/lib/transcription-report';
import { applyReportToTranscript } from '@/lib/apply-report';
import { loadTranscript, saveTranscript } from '@/lib/blob-storage';
import { triggerRebuild } from '@/lib/trigger-rebuild';

interface ApplyItem {
  id: string;
  newValue?: string;
}

type ResultStatus =
  | 'applied'
  | 'stale'
  | 'dismissed'
  | 'not_found'
  | 'not_pending'
  | 'wrong_episode';

interface ReportResult {
  id: string;
  status: ResultStatus;
  reason?: string;
  index?: number;
}

/**
 * POST /api/transcription-reports/resolve-batch
 * Body: { episodeNumber: number, apply: {id, newValue?}[], dismiss: string[] }
 *
 * Episode-scoped, server-authoritative apply: loads the current transcript ONCE,
 * re-resolves each `apply` report against it (never trusting any client index),
 * mutates only fresh `match`es, saves ONCE, triggers ONE rebuild, and records each
 * report's terminal status. `dismiss` ids are marked dismissed with no transcript write.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const b = (body ?? {}) as {
    episodeNumber?: unknown;
    apply?: unknown;
    dismiss?: unknown;
  };
  const episodeNumber = b.episodeNumber;
  if (typeof episodeNumber !== 'number' || !Number.isInteger(episodeNumber) || episodeNumber <= 0) {
    return NextResponse.json({ error: 'episodeNumber must be a positive integer' }, { status: 400 });
  }
  const applyItems: ApplyItem[] = Array.isArray(b.apply)
    ? (b.apply as unknown[]).filter(
        (x): x is ApplyItem =>
          !!x && typeof x === 'object' && typeof (x as ApplyItem).id === 'string',
      )
    : [];
  const dismissIds: string[] = Array.isArray(b.dismiss)
    ? (b.dismiss as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  const results: ReportResult[] = [];

  // Dismiss path — no transcript involved.
  for (const id of dismissIds) {
    const report = await loadTranscriptionReport(id);
    if (!report) {
      results.push({ id, status: 'not_found' });
      continue;
    }
    if (report.status !== 'pending') {
      results.push({ id, status: 'not_pending', reason: report.status });
      continue;
    }
    const updated: TranscriptionReport = {
      ...report,
      status: 'dismissed',
      resolvedAt: new Date().toISOString(),
    };
    await writeReport(updated);
    results.push({ id, status: 'dismissed' });
  }

  // Apply path — one transcript load, mutate matches in memory, one save + rebuild.
  let rebuildTriggered = false;
  let rebuildError: string | undefined;

  if (applyItems.length > 0) {
    const transcript = await loadTranscript(episodeNumber);

    // Load reports and compute per-report outcomes against the freshly loaded transcript.
    const applied: { report: TranscriptionReport; index: number; value: string }[] = [];

    for (const item of applyItems) {
      const report = await loadTranscriptionReport(item.id);
      if (!report) {
        results.push({ id: item.id, status: 'not_found' });
        continue;
      }
      if (report.status !== 'pending') {
        results.push({ id: item.id, status: 'not_pending', reason: report.status });
        continue;
      }
      if (report.episodeNumber !== episodeNumber) {
        results.push({ id: item.id, status: 'wrong_episode' });
        continue;
      }
      if (!transcript) {
        // Transcript missing → cannot apply; mark stale.
        const updated: TranscriptionReport = {
          ...report,
          status: 'stale',
          resolvedAt: new Date().toISOString(),
        };
        await writeReport(updated);
        results.push({ id: item.id, status: 'stale', reason: 'transcript not found' });
        continue;
      }
      const outcome = applyReportToTranscript(transcript, report, item.newValue);
      if (outcome.status === 'stale') {
        const updated: TranscriptionReport = {
          ...report,
          status: 'stale',
          resolvedAt: new Date().toISOString(),
        };
        await writeReport(updated);
        results.push({ id: item.id, status: 'stale', reason: outcome.reason });
      } else {
        applied.push({
          report,
          index: outcome.index,
          value: item.newValue ?? report.correction.newValue,
        });
      }
    }

    // Persist the transcript ONCE, only if something matched. Mark reports applied
    // ONLY after the save succeeds (a save failure leaves them pending/retryable).
    if (transcript && applied.length > 0) {
      try {
        await saveTranscript(transcript);
      } catch (err) {
        console.error('resolve-batch: saveTranscript failed', err, { episodeNumber });
        return NextResponse.json(
          { error: 'Failed to save transcript; no reports were marked applied' },
          { status: 500 },
        );
      }

      const rebuild = await triggerRebuild(episodeNumber);
      rebuildTriggered = rebuild.ok;
      rebuildError = rebuild.ok ? undefined : rebuild.error;

      for (const a of applied) {
        const updated: TranscriptionReport = {
          ...a.report,
          correction: { ...a.report.correction, newValue: a.value },
          status: 'applied',
          resolvedAt: new Date().toISOString(),
          resolvedTurnIndex: a.index,
        };
        await writeReport(updated);
        results.push({ id: a.report.id, status: 'applied', index: a.index });
      }
    }
  }

  return NextResponse.json({ results, rebuildTriggered, rebuildError });
}
