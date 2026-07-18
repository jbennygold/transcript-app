'use client';

import { useState, useEffect, useCallback } from 'react';
import CleanupReview, { type CleanupDecision } from '@/components/CleanupReview';
import type { CleanupChange } from '@/app/api/cleanup-transcript/route';
import { resolveReportAnchor } from '@/lib/resolve-report-anchor';
import type { Transcript } from '@/types/transcript';

interface SubmittedReport {
  id: string;
  source: string;
  reporterName?: string;
  createdAt: string;
  episodeNumber: number;
  anchor: { startTs: string; endTs?: string; speaker: string; originalText: string };
  correction: {
    type: 'sample' | 'spelling' | 'speaker' | 'voicemailer';
    field: 'name' | 'text';
    newValue: string;
  };
  note?: string;
}

const STALE_LABEL: Record<string, string> = {
  already_fixed: 'already fixed in the transcript',
  not_found: 'text no longer found',
  ambiguous: 'matches multiple turns',
};

export default function SubmissionsPage() {
  const [reports, setReports] = useState<SubmittedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/transcription-reports?status=pending')
      .then((r) => r.json())
      .then((d) => {
        setReports(d.reports ?? []);
        setLoadError(null);
      })
      .catch(() => setLoadError('Failed to load submissions. Refresh to try again.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const byEpisode = reports.reduce<Record<number, SubmittedReport[]>>((acc, r) => {
    (acc[r.episodeNumber] ??= []).push(r);
    return acc;
  }, {});
  const episodes = Object.keys(byEpisode)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Submitted corrections</h1>
      <p style={{ color: '#6b7280', fontSize: 14, marginTop: 4 }}>
        Corrections submitted from explore.escapehatchpod.com. Nothing is changed until you click{' '}
        <strong>Apply</strong> on an episode.
      </p>

      {loading ? (
        <p style={{ marginTop: 24 }}>Loading…</p>
      ) : loadError ? (
        <p style={{ marginTop: 24, color: '#b91c1c', fontWeight: 600 }}>⚠ {loadError}</p>
      ) : reports.length === 0 ? (
        <p style={{ marginTop: 24 }}>No pending submissions. 🎉</p>
      ) : (
        episodes.map((ep) => (
          <EpisodeSubmissions
            key={ep}
            episodeNumber={ep}
            reports={byEpisode[ep]}
            onDone={load}
          />
        ))
      )}
    </main>
  );
}

function EpisodeSubmissions({
  episodeNumber,
  reports,
  onDone,
}: {
  episodeNumber: number;
  reports: SubmittedReport[];
  onDone: () => void;
}) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/transcripts/${episodeNumber}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((t: Transcript) => {
        if (!cancelled) setTranscript(t);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this episode’s transcript.');
      });
    return () => {
      cancelled = true;
    };
  }, [episodeNumber]);

  // Resolve each report against the current transcript (for DISPLAY only —
  // the batch endpoint re-resolves authoritatively at apply time).
  const changes: CleanupChange[] = [];
  const reportIds: string[] = [];
  const stale: { report: SubmittedReport; reason: string }[] = [];

  if (transcript) {
    for (const r of reports) {
      const res = resolveReportAnchor(transcript, r);
      if (res.status === 'match') {
        const turn = transcript.dialogues[res.index];
        changes.push({
          index: res.index,
          type: r.correction.type,
          field: r.correction.field,
          oldValue: r.correction.field === 'name' ? turn.name : turn.text,
          newValue: r.correction.newValue,
          reason: `${r.note ? r.note + ' — ' : ''}from ${r.source}${r.reporterName ? ` (${r.reporterName})` : ''}`,
        });
        reportIds.push(r.id);
      } else {
        stale.push({ report: r, reason: res.status });
      }
    }
  }

  const submitBatch = async (
    apply: { id: string; newValue: string }[],
    dismiss: string[],
  ) => {
    setBusy(true);
    try {
      const resp = await fetch('/api/transcription-reports/resolve-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeNumber, apply, dismiss }),
      });
      if (!resp.ok) throw new Error('request failed');
      const data = await resp.json();
      const applied = (data.results ?? []).filter((x: { status: string }) => x.status === 'applied').length;
      const staleN = (data.results ?? []).filter((x: { status: string }) => x.status === 'stale').length;
      setSummary(
        `Applied ${applied}${staleN ? `, ${staleN} were stale` : ''}${data.rebuildTriggered ? ' · rebuild triggered' : ''}.`,
      );
      // Refresh the whole list after a short beat so applied/dismissed drop out.
      setTimeout(onDone, 1200);
    } catch {
      setError('Apply failed. Nothing was changed. Refresh and try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleApply = (_accepted: CleanupChange[], decisions: CleanupDecision[]) => {
    // Only apply the checked reports. Un-checked matched reports are SKIPPED
    // (left pending), not dismissed — un-checking to defer must never silently
    // retire a submission. Dismissing a matched report is a deliberate act via
    // the stale-list Dismiss button; the appliable panel never auto-dismisses.
    const apply: { id: string; newValue: string }[] = [];
    decisions.forEach((d, i) => {
      const id = reportIds[i];
      if (id && d.accepted) apply.push({ id, newValue: d.change.newValue });
    });
    if (apply.length === 0) return;
    submitBatch(apply, []);
  };

  const dismissStale = (id: string) => submitBatch([], [id]);

  return (
    <section style={{ marginTop: 28, borderTop: '1px solid #e5e7eb', paddingTop: 20 }}>
      {error && <p style={{ color: '#b91c1c', fontWeight: 600 }}>⚠ {error}</p>}
      {summary && <p style={{ color: '#16a34a', fontWeight: 600 }}>✓ {summary}</p>}

      {!error && !summary && !transcript && <p>Loading episode {episodeNumber}…</p>}

      {transcript && !summary && changes.length > 0 && (
        <div style={{ opacity: busy ? 0.6 : 1, pointerEvents: busy ? 'none' : 'auto' }}>
          <CleanupReview
            title={`Episode ${episodeNumber} · submitted corrections`}
            changes={changes}
            dialogues={transcript.dialogues}
            onApply={handleApply}
            onCancel={onDone}
          />
        </div>
      )}

      {transcript && !summary && stale.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13, color: '#b45309', fontWeight: 600 }}>
            {stale.length} submission{stale.length !== 1 ? 's' : ''} no longer match this transcript:
          </p>
          {stale.map(({ report, reason }) => (
            <div
              key={report.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                fontSize: 13,
                padding: '8px 10px',
                border: '1px solid #fde68a',
                background: '#fffbeb',
                borderRadius: 6,
                marginTop: 6,
              }}
            >
              <span>
                {report.anchor.speaker} · {report.anchor.startTs} — {STALE_LABEL[reason] ?? reason} · “
                {report.correction.newValue.slice(0, 60)}”
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => dismissStale(report.id)}
                style={{
                  padding: '4px 10px',
                  border: '1px solid #d1d5db',
                  background: '#fff',
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {transcript && !summary && changes.length === 0 && stale.length === 0 && (
        <p style={{ color: '#6b7280' }}>Episode {episodeNumber}: no actionable submissions.</p>
      )}
    </section>
  );
}
