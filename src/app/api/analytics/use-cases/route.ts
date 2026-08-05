import { NextRequest, NextResponse } from 'next/server';
import { list } from '@vercel/blob';
import { fetchBlobJson } from '@/lib/blob-storage';
import { UC_LABELS } from '@/lib/use-case-classifier';
import type { QueryLogEntry } from '@/lib/query-logger';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/use-cases
 *
 * Query params:
 *   week  — ISO date (e.g. "2026-03-10") for Monday of target week, "all" for all time.
 *           Defaults to current week.
 *   useCase — optional UC code (e.g. "UC-3") for drill-down; includes query list in response.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const weekParam = searchParams.get('week') ?? undefined;
  const useCaseFilter = searchParams.get('useCase') ?? undefined;

  // --- Determine date range ---
  const isAll = weekParam === 'all';
  let weekStart: Date;
  let weekEnd: Date;

  if (isAll) {
    weekStart = new Date('2020-01-01');
    weekEnd = new Date('2099-12-31');
  } else {
    if (weekParam) {
      weekStart = new Date(weekParam + 'T00:00:00Z');
    } else {
      // Default: Monday of the current week
      const now = new Date();
      const day = now.getUTCDay();
      const diff = day === 0 ? 6 : day - 1; // Monday=0 offset
      weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
    }
    weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  }

  // --- Determine which month prefixes to fetch ---
  const prefixes = new Set<string>();
  if (isAll) {
    prefixes.add('query-log/');
  } else {
    const fmt = (d: Date) => {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      return `query-log/${y}-${m}/`;
    };
    prefixes.add(fmt(weekStart));
    prefixes.add(fmt(weekEnd));
  }

  // --- Load entries from Blob ---
  const entries: QueryLogEntry[] = [];

  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const result = await list({ prefix, cursor });
      const fetches = result.blobs.map(async (blob) => {
        try {
          // Size-verified: these entries are overwritten in place when feedback
          // adds a rating or classify-query-logs adds a use-case, so an
          // unverified read can report a query as unrated after it was rated.
          const loaded = await fetchBlobJson<QueryLogEntry>(blob.url, blob.size, 'fast');
          return loaded?.data ?? null;
        } catch {
          return null;
        }
      });
      const batch = await Promise.all(fetches);
      for (const entry of batch) {
        if (entry) entries.push(entry);
      }
      cursor = result.cursor;
    } while (cursor);
  }

  // --- Filter to week range ---
  const filtered = isAll
    ? entries
    : entries.filter((e) => {
        const ts = new Date(e.timestamp).getTime();
        return ts >= weekStart.getTime() && ts <= weekEnd.getTime();
      });

  // --- Resolve best use case per entry ---
  const resolveUC = (e: QueryLogEntry): string =>
    e.useCaseLLM || e.useCase || 'unclassified';

  // --- Build distribution ---
  const counts = new Map<string, number>();
  for (const e of filtered) {
    const uc = resolveUC(e);
    counts.set(uc, (counts.get(uc) ?? 0) + 1);
  }

  const totalQueries = filtered.length;

  const distribution: { useCase: string; label: string; count: number; percent: number; rated: number; good: number; bad: number }[] = [];

  // Count feedback per UC
  const ratedCounts = new Map<string, { rated: number; good: number; bad: number }>();
  for (const e of filtered) {
    const uc = resolveUC(e);
    if (!e.rating) continue;
    const r = ratedCounts.get(uc) ?? { rated: 0, good: 0, bad: 0 };
    r.rated++;
    if (e.rating === 'good') r.good++;
    if (e.rating === 'bad') r.bad++;
    ratedCounts.set(uc, r);
  }

  // Include all UC_LABELS keys that have counts, plus any uncategorised codes
  const allCodes = new Set([...Object.keys(UC_LABELS), ...counts.keys()]);
  for (const uc of allCodes) {
    const count = counts.get(uc) ?? 0;
    if (count === 0) continue;
    const r = ratedCounts.get(uc) ?? { rated: 0, good: 0, bad: 0 };
    distribution.push({
      useCase: uc,
      label: UC_LABELS[uc] ?? (uc === 'unclassified' ? 'Unclassified' : uc),
      count,
      percent: totalQueries > 0 ? Math.round((count / totalQueries) * 1000) / 10 : 0,
      ...r,
    });
  }

  distribution.sort((a, b) => b.count - a.count);

  // --- Period label ---
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
  const period = isAll ? 'all' : `${fmtDate(weekStart)}/${fmtDate(weekEnd)}`;

  // --- Drill-down queries ---
  let queries: {
    id: string;
    query: string;
    useCase: string;
    timestamp: string;
    rating: string | null;
    routingPath: string | undefined;
  }[] | undefined;

  if (useCaseFilter) {
    queries = filtered
      .filter((e) => resolveUC(e) === useCaseFilter)
      .map((e) => ({
        id: e.id,
        query: e.query,
        useCase: resolveUC(e),
        timestamp: e.timestamp,
        rating: e.rating ?? null,
        routingPath: e.routingPath,
      }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  const totalRated = filtered.filter((e) => e.rating).length;
  const totalGood = filtered.filter((e) => e.rating === 'good').length;
  const totalBad = filtered.filter((e) => e.rating === 'bad').length;

  return NextResponse.json({
    distribution,
    totalQueries,
    totalRated,
    totalGood,
    totalBad,
    period,
    ...(queries !== undefined && { queries }),
  });
}
