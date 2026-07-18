'use client';

import { useState } from 'react';

export interface ReportCardData {
  id: string;
  createdAt: string;
  source: string;
  status: string;
  episodeNumber: number;
  anchor: { startTs: string; endTs?: string; speaker: string; originalText: string };
  correction: { type: string; field: string; newValue: string };
  note?: string;
  reporterName?: string;
}

export function ReportCard({
  report,
  onResolved,
}: {
  report: ReportCardData;
  onResolved: (id: string, outcome: string, reason?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ status: string; reason?: string } | null>(null);

  const oldValue =
    report.correction.field === 'name' ? report.anchor.speaker : report.anchor.originalText;

  async function resolve(action: 'apply' | 'dismiss') {
    setBusy(true);
    try {
      const resp = await fetch(`/api/transcription-reports/${report.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await resp.json();
      setOutcome({ status: data.status, reason: data.reason });
      onResolved(report.id, data.status, data.reason);
    } catch {
      setOutcome({ status: 'error', reason: 'request failed' });
    } finally {
      setBusy(false);
    }
  }

  const isStale = outcome?.status === 'stale';

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#6b7280' }}>
        <span>
          {report.anchor.speaker} · {report.anchor.startTs}
          {report.anchor.endTs ? `–${report.anchor.endTs}` : ''} · {report.correction.type}
        </span>
        <span>from {report.source}{report.reporterName ? ` (${report.reporterName})` : ''}</span>
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: 8, fontSize: 14 }}>
          − {oldValue}
        </div>
        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: 8, fontSize: 14, marginTop: 6 }}>
          + {report.correction.newValue}
        </div>
      </div>

      {report.note && (
        <p style={{ marginTop: 8, fontSize: 13, color: '#374151' }}>Note: {report.note}</p>
      )}

      {outcome ? (
        <p style={{ marginTop: 12, fontWeight: 600, color: isStale ? '#b45309' : '#16a34a' }}>
          {isStale ? `⚠ STALE (${outcome.reason}) — not applied` : `✓ ${outcome.status}`}
        </p>
      ) : (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={() => resolve('apply')} disabled={busy}
            style={{ padding: '6px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
            Approve &amp; apply
          </button>
          <button onClick={() => resolve('dismiss')} disabled={busy}
            style={{ padding: '6px 12px', background: '#f3f4f6', color: '#111', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
