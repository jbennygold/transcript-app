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
  // Untyped on purpose: this comes straight off the wire, so a caller can send
  // a number/object/empty string here even though the "happy path" type is
  // string. Validated at use (see invalid_new_value handling below).
  newValue?: unknown;
}

type ResultStatus =
  | 'applied'
  | 'stale'
  | 'dismissed'
  | 'not_found'
  | 'not_pending'
  | 'wrong_episode'
  | 'invalid_new_value';

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
  const applyItemsRaw: ApplyItem[] = Array.isArray(b.apply)
    ? (b.apply as unknown[]).filter(
        (x): x is ApplyItem =>
          !!x && typeof x === 'object' && typeof (x as ApplyItem).id === 'string',
      )
    : [];
  const dismissIdsRaw: string[] = Array.isArray(b.dismiss)
    ? (b.dismiss as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  // De-dupe ids so each is processed exactly once. Apply takes precedence over
  // dismiss: if an id shows up in both (or repeated within `apply`), it's
  // resolved via the apply path only, and later duplicates are dropped.
  const applyIds = new Set<string>();
  const applyItems: ApplyItem[] = [];
  for (const item of applyItemsRaw) {
    if (applyIds.has(item.id)) continue;
    applyIds.add(item.id);
    applyItems.push(item);
  }
  const dismissSeen = new Set<string>();
  const dismissIds: string[] = [];
  for (const id of dismissIdsRaw) {
    if (applyIds.has(id) || dismissSeen.has(id)) continue;
    dismissSeen.add(id);
    dismissIds.push(id);
  }

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
      // Validate the apply-time override before it ever touches the transcript.
      // Absent → fall through to the report's own (already-validated) correction.
      // Present but not a non-empty trimmed string → reject without mutating
      // anything and leave the report pending.
      let overrideNewValue: string | undefined;
      if (item.newValue !== undefined) {
        if (typeof item.newValue !== 'string' || item.newValue.trim().length === 0) {
          results.push({ id: item.id, status: 'invalid_new_value' });
          continue;
        }
        overrideNewValue = item.newValue.trim();
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
      const outcome = applyReportToTranscript(transcript, report, overrideNewValue);
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
          value: overrideNewValue ?? report.correction.newValue,
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
