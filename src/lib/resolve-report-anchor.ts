import type { Transcript } from '@/types/transcript';
import type { TranscriptionReport } from './transcription-report';

export type AnchorResolution =
  | { status: 'match'; index: number }
  | { status: 'already_fixed' }
  | { status: 'not_found' }
  | { status: 'ambiguous'; indexes: number[] };

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function resolveReportAnchor(
  transcript: Transcript,
  report: Pick<TranscriptionReport, 'anchor' | 'correction'>,
): AnchorResolution {
  const { anchor, correction } = report;
  const dialogues = transcript.dialogues ?? [];
  const targetText = norm(anchor.originalText);
  const targetNewValue = norm(correction.newValue);

  const textMatches: number[] = [];
  for (let i = 0; i < dialogues.length; i++) {
    if (norm(dialogues[i].text) === targetText) textMatches.push(i);
  }

  if (textMatches.length === 1) return { status: 'match', index: textMatches[0] };

  if (textMatches.length > 1) {
    const byTs = textMatches.filter((i) => dialogues[i].timestamp === anchor.startTs);
    if (byTs.length === 1) return { status: 'match', index: byTs[0] };
    return { status: 'ambiguous', indexes: textMatches };
  }

  // Zero text matches — the turn may already carry the correction.
  const alreadyFixed = dialogues.some((d) => {
    if (correction.field === 'name') {
      return norm(d.name) === targetNewValue && d.timestamp === anchor.startTs;
    }
    return norm(d.text) === targetNewValue;
  });
  if (alreadyFixed) return { status: 'already_fixed' };

  return { status: 'not_found' };
}
