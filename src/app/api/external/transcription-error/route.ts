import { NextRequest, NextResponse } from 'next/server';
import { validateExternalKey } from '@/lib/external-auth';
import { checkRateLimit } from '@/lib/external-rate-limit';
import { getEpisodeByNumber } from '@/lib/metadata-store';
import {
  validateReportInput,
  buildReport,
  newReportId,
  saveTranscriptionReport,
} from '@/lib/transcription-report';
import { notifyNewReport } from '@/lib/discord-notify';

export async function POST(request: NextRequest) {
  const auth = validateExternalKey(request.headers.get('x-eh-key'));
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.reason === 'missing' ? 'Missing x-eh-key header' : 'Invalid key' },
      { status: 401 },
    );
  }

  const rl = checkRateLimit(auth.keyId);
  if (!rl.allowed) {
    const headers: Record<string, string> = {};
    if (rl.retryAfterSec) headers['Retry-After'] = String(rl.retryAfterSec);
    return NextResponse.json(
      { error: `Rate limit exceeded (${rl.scope})`, retryAfterSec: rl.retryAfterSec },
      { status: 429, headers },
    );
  }

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
    source: auth.keyId,
  });

  try {
    await saveTranscriptionReport(report);
  } catch (err) {
    console.error('Failed to save transcription report:', err, { keyId: auth.keyId });
    return NextResponse.json({ error: 'Failed to store report' }, { status: 500 });
  }

  await notifyNewReport(report);

  return NextResponse.json({ id: report.id }, { status: 201 });
}
