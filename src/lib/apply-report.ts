import type { Transcript } from '@/types/transcript';
import type { TranscriptionReport } from './transcription-report';
import { resolveReportAnchor } from './resolve-report-anchor';

export type ApplyOutcome =
  | { status: 'applied'; index: number }
  | { status: 'stale'; reason: 'already_fixed' | 'not_found' | 'ambiguous' };

/**
 * Server-authoritative single-report apply against an in-memory transcript.
 * Re-resolves the report's anchor against the CURRENT transcript and, ONLY on a
 * fresh `match`, mutates the resolved turn's field in place. On any non-`match`
 * resolution it mutates nothing and returns a stale outcome carrying the reason.
 *
 * The caller owns persistence: mutate a batch in memory, then saveTranscript ONCE.
 */
export function applyReportToTranscript(
  transcript: Transcript,
  report: TranscriptionReport,
  overrideNewValue?: string,
): ApplyOutcome {
  const resolution = resolveReportAnchor(transcript, report);
  if (resolution.status !== 'match') {
    return { status: 'stale', reason: resolution.status };
  }
  const value = overrideNewValue ?? report.correction.newValue;
  transcript.dialogues[resolution.index][report.correction.field] = value;
  return { status: 'applied', index: resolution.index };
}
