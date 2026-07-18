import { put, list } from '@vercel/blob';

export type ReportStatus = 'pending' | 'applied' | 'dismissed' | 'stale';
export type CorrectionType = 'sample' | 'spelling' | 'speaker' | 'voicemailer';
export type CorrectionField = 'name' | 'text';

export interface ReportAnchor {
  startTs: string;
  endTs?: string;
  speaker: string;
  originalText: string;
}

export interface ReportCorrection {
  type: CorrectionType;
  field: CorrectionField;
  newValue: string;
}

export interface ReportInput {
  episodeNumber: number;
  anchor: ReportAnchor;
  correction: ReportCorrection;
  note?: string;
  reporterName?: string;
}

export interface TranscriptionReport extends ReportInput {
  id: string;
  createdAt: string;
  source: string; // keyId ('explore') or 'internal'
  status: ReportStatus;
  resolvedAt?: string;
  resolvedTurnIndex?: number;
}

const PREFIX = 'transcription-reports/';
const TYPES: CorrectionType[] = ['sample', 'spelling', 'speaker', 'voicemailer'];
const FIELDS: CorrectionField[] = ['name', 'text'];

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateReportInput(
  body: unknown,
): { ok: true; value: ReportInput } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Body must be an object' };
  }
  const b = body as Record<string, unknown>;

  const episode = b.episode;
  if (typeof episode !== 'number' || !Number.isInteger(episode) || episode <= 0) {
    return { ok: false, error: 'episode must be a positive integer' };
  }

  const anchor = b.anchor as Record<string, unknown> | undefined;
  if (!anchor || typeof anchor !== 'object') {
    return { ok: false, error: 'anchor is required' };
  }
  if (!nonEmptyString(anchor.startTs)) {
    return { ok: false, error: 'anchor.startTs is required' };
  }
  if (!nonEmptyString(anchor.speaker)) {
    return { ok: false, error: 'anchor.speaker is required' };
  }
  if (!nonEmptyString(anchor.originalText)) {
    return { ok: false, error: 'anchor.originalText is required' };
  }
  if (anchor.endTs !== undefined && typeof anchor.endTs !== 'string') {
    return { ok: false, error: 'anchor.endTs must be a string' };
  }

  const correction = b.correction as Record<string, unknown> | undefined;
  if (!correction || typeof correction !== 'object') {
    return { ok: false, error: 'correction is required' };
  }
  if (!TYPES.includes(correction.type as CorrectionType)) {
    return { ok: false, error: `correction.type must be one of ${TYPES.join(', ')}` };
  }
  if (!FIELDS.includes(correction.field as CorrectionField)) {
    return { ok: false, error: `correction.field must be one of ${FIELDS.join(', ')}` };
  }
  if (!nonEmptyString(correction.newValue)) {
    return { ok: false, error: 'correction.newValue is required' };
  }

  const field = correction.field as CorrectionField;
  const newValue = (correction.newValue as string).trim();
  const compareTo = field === 'name'
    ? (anchor.speaker as string).trim()
    : (anchor.originalText as string).trim();
  if (newValue === compareTo) {
    return { ok: false, error: 'correction.newValue must differ from the current value' };
  }

  if (b.note !== undefined && typeof b.note !== 'string') {
    return { ok: false, error: 'note must be a string' };
  }
  if (b.reporterName !== undefined && typeof b.reporterName !== 'string') {
    return { ok: false, error: 'reporterName must be a string' };
  }

  return {
    ok: true,
    value: {
      episodeNumber: episode,
      anchor: {
        startTs: (anchor.startTs as string).trim(),
        endTs: anchor.endTs as string | undefined,
        speaker: (anchor.speaker as string).trim(),
        originalText: (anchor.originalText as string).trim(),
      },
      correction: { type: correction.type as CorrectionType, field, newValue },
      note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : undefined,
      reporterName:
        typeof b.reporterName === 'string' && b.reporterName.trim()
          ? b.reporterName.trim()
          : undefined,
    },
  };
}

export function newReportId(now: number, rand: string): string {
  return `tr_${now}_${rand}`;
}

export function buildReport(
  input: ReportInput,
  meta: { id: string; createdAt: string; source: string },
): TranscriptionReport {
  return {
    ...input,
    id: meta.id,
    createdAt: meta.createdAt,
    source: meta.source,
    status: 'pending',
  };
}

export async function saveTranscriptionReport(report: TranscriptionReport): Promise<void> {
  await writeReport(report);
}

// Overwrites the same Blob object in place (status transitions reuse the id).
export async function writeReport(report: TranscriptionReport): Promise<void> {
  await put(`${PREFIX}${report.id}.json`, JSON.stringify(report, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

export async function listTranscriptionReports(
  status: ReportStatus | 'all' = 'all',
): Promise<TranscriptionReport[]> {
  const { blobs } = await list({ prefix: PREFIX });
  const reports: TranscriptionReport[] = [];
  for (const blob of blobs) {
    if (!blob.pathname.endsWith('.json')) continue;
    try {
      const resp = await fetch(blob.url, { cache: 'no-store' });
      if (resp.ok) reports.push(await resp.json());
    } catch {
      // skip corrupt entries
    }
  }
  const filtered = status === 'all' ? reports : reports.filter((r) => r.status === status);
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadTranscriptionReport(id: string): Promise<TranscriptionReport | null> {
  const { blobs } = await list({ prefix: `${PREFIX}${id}.json` });
  const match = blobs.find((b) => b.pathname === `${PREFIX}${id}.json`);
  if (!match) return null;
  try {
    const resp = await fetch(match.url, { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}
