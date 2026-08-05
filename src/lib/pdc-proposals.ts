/**
 * Tier 2 proposal store.
 *
 * Tier 2 never writes to the sheet. It writes a proposal document to Blob;
 * a human accepts or rejects each field in /podreview, and only that
 * acceptance produces a sheet write.
 *
 * Pure helpers are separated from the Blob I/O so they can be unit-tested
 * without credentials, matching src/lib/transcription-report.ts.
 */
import { put, list } from '@vercel/blob';
import { fetchBlobJson, MUTABLE_BLOB_CACHE_MAX_AGE } from './blob-storage';
import type { PdcColumnKey } from './pdc-sheet';

const PREFIX = 'pdc-proposals/';

export type ProposalStatus = 'pending' | 'accepted' | 'rejected';
export type ProposalConfidence = 'high' | 'low';

/** The only columns Tier 2 is permitted to propose. */
export const TIER2_COLUMNS = [
  'Film',
  'Thats_Great_Count',
  'Kevs_Question',
  'TildaH',
  'TildaJason',
  'TildaGuest',
  'TildaCorey',
] as const satisfies readonly PdcColumnKey[];

export type Tier2Column = (typeof TIER2_COLUMNS)[number];

export function isTier2Column(key: string): key is Tier2Column {
  return (TIER2_COLUMNS as readonly string[]).includes(key);
}

export interface FieldProposal {
  column: Tier2Column;
  /** The value Tier 2 derived. */
  proposed: string;
  /** The sheet's value at proposal time, for side-by-side display. */
  current: string | null;
  confidence: ProposalConfidence;
  /** A quote or turn reference backing the value, shown to the reviewer. */
  evidence?: string;
  status: ProposalStatus;
}

export interface EpisodeProposals {
  episode: string;
  film: string;
  createdAt: string;
  proposals: FieldProposal[];
}

export function buildProposals(
  episode: string,
  film: string,
  createdAt: string,
  fields: Array<Omit<FieldProposal, 'status'>>
): EpisodeProposals {
  return {
    episode,
    film,
    createdAt,
    proposals: fields.map(f => ({ ...f, status: 'pending' as ProposalStatus })),
  };
}

/** Return a copy with the named columns' statuses updated. Never mutates. */
export function applyDecisions(
  doc: EpisodeProposals,
  decisions: Record<string, ProposalStatus>
): EpisodeProposals {
  return {
    ...doc,
    proposals: doc.proposals.map(p =>
      decisions[p.column] ? { ...p, status: decisions[p.column] } : { ...p }
    ),
  };
}

/** The sheet row implied by the accepted proposals. */
export function acceptedRow(doc: EpisodeProposals): Partial<Record<Tier2Column, string>> {
  const row: Partial<Record<Tier2Column, string>> = {};
  for (const p of doc.proposals) {
    if (p.status === 'accepted') row[p.column] = p.proposed;
  }
  return row;
}

export function isFieldProposal(value: unknown): value is FieldProposal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.column === 'string' &&
    isTier2Column(v.column) &&
    typeof v.proposed === 'string' &&
    typeof v.status === 'string'
  );
}

export function isEpisodeProposals(value: unknown): value is EpisodeProposals {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.episode === 'string' &&
    typeof v.createdAt === 'string' &&
    Array.isArray(v.proposals) &&
    v.proposals.every(isFieldProposal)
  );
}

// ── Blob I/O ──

/**
 * One document per episode, not per run.
 *
 * The spec sketched `ep{N}_{timestamp}.json`, but ingest re-runs on every
 * cleanup pass, and a timestamped key would accumulate duplicate proposal sets
 * for the same episode. Overwriting keeps re-ingest idempotent.
 */
function keyFor(episode: string): string {
  return `${PREFIX}ep${episode}.json`;
}

/**
 * Overwriting this document leaves the previous version served at Vercel Blob's
 * CDN edge, and `fetch(cache: 'no-store')` does not prevent that — it only
 * bypasses the runtime's own cache. Without a short TTL these inherited Blob's
 * one-month default, so a superseded proposal set could be served for weeks.
 *
 * That happened on ep 317: ingest first ran against an unmapped transcript and
 * saved a single Thats_Great_Count proposal, then later runs saved the full six.
 * /podreview kept showing the stale set. Reads below verify against `list()`
 * metadata, which is not CDN-cached; see fetchBlobJson() for the mechanics.
 */
export async function saveProposals(doc: EpisodeProposals): Promise<void> {
  await put(keyFor(doc.episode), JSON.stringify(doc, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: MUTABLE_BLOB_CACHE_MAX_AGE,
  });
}

export async function loadProposals(episode: string): Promise<EpisodeProposals | null> {
  const key = keyFor(episode);
  const { blobs } = await list({ prefix: key });
  const match = blobs.find(b => b.pathname === key);
  if (!match) return null;
  try {
    // 'fast': this serves the /podreview UI, so correctness matters but a
    // multi-second stall does not pay for itself — the next load retries.
    const result = await fetchBlobJson<unknown>(match.url, match.size, 'fast');
    if (!result) return null;
    return isEpisodeProposals(result.data) ? result.data : null;
  } catch {
    return null;
  }
}

/** Every document that still has at least one pending field, newest first. */
export async function listPendingProposals(): Promise<EpisodeProposals[]> {
  const { blobs } = await list({ prefix: PREFIX });
  const docs: EpisodeProposals[] = [];
  for (const blob of blobs) {
    if (!blob.pathname.endsWith('.json')) continue;
    try {
      const result = await fetchBlobJson<unknown>(blob.url, blob.size, 'fast');
      if (result && isEpisodeProposals(result.data)) docs.push(result.data);
    } catch {
      // skip corrupt entries
    }
  }
  return docs
    .filter(d => d.proposals.some(p => p.status === 'pending'))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
