import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/podreview-auth';
import {
  loadProposals,
  listPendingProposals,
  saveProposals,
  applyDecisions,
  acceptedRow,
  isTier2Column,
  type ProposalStatus,
} from '@/lib/pdc-proposals';

const VALID: ProposalStatus[] = ['pending', 'accepted', 'rejected'];

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const episode = request.nextUrl.searchParams.get('episode');
  try {
    if (episode) {
      return NextResponse.json({ proposals: await loadProposals(episode.trim()) });
    }
    return NextResponse.json({ pending: await listPendingProposals() });
  } catch {
    return NextResponse.json({ error: 'Failed to load proposals' }, { status: 500 });
  }
}

/**
 * Record accept/reject decisions. Returns the accepted values so the client can
 * apply them to its form — this route deliberately does NOT write to the sheet.
 * The sheet write happens when the human saves in /podreview, through the
 * existing update-pdc route, so there is exactly one sheet writer.
 */
export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { episode, decisions } = await request.json();
  if (!episode || typeof decisions !== 'object' || decisions === null) {
    return NextResponse.json({ error: 'episode and decisions are required' }, { status: 400 });
  }

  const clean: Record<string, ProposalStatus> = {};
  for (const [k, v] of Object.entries(decisions as Record<string, unknown>)) {
    if (!isTier2Column(k)) {
      return NextResponse.json({ error: `Not a Tier 2 column: ${k}` }, { status: 400 });
    }
    if (typeof v !== 'string' || !VALID.includes(v as ProposalStatus)) {
      return NextResponse.json({ error: `Invalid status for ${k}` }, { status: 400 });
    }
    clean[k] = v as ProposalStatus;
  }

  const doc = await loadProposals(String(episode).trim());
  if (!doc) {
    return NextResponse.json({ error: `No proposals for episode ${episode}` }, { status: 404 });
  }

  const next = applyDecisions(doc, clean);
  await saveProposals(next);

  return NextResponse.json({ ok: true, accepted: acceptedRow(next) });
}
