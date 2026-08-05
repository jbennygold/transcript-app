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

interface EpisodeNoteView {
  id: string;
  episode: string;
  note: string;
  submittedBy: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  /** Absent on notes stored before this field existed; render as /pdc-note. */
  source?: 'command' | 'thread';
}

const STALE_LABEL: Record<string, string> = {
  already_fixed: 'already fixed in the transcript',
  not_found: 'text no longer found',
  ambiguous: 'matches multiple turns',
};

/** Outcomes that mean the note is no longer pending through no fault of this request. */
const NOTES_OK_OUTCOMES = new Set(['appended', 'rejected', 'duplicate']);
/** Outcomes that are informational, not failures: someone else already resolved it. */
const NOTES_INFO_OUTCOMES = new Set(['already_approved', 'already_rejected']);

export default function SubmissionsPage() {
  const [reports, setReports] = useState<SubmittedReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tab, setTab] = useState<'reports' | 'notes'>('reports');
  const [notes, setNotes] = useState<EpisodeNoteView[]>([]);
  const [notesStatus, setNotesStatus] = useState<'pending' | 'approved' | 'all'>('pending');
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesMessage, setNotesMessage] = useState<string | null>(null);

  // The notes tab hits Bearer-authed endpoints (GET /api/episode-notes,
  // POST /api/episode-notes/resolve) — same PODREVIEW_PASSWORD as
  // src/app/podreview/page.tsx, so the auth flow mirrors that page,
  // including reusing its sessionStorage key so a session carries over.
  const [notesAuth, setNotesAuth] = useState<string | null>(null);
  const [notesAuthChecked, setNotesAuthChecked] = useState(false);

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

  useEffect(() => {
    const saved = sessionStorage.getItem('podreview_auth');
    if (!saved) {
      setNotesAuthChecked(true);
      return;
    }
    fetch('/api/podreview/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: saved }),
    })
      .then((res) => {
        if (res.ok) setNotesAuth(saved);
      })
      .catch(() => {})
      .finally(() => setNotesAuthChecked(true));
  }, []);

  const loadNotes = useCallback(async () => {
    if (!notesAuth) return;
    try {
      const res = await fetch(`/api/episode-notes?status=${notesStatus}`, {
        headers: { Authorization: `Bearer ${notesAuth}` },
      });
      if (!res.ok) throw new Error('request failed');
      const d = await res.json();
      setNotes(d.notes ?? []);
      setNotesError(null);
    } catch {
      setNotesError('Failed to load notes. Refresh to try again.');
    }
  }, [notesAuth, notesStatus]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  function handleNotesAuth(pw: string) {
    sessionStorage.setItem('podreview_auth', pw);
    setNotesAuth(pw);
  }

  async function resolveNotes(decisions: Array<{ id: string; status: 'approved' | 'rejected' }>) {
    if (!notesAuth) return;
    setNotesMessage(null);
    const withEdits = decisions.map((d) =>
      d.status === 'approved' && edited[d.id] ? { ...d, note: edited[d.id] } : d
    );
    try {
      const res = await fetch('/api/episode-notes/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${notesAuth}` },
        body: JSON.stringify({ decisions: withEdits }),
      });
      if (!res.ok) {
        setNotesMessage(null);
        setNotesError('Request failed. Nothing was changed — notes remain pending.');
        return;
      }
      const data = await res.json();
      const results: Array<{ outcome: string }> = data.results ?? [];
      const failed = results.filter(
        (r) => !NOTES_OK_OUTCOMES.has(r.outcome) && !NOTES_INFO_OUTCOMES.has(r.outcome)
      );
      const alreadyResolved = results.filter((r) => NOTES_INFO_OUTCOMES.has(r.outcome));
      if (failed.length > 0) {
        setNotesMessage(null);
        setNotesError(
          `${failed.length} note(s) could not be applied: ${failed.map((f) => f.outcome).join(', ')}. They remain pending.`
        );
      } else if (alreadyResolved.length > 0) {
        setNotesMessage(null);
        setNotesError(`${alreadyResolved.length} note(s) were already resolved by someone else.`);
      } else {
        setNotesError(null);
        const appended = results.filter((r) => r.outcome === 'appended').length;
        const duplicate = results.filter((r) => r.outcome === 'duplicate').length;
        const rejected = results.filter((r) => r.outcome === 'rejected').length;
        const approved = appended + duplicate;
        const parts: string[] = [];
        if (approved > 0) {
          if (appended > 0 && duplicate > 0) {
            parts.push(
              `${approved} note(s) approved (${appended} appended to the sheet, ${duplicate} already present)`
            );
          } else if (duplicate > 0) {
            parts.push(`${duplicate} note(s) approved (already present in the sheet)`);
          } else {
            parts.push(`${appended} note(s) approved and appended to the sheet`);
          }
        }
        if (rejected > 0) {
          parts.push(`${rejected} note(s) rejected`);
        }
        setNotesMessage(parts.length > 0 ? `${parts.join('; ')}.` : null);
      }
    } catch {
      setNotesMessage(null);
      setNotesError('Request failed. Nothing was changed — notes remain pending.');
      return;
    }
    loadNotes();
  }

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

      <div className="mb-4 flex gap-2" style={{ marginTop: 16, marginBottom: 16 }}>
        <button
          onClick={() => setTab('reports')}
          style={{ fontWeight: tab === 'reports' ? 600 : 400 }}
        >
          Transcription reports
        </button>
        <button
          onClick={() => setTab('notes')}
          style={{ fontWeight: tab === 'notes' ? 600 : 400 }}
        >
          Notable Moments ({notes.length})
        </button>
      </div>

      {tab === 'notes' && notesAuth && (
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <label htmlFor="notes-status-filter" style={{ fontSize: 13, color: '#6b7280' }}>
            Status:
          </label>
          <select
            id="notes-status-filter"
            value={notesStatus}
            onChange={(e) => setNotesStatus(e.target.value as 'pending' | 'approved' | 'all')}
            style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
          >
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="all">All</option>
          </select>
        </div>
      )}

      {tab === 'reports' && (
        <>
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
        </>
      )}

      {tab === 'notes' && (
        <div>
          {!notesAuthChecked ? (
            <p>Checking…</p>
          ) : !notesAuth ? (
            <NotesAuthGate onAuth={handleNotesAuth} />
          ) : (
            <>
              {notesError && <p style={{ color: '#b91c1c' }}>{notesError}</p>}
              {notesMessage && <p style={{ color: '#15803d' }}>{notesMessage}</p>}
              {notes.length === 0 && (
                <p>
                  {notesStatus === 'pending'
                    ? 'No notes awaiting review.'
                    : notesStatus === 'approved'
                      ? 'No approved notes.'
                      : 'No notes.'}
                </p>
              )}
              {notes.map((n) => {
                const isPending = n.status === 'pending';
                return (
                  <div key={n.id} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                      Ep {n.episode} · {n.submittedBy} · {new Date(n.createdAt).toLocaleString()}
                      <span
                        style={{
                          marginLeft: 8,
                          padding: '1px 6px',
                          borderRadius: 4,
                          fontSize: 11,
                          background: n.source === 'thread' ? '#e8f0fe' : '#f1f1f1',
                          color: '#444',
                        }}
                      >
                        {n.source === 'thread' ? 'thread' : '/pdc-note'}
                      </span>
                      {!isPending && (
                        <span
                          style={{
                            marginLeft: 8,
                            padding: '1px 6px',
                            borderRadius: 4,
                            fontSize: 11,
                            background: n.status === 'approved' ? '#dcfce7' : '#fee2e2',
                            color: n.status === 'approved' ? '#166534' : '#991b1b',
                          }}
                        >
                          {n.status}
                        </span>
                      )}
                    </div>
                    <textarea
                      value={edited[n.id] ?? n.note}
                      onChange={(e) => setEdited((prev) => ({ ...prev, [n.id]: e.target.value }))}
                      rows={2}
                      disabled={!isPending}
                      style={{ width: '100%', marginBottom: 8 }}
                    />
                    {isPending && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => resolveNotes([{ id: n.id, status: 'approved' }])}>Approve</button>
                        <button onClick={() => resolveNotes([{ id: n.id, status: 'rejected' }])}>Reject</button>
                      </div>
                    )}
                  </div>
                );
              })}
              {notes.filter((n) => n.status === 'pending').length > 1 && (
                <button
                  onClick={() =>
                    resolveNotes(
                      notes
                        .filter((n) => n.status === 'pending')
                        .map((n) => ({ id: n.id, status: 'approved' as const }))
                    )
                  }
                >
                  Approve all {notes.filter((n) => n.status === 'pending').length}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}

function NotesAuthGate({ onAuth }: { onAuth: (pw: string) => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/podreview/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        onAuth(pw);
      } else {
        setError('Invalid password');
      }
    } catch {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 280, marginTop: 16 }}
    >
      <p style={{ margin: 0, fontSize: 14, color: '#6b7280' }}>
        Notable Moments review requires the review password.
      </p>
      <input
        type="password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="Password"
        autoFocus
        style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
      />
      {error && <span style={{ color: '#b91c1c', fontSize: 13 }}>{error}</span>}
      <button type="submit" disabled={loading}>
        {loading ? 'Checking…' : 'Unlock'}
      </button>
    </form>
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
