'use client';

import { useEffect, useState } from 'react';
import { ReportCard, type ReportCardData } from '@/components/ReportCard';

export default function ReportsReviewPage() {
  const [reports, setReports] = useState<ReportCardData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/transcription-reports?status=pending')
      .then((r) => r.json())
      .then((d) => setReports(d.reports ?? []))
      .finally(() => setLoading(false));
  }, []);

  function handleResolved(id: string, outcome: string) {
    // Applied/dismissed cards drop out of the pending list on next load;
    // keep stale cards visible so the reason stays on screen.
    if (outcome === 'applied' || outcome === 'dismissed') {
      setTimeout(() => setReports((prev) => prev.filter((r) => r.id !== id)), 1500);
    }
  }

  const byEpisode = reports.reduce<Record<number, ReportCardData[]>>((acc, r) => {
    (acc[r.episodeNumber] ??= []).push(r);
    return acc;
  }, {});

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Transcription error reports</h1>
      <p style={{ color: '#6b7280', fontSize: 14 }}>
        Nothing is changed until you click <strong>Approve &amp; apply</strong> on a report.
      </p>

      {loading ? (
        <p>Loading…</p>
      ) : reports.length === 0 ? (
        <p style={{ marginTop: 24 }}>No pending reports. 🎉</p>
      ) : (
        Object.entries(byEpisode).map(([ep, list]) => (
          <section key={ep} style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Episode {ep}</h2>
            {list.map((r) => (
              <ReportCard key={r.id} report={r} onResolved={handleResolved} />
            ))}
          </section>
        ))
      )}
    </main>
  );
}
