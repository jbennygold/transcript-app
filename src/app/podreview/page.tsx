'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Tier2Column } from '@/lib/pdc-proposals';

// ── Types ──

interface TMDBResult {
  id: number;
  title: string;
  releaseDate: string;
  year: string | null;
  posterPath: string | null;
}

interface EpisodeSummary {
  pod: string;
  season: number;
  episode: number | string;
  film: string;
  reviewer: string;
  releaseDate: string;
}

// ── Helpers ──

function store(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch {}
}
function load(k: string, d: string = ''): string {
  try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; }
}
function num(v: string): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function parseLength(hms: string): string {
  // Convert HH:MM:SS or H:MM:SS to minutes
  const parts = hms.split(':').map(Number);
  if (parts.length === 3) {
    return String(Math.round(parts[0] * 60 + parts[1] + parts[2] / 60));
  }
  if (parts.length === 2) {
    return String(Math.round(parts[0] + parts[1] / 60));
  }
  return '';
}

// ── Auth Gate ──

function AuthGate({ onAuth }: { onAuth: (pw: string) => void }) {
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
        sessionStorage.setItem('podreview_auth', pw);
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
    <div style={styles.authWrap}>
      <form onSubmit={handleSubmit} style={styles.authForm}>
        <h1 style={{ margin: 0, fontSize: 24 }}>PodReview</h1>
        <input
          type="password"
          value={pw}
          onChange={e => setPw(e.target.value)}
          placeholder="Password"
          style={styles.input}
          autoFocus
        />
        {error && <div style={styles.errorText}>{error}</div>}
        <button type="submit" disabled={loading} className="btn-primary" style={styles.btnPrimary}>
          {loading ? 'Checking...' : 'Enter'}
        </button>
      </form>
    </div>
  );
}

// ── Main Page ──

export default function PodReviewPage() {
  const [auth, setAuth] = useState<string | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    const saved = sessionStorage.getItem('podreview_auth');
    if (saved) {
      // Verify it's still valid
      fetch('/api/podreview/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: saved }),
      }).then(res => {
        if (res.ok) setAuth(saved);
        setCheckingAuth(false);
      }).catch(() => setCheckingAuth(false));
    } else {
      setCheckingAuth(false);
    }
  }, []);

  if (checkingAuth) return <div style={styles.authWrap}><p>Loading...</p></div>;
  if (!auth) return <AuthGate onAuth={setAuth} />;

  return <ReviewForm auth={auth} />;
}

// ── Review Form ──

function ReviewForm({ auth }: { auth: string }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` };

  // ── Episode list state ──
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [nextEpisode, setNextEpisode] = useState(0);
  const [latestSeason, setLatestSeason] = useState(0);
  const [editingEpisodeId, setEditingEpisodeId] = useState<string | null>(null);

  // ── Form fields ──
  const [film, setFilm] = useState(() => load('pr_film'));
  const [season, setSeason] = useState(() => load('pr_season', '0'));
  const [episode, setEpisode] = useState(() => load('pr_episode'));
  const [releaseDate, setReleaseDate] = useState(() => load('pr_releaseDate'));
  const [length, setLength] = useState(() => load('pr_length'));
  const [reviewer, setReviewer] = useState(() => load('pr_reviewer'));
  const [guest, setGuest] = useState(() => load('pr_guest'));
  const [showLink, setShowLink] = useState(() => load('pr_showLink'));
  const [artworkLink, setArtworkLink] = useState(() => load('pr_artworkLink'));
  const [letterboxdLink, setLetterboxdLink] = useState(() => load('pr_letterboxdLink'));
  const [imdbLink, setImdbLink] = useState(() => load('pr_imdbLink'));

  // Counters
  const [mmmCount, setMmmCount] = useState(() => num(load('podreview_mmm', '0')));
  const [tgCount, setTgCount] = useState(() => num(load('podreview_tg', '0')));

  // Notes
  const [notableMoments, setNotableMoments] = useState(() => load('podreview_notable'));
  const [hFlex, setHFlex] = useState(() => load('podreview_hflex'));
  const [jFlex, setJFlex] = useState(() => load('podreview_jflex'));
  const [kevsQuestion, setKevsQuestion] = useState(() => load('podreview_kevq'));
  const [tildaH, setTildaH] = useState(() => load('podreview_tildah'));
  const [tildaJ, setTildaJ] = useState(() => load('podreview_tildaj'));
  const [tildaGuest, setTildaGuest] = useState(() => load('podreview_tildaguest'));
  const [tildaCorey, setTildaCorey] = useState(() => load('podreview_tildacorey'));

  // ── Tier 2 proposals ──
  const [proposals, setProposals] = useState<
    Array<{ column: Tier2Column; proposed: string; current: string | null; confidence: string; evidence?: string }>
  >([]);

  // ── TMDB search ──
  const [tmdbQuery, setTmdbQuery] = useState('');
  const [tmdbResults, setTmdbResults] = useState<TMDBResult[]>([]);
  const [tmdbLoading, setTmdbLoading] = useState(false);
  const [showTmdbDropdown, setShowTmdbDropdown] = useState(false);
  const [selectedTmdbId, setSelectedTmdbId] = useState<number | null>(null);
  const tmdbTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Toast ──
  const [toast, setToast] = useState<{ msg: string; type?: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ── Submission & Reset ──
  const [submitting, setSubmitting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showPdcConfirm, setShowPdcConfirm] = useState(false);
  const [pdcUpdating, setPdcUpdating] = useState(false);

  function showToast(msg: string, type?: string, duration = 2500) {
    setToast({ msg, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), duration);
  }

  // ── All known guests for autocomplete ──
  const [allGuests, setAllGuests] = useState<string[]>([]);

  // ── Load episode list on mount ──
  useEffect(() => {
    fetch('/api/podreview/episodes', { headers: { Authorization: `Bearer ${auth}` } })
      .then(r => r.json())
      .then(data => {
        setEpisodes(data.episodes || []);
        setNextEpisode(data.nextEpisode || 0);
        setLatestSeason(data.latestSeason || 0);
        setAllGuests(data.allGuests || []);
        // Set defaults if not already set
        if (!load('pr_episode')) {
          const next = String(data.nextEpisode || '');
          setEpisode(next);
          store('pr_episode', next);
        }
        if (!load('pr_season') || load('pr_season') === '0') {
          const s = String(data.latestSeason || 0);
          setSeason(s);
          store('pr_season', s);
        }
      })
      .catch(() => {});
  }, [auth]);

  // ── Close TMDB dropdown on outside click ──
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowTmdbDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ── TMDB search with debounce ──
  const searchTmdb = useCallback((q: string) => {
    clearTimeout(tmdbTimer.current);
    if (q.trim().length < 2) {
      setTmdbResults([]);
      setShowTmdbDropdown(false);
      return;
    }
    tmdbTimer.current = setTimeout(async () => {
      setTmdbLoading(true);
      try {
        const res = await fetch(`/api/podreview/tmdb-search?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${auth}` },
        });
        const data = await res.json();
        setTmdbResults(data.results || []);
        setShowTmdbDropdown(true);
      } catch {}
      setTmdbLoading(false);
    }, 350);
  }, [auth]);

  function resetCountersAndNotes() {
    setMmmCount(0); store('podreview_mmm', '0');
    setTgCount(0); store('podreview_tg', '0');
    setNotableMoments(''); store('podreview_notable', '');
    setHFlex(''); store('podreview_hflex', '');
    setJFlex(''); store('podreview_jflex', '');
    setKevsQuestion(''); store('podreview_kevq', '');
    setTildaH(''); store('podreview_tildah', '');
    setTildaJ(''); store('podreview_tildaj', '');
    setTildaGuest(''); store('podreview_tildaguest', '');
    setTildaCorey(''); store('podreview_tildacorey', '');
  }

  function clearAllFields() {
    setEditingEpisodeId(null);
    setFilm(''); store('pr_film', '');
    setTmdbQuery('');
    const s = String(latestSeason);
    setSeason(s); store('pr_season', s);
    const next = String(nextEpisode);
    setEpisode(next); store('pr_episode', next);
    setReleaseDate(''); store('pr_releaseDate', '');
    setLength(''); store('pr_length', '');
    setReviewer(''); store('pr_reviewer', '');
    setGuest(''); store('pr_guest', '');
    setShowLink(''); store('pr_showLink', '');
    setArtworkLink(''); store('pr_artworkLink', '');
    setLetterboxdLink(''); store('pr_letterboxdLink', '');
    setImdbLink(''); store('pr_imdbLink', '');
    setSelectedTmdbId(null);
    resetCountersAndNotes();
  }

  function resetAll() {
    clearAllFields();
    setShowResetConfirm(false);
    showToast('All data cleared', 'warn');
  }

  // ── Match Patreon + Spotify for auto-fill ──
  // If onlyFillEmpty is true, only set fields that are currently empty
  async function matchEpisodeSources(filmName: string, onlyFillEmpty = false) {
    try {
      const res = await fetch(
        `/api/podreview/match-episode?q=${encodeURIComponent(filmName)}`,
        { headers: { Authorization: `Bearer ${auth}` } }
      );
      const data = await res.json();
      const matched: string[] = [];

      if (data.spotify) {
        if (!onlyFillEmpty || !length) updateLength(data.spotify.duration);
        if (!onlyFillEmpty || !artworkLink) updateArtworkLink(data.spotify.artworkUrl);
        matched.push(`Spotify: ${data.spotify.title}`);
        // Use Spotify release date if no Patreon date
        if (!data.patreon && (!onlyFillEmpty || !releaseDate)) {
          updateReleaseDate(data.spotify.releaseDate);
        }
      }

      if (data.patreon) {
        if (!onlyFillEmpty || !showLink) updateShowLink(data.patreon.showLink);
        // Format Patreon date (ISO → M/D/YYYY)
        const d = new Date(data.patreon.publishedAt);
        const dateStr = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
        if (!onlyFillEmpty || !releaseDate) updateReleaseDate(dateStr);
        matched.push(`Patreon: ${data.patreon.title}`);
      }

      if (matched.length > 0) {
        showToast(`Matched: ${matched.join(', ')}`, undefined, 3500);
      }
    } catch {}
  }

  async function selectTmdbResult(result: TMDBResult) {
    const filmName = result.year ? `${result.title} (${result.year})` : result.title;
    setFilm(filmName);
    store('pr_film', filmName);
    setTmdbQuery(filmName);
    setShowTmdbDropdown(false);
    setSelectedTmdbId(result.id);
    resetCountersAndNotes();

    // Fetch TMDB details and match episode sources in parallel
    const tmdbPromise = fetch('/api/podreview/tmdb-search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tmdbId: result.id }),
    }).then(r => r.json()).catch(() => null);

    const matchPromise = matchEpisodeSources(filmName);

    const details = await tmdbPromise;
    if (details?.imdbLink) {
      setImdbLink(details.imdbLink);
      store('pr_imdbLink', details.imdbLink);
    }
    if (details?.letterboxdLink) {
      setLetterboxdLink(details.letterboxdLink);
      store('pr_letterboxdLink', details.letterboxdLink);
    }

    await matchPromise;
  }

  function useCustomFilmName() {
    const name = tmdbQuery.trim();
    if (name) {
      setFilm(name);
      store('pr_film', name);
      setShowTmdbDropdown(false);
      setSelectedTmdbId(null);
      resetCountersAndNotes();
      matchEpisodeSources(name);
      showToast('Using custom film name');
    }
  }

  // ── Load existing episode ──
  async function loadEpisode(epId: string) {
    try {
      const res = await fetch('/api/podreview/episodes', {
        method: 'POST',
        headers,
        body: JSON.stringify({ episode: epId }),
      });
      const data = await res.json();
      if (data.episode) {
        const ep = data.episode;
        setEditingEpisodeId(String(ep.episode));
        setFilm(ep.film || ''); store('pr_film', ep.film || '');
        setTmdbQuery(ep.film || '');
        if (ep.tmdbId) setSelectedTmdbId(ep.tmdbId);
        setSeason(String(ep.season ?? 0)); store('pr_season', String(ep.season ?? 0));
        setEpisode(String(ep.episode)); store('pr_episode', String(ep.episode));
        setReleaseDate(ep.releaseDate || ''); store('pr_releaseDate', ep.releaseDate || '');
        setLength(ep.length || ''); store('pr_length', ep.length || '');
        setReviewer(ep.reviewer || ''); store('pr_reviewer', ep.reviewer || '');
        setGuest(ep.guest || ''); store('pr_guest', ep.guest || '');
        setShowLink(ep.showLink || ''); store('pr_showLink', ep.showLink || '');
        setArtworkLink(ep.artworkLink || ''); store('pr_artworkLink', ep.artworkLink || '');
        setLetterboxdLink(ep.letterboxdLink || ''); store('pr_letterboxdLink', ep.letterboxdLink || '');
        setImdbLink(ep.imdbLink || ''); store('pr_imdbLink', ep.imdbLink || '');
        setMmmCount(ep.mmmCount || 0); store('podreview_mmm', String(ep.mmmCount || 0));
        setTgCount(ep.thatsGreatCount || 0); store('podreview_tg', String(ep.thatsGreatCount || 0));
        setNotableMoments(ep.notableMoments || ''); store('podreview_notable', ep.notableMoments || '');
        setHFlex(ep.hFlex === 'N/A' ? '' : ep.hFlex || ''); store('podreview_hflex', ep.hFlex === 'N/A' ? '' : ep.hFlex || '');
        setJFlex(ep.jFlex === 'N/A' ? '' : ep.jFlex || ''); store('podreview_jflex', ep.jFlex === 'N/A' ? '' : ep.jFlex || '');
        setKevsQuestion(ep.kevsQuestion === 'N/A' ? '' : ep.kevsQuestion || ''); store('podreview_kevq', ep.kevsQuestion === 'N/A' ? '' : ep.kevsQuestion || '');
        setTildaH(ep.tildaH === 'N/A' ? '' : ep.tildaH || ''); store('podreview_tildah', ep.tildaH === 'N/A' ? '' : ep.tildaH || '');
        setTildaJ(ep.tildaJason === 'N/A' ? '' : ep.tildaJason || ''); store('podreview_tildaj', ep.tildaJason === 'N/A' ? '' : ep.tildaJason || '');
        setTildaGuest(ep.tildaGuest || ''); store('podreview_tildaguest', ep.tildaGuest || '');
        setTildaCorey(ep.tildaCorey || ''); store('podreview_tildacorey', ep.tildaCorey || '');
        showToast(`Loaded episode ${ep.episode}: ${ep.film}`);

        // Auto-fill missing fields from external sources
        const missingMedia = !ep.length || !ep.artworkLink || !ep.showLink;
        const missingLinks = !ep.letterboxdLink || !ep.imdbLink;

        if (ep.film && (missingMedia || missingLinks)) {
          const promises: Promise<void>[] = [];

          if (missingMedia) {
            promises.push(matchEpisodeSources(ep.film, true));
          }

          if (missingLinks && ep.tmdbId) {
            promises.push(
              fetch('/api/podreview/tmdb-search', {
                method: 'POST',
                headers,
                body: JSON.stringify({ tmdbId: ep.tmdbId }),
              }).then(r => r.json()).then(details => {
                if (details?.imdbLink && !ep.imdbLink) {
                  setImdbLink(details.imdbLink);
                  store('pr_imdbLink', details.imdbLink);
                }
                if (details?.letterboxdLink && !ep.letterboxdLink) {
                  setLetterboxdLink(details.letterboxdLink);
                  store('pr_letterboxdLink', details.letterboxdLink);
                }
              }).catch(() => {})
            );
          }

          await Promise.all(promises);
        }

        try {
          const pr = await fetch(`/api/pdc-proposals?episode=${encodeURIComponent(epId)}`, { headers });
          const pd = await pr.json();
          setProposals(
            (pd.proposals?.proposals ?? []).filter((p: { status: string }) => p.status === 'pending')
          );
        } catch {
          setProposals([]);
        }
      }
    } catch {
      showToast('Failed to load episode', 'error');
    }
  }

  function startNewEpisode() {
    clearAllFields();
    showToast('Ready for new episode');
  }

  // ── Persist helpers ──
  function setAndStore(setter: (v: string) => void, key: string) {
    return (v: string) => { setter(v); store(key, v); };
  }

  const updateFilm = setAndStore(setFilm, 'pr_film');
  const updateSeason = setAndStore(setSeason, 'pr_season');
  const updateEpisode = setAndStore(setEpisode, 'pr_episode');
  const updateReleaseDate = setAndStore(setReleaseDate, 'pr_releaseDate');
  const updateLength = setAndStore(setLength, 'pr_length');
  const updateReviewer = setAndStore(setReviewer, 'pr_reviewer');
  const updateGuest = setAndStore(setGuest, 'pr_guest');
  const updateShowLink = setAndStore(setShowLink, 'pr_showLink');
  const updateArtworkLink = setAndStore(setArtworkLink, 'pr_artworkLink');
  const updateLetterboxdLink = setAndStore(setLetterboxdLink, 'pr_letterboxdLink');
  const updateImdbLink = setAndStore(setImdbLink, 'pr_imdbLink');
  const updateNotable = setAndStore(setNotableMoments, 'podreview_notable');
  const updateHFlex = setAndStore(setHFlex, 'podreview_hflex');
  const updateJFlex = setAndStore(setJFlex, 'podreview_jflex');
  const updateKevQ = setAndStore(setKevsQuestion, 'podreview_kevq');
  const updateTildaH = setAndStore(setTildaH, 'podreview_tildah');
  const updateTildaJ = setAndStore(setTildaJ, 'podreview_tildaj');
  const updateTildaGuest = setAndStore(setTildaGuest, 'podreview_tildaguest');
  const updateTildaCorey = setAndStore(setTildaCorey, 'podreview_tildacorey');

  function updateTgCountFromProposal(v: string) {
    setTgCount(num(v));
    store('podreview_tg', v);
  }

  // ── Tier 2 proposal decisions ──
  // Typed against Tier2Column (rather than Record<string, ...>) so that
  // adding a column to TIER2_COLUMNS without a matching entry here is a
  // compile error, not a silent no-op on Accept.
  const PROPOSAL_SETTERS: Record<Tier2Column, (v: string) => void> = {
    Film: updateFilm,
    Thats_Great_Count: updateTgCountFromProposal,
    Kevs_Question: updateKevQ,
    TildaH: updateTildaH,
    TildaJason: updateTildaJ,
    TildaGuest: updateTildaGuest,
    TildaCorey: updateTildaCorey,
  };

  async function decideProposal(column: Tier2Column, status: 'accepted' | 'rejected', value?: string) {
    if (status === 'accepted' && value !== undefined) {
      PROPOSAL_SETTERS[column](value);
    }
    const removed = proposals.find(p => p.column === column);
    setProposals(prev => prev.filter(p => p.column !== column));
    try {
      const res = await fetch('/api/pdc-proposals', {
        method: 'POST',
        headers,
        body: JSON.stringify({ episode, decisions: { [column]: status } }),
      });
      if (!res.ok) {
        if (removed) setProposals(prev => [...prev, removed]);
        showToast('Could not record that decision', 'error');
      }
    } catch {
      if (removed) setProposals(prev => [...prev, removed]);
      showToast('Could not record that decision', 'error');
    }
  }

  // Counter helpers
  function incCounter(getter: number, setter: (n: number) => void, key: string) {
    const n = getter + 1;
    setter(n);
    store(key, String(n));
  }
  function decCounter(getter: number, setter: (n: number) => void, key: string) {
    const n = Math.max(0, getter - 1);
    setter(n);
    store(key, String(n));
  }
  function resetCounter(setter: (n: number) => void, key: string) {
    setter(0);
    store(key, '0');
  }

  // ── Submit ──
  async function handleSubmit() {
    if (!film.trim()) {
      showToast('Film name is required', 'error');
      return;
    }
    if (!episode) {
      showToast('Episode number is required', 'error');
      return;
    }
    if (!reviewer.trim()) {
      showToast('Reviewer name is required', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        mode: editingEpisodeId ? 'update' : 'new',
        pod: 'EH',
        season: Number(season),
        episode: /^\d+$/.test(episode) ? Number(episode) : episode,
        film,
        releaseDate,
        length,
        lengthMinutes: length ? parseLength(length) : '',
        reviewer,
        guest: guest || null,
        mmmCount,
        thatsGreatCount: tgCount,
        notableMoments,
        hFlex: hFlex || 'N/A',
        jFlex: jFlex || 'N/A',
        kevsQuestion: kevsQuestion || 'N/A',
        tildaH: tildaH || 'N/A',
        tildaJason: tildaJ || 'N/A',
        tildaGuest: tildaGuest || null,
        tildaCorey: tildaCorey || null,
        showLink,
        artworkLink,
        letterboxdLink,
        imdbLink,
        tmdbId: selectedTmdbId,
      };

      const res = await fetch('/api/podreview/submit', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const result = await res.json();
      if (res.ok) {
        showToast(result.message || 'Submitted successfully');
      } else {
        showToast(result.error || 'Submission failed', 'error', 4000);
      }
    } catch {
      showToast('Connection error', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Copy Output ──
  function copyOutput() {
    function escapeCSV(val: string): string {
      if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }

    const values = [
      'EH',
      season,
      episode,
      film,
      releaseDate,
      length,
      length ? parseLength(length) : '',
      reviewer,
      guest || '',
      String(mmmCount),
      String(tgCount),
      notableMoments,
      hFlex || '',
      jFlex || '',
      kevsQuestion || '',
      tildaH || '',
      tildaJ || '',
      tildaGuest || '',
      tildaCorey || '',
      '', // Chuckle_Hut_Favorites
      showLink,
      artworkLink,
      letterboxdLink,
      imdbLink,
    ];

    const tsv = values.map(v =>
      v.includes('\t') || v.includes('\n') || v.includes('"')
        ? '"' + v.replace(/"/g, '""') + '"'
        : v
    ).join('\t');
    navigator.clipboard.writeText(tsv).then(
      () => showToast('Copied to clipboard'),
      () => showToast('Copy failed', 'error')
    );
  }

  // ── Update PDC ──
  async function updatePdc() {
    if (!film.trim()) { showToast('Film name is required', 'error'); return; }
    if (!episode) { showToast('Episode number is required', 'error'); return; }
    if (!reviewer.trim()) { showToast('Reviewer name is required', 'error'); return; }

    setPdcUpdating(true);
    setShowPdcConfirm(false);
    try {
      const payload = {
        pod: 'EH',
        season: Number(season),
        episode: /^\d+$/.test(episode) ? Number(episode) : episode,
        film,
        releaseDate,
        length,
        lengthMinutes: length ? parseLength(length) : '',
        reviewer,
        guest: guest || null,
        mmmCount,
        thatsGreatCount: tgCount,
        notableMoments,
        hFlex: hFlex || 'N/A',
        jFlex: jFlex || 'N/A',
        kevsQuestion: kevsQuestion || 'N/A',
        tildaH: tildaH || 'N/A',
        tildaJason: tildaJ || 'N/A',
        tildaGuest: tildaGuest || null,
        tildaCorey: tildaCorey || null,
        showLink,
        artworkLink,
        letterboxdLink,
        imdbLink,
      };

      const res = await fetch('/api/podreview/update-pdc', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const result = await res.json();
      if (res.ok) {
        showToast(result.message || 'Sheet updated');
      } else {
        showToast(result.error || 'Update failed', 'error', 4000);
      }
    } catch {
      showToast('Connection error', 'error');
    } finally {
      setPdcUpdating(false);
    }
  }

  // ── Episode picker ──
  const [showEpisodePicker, setShowEpisodePicker] = useState(false);
  const [episodeFilter, setEpisodeFilter] = useState('');
  const filteredEpisodes = episodes.filter(ep => {
    if (!episodeFilter) return true;
    const q = episodeFilter.toLowerCase();
    return String(ep.episode).includes(q) || ep.film.toLowerCase().includes(q);
  });

  return (
    <>
      {/* Toast */}
      {toast && (
        <div style={{
          ...styles.toast,
          ...(toast.type === 'error' ? styles.toastError : {}),
          ...(toast.type === 'warn' ? styles.toastWarn : {}),
        }}>
          {toast.msg}
        </div>
      )}

      {/* PDC confirm overlay */}
      {showPdcConfirm && (
        <div style={styles.overlay} onClick={() => setShowPdcConfirm(false)}>
          <div style={styles.confirmBox} onClick={e => e.stopPropagation()}>
            <p style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>
              Update PDC Sheet?
            </p>
            <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, color: '#9aa7b5' }}>
              This will {editingEpisodeId ? 'update' : 'insert'} episode <strong style={{ color: '#e6edf3' }}>{episode || '?'}</strong> in the <em>Pod Data Detail</em> sheet.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => setShowPdcConfirm(false)} style={styles.btnSecondary}>Cancel</button>
              <button onClick={updatePdc} style={styles.btnPrimary}>Yes, Update</button>
            </div>
          </div>
        </div>
      )}

      {/* Reset confirm overlay */}
      {showResetConfirm && (
        <div style={styles.overlay} onClick={() => setShowResetConfirm(false)}>
          <div style={styles.confirmBox} onClick={e => e.stopPropagation()}>
            <p style={{ margin: '0 0 20px', fontSize: 15, lineHeight: 1.5, color: '#c9d5e0' }}>
              This will <strong style={{ color: '#ef4444' }}>clear all</strong> counters, notes, and form fields. Are you sure?
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => setShowResetConfirm(false)} style={styles.btnSecondary}>Cancel</button>
              <button onClick={resetAll} style={styles.btnDanger}>Yes, Reset All</button>
            </div>
          </div>
        </div>
      )}

      <div style={styles.wrap}>
        {/* Top bar */}
        <div style={styles.top}>
          <h1 style={styles.h1}>PodReview</h1>
          <div style={styles.actions}>
            <button onClick={copyOutput} style={styles.btnSecondary}>
              Copy Output
            </button>
            <button onClick={() => setShowResetConfirm(true)} style={styles.btnDanger}>
              Reset All
            </button>
          </div>
        </div>

        <ProposalsBanner
          proposals={proposals}
          onAccept={(c, v) => decideProposal(c, 'accepted', v)}
          onReject={(c) => decideProposal(c, 'rejected')}
        />

        {/* Episode picker */}
        <div style={styles.sectionLabel}>Episode</div>
        <div style={styles.card}>
          <div style={styles.cardC}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button onClick={startNewEpisode} style={styles.btnSecondary}>
                + New Episode
              </button>
              <button
                onClick={() => setShowEpisodePicker(!showEpisodePicker)}
                style={styles.btnSecondary}
              >
                Load Existing
              </button>
            </div>

            {showEpisodePicker && (
              <div style={{ marginBottom: 12 }}>
                <input
                  type="text"
                  placeholder="Filter by episode # or film name..."
                  value={episodeFilter}
                  onChange={e => setEpisodeFilter(e.target.value)}
                  style={{ ...styles.input, marginBottom: 8 }}
                />
                <div style={styles.episodeList}>
                  {filteredEpisodes.slice(0, 20).map(ep => (
                    <button
                      key={String(ep.episode)}
                      onClick={() => {
                        loadEpisode(String(ep.episode));
                        setShowEpisodePicker(false);
                        setEpisodeFilter('');
                      }}
                      style={styles.episodeItem}
                    >
                      <span style={{ fontWeight: 700 }}>E{ep.episode}</span>
                      <span style={{ flex: 1, marginLeft: 8 }}>{ep.film}</span>
                      <span style={{ color: '#4b6080', fontSize: 12 }}>{ep.reviewer}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {editingEpisodeId && (
              <div style={styles.editingBadge}>
                Editing Episode {editingEpisodeId}
              </div>
            )}
          </div>
        </div>

        {/* Film search */}
        <div style={{ ...styles.sectionLabel, marginTop: 20 }}>Film</div>
        <div style={styles.card}>
          <div style={styles.cardC}>
            <div ref={dropdownRef} style={{ position: 'relative' }}>
              <input
                type="text"
                placeholder="Search TMDB for film..."
                value={tmdbQuery}
                onChange={e => {
                  setTmdbQuery(e.target.value);
                  searchTmdb(e.target.value);
                }}
                onFocus={() => { if (tmdbResults.length > 0) setShowTmdbDropdown(true); }}
                style={styles.input}
              />
              {tmdbLoading && <div style={styles.tmdbSpinner}>Searching...</div>}
              {showTmdbDropdown && tmdbResults.length > 0 && (
                <div style={styles.tmdbDropdown}>
                  {tmdbResults.map(r => (
                    <button
                      key={r.id}
                      onClick={() => selectTmdbResult(r)}
                      style={styles.tmdbItem}
                    >
                      {r.posterPath && (
                        <img src={r.posterPath} alt="" style={styles.tmdbPoster} />
                      )}
                      <div>
                        <div style={{ fontWeight: 600 }}>{r.title}</div>
                        <div style={{ fontSize: 12, color: '#4b6080' }}>{r.year || 'Unknown year'}</div>
                      </div>
                    </button>
                  ))}
                  <button onClick={useCustomFilmName} style={styles.tmdbCustom}>
                    Use &quot;{tmdbQuery}&quot; as custom name
                  </button>
                </div>
              )}
            </div>

            {film && (
              <div style={{ marginTop: 8, fontSize: 13, color: '#9aa7b5' }}>
                Selected: <strong style={{ color: '#e6edf3' }}>{film}</strong>
                {selectedTmdbId && <span> (TMDB #{selectedTmdbId})</span>}
              </div>
            )}
          </div>
        </div>

        {/* Episode details */}
        <div style={{ ...styles.sectionLabel, marginTop: 20 }}>Details</div>
        <div style={styles.card}>
          <div style={styles.cardC}>
            <div style={styles.fieldGrid}>
              <Field label="Season" value={season} onChange={updateSeason} small />
              <Field label="Episode #" value={episode} onChange={updateEpisode} small />
              <Field label="Release Date" value={releaseDate} onChange={updateReleaseDate}
                placeholder="e.g. 3/5/2026" small />
            </div>
            <div style={styles.fieldGrid}>
              <Field label="Reviewer" value={reviewer} onChange={updateReviewer} />
            </div>
            <GuestInput value={guest} onChange={updateGuest} suggestions={allGuests} />
            <div style={styles.fieldGrid}>
              <Field label="Length (H:MM:SS)" value={length} onChange={updateLength}
                placeholder="e.g. 2:07:25" />
              <Field label="Show Link" value={showLink} onChange={updateShowLink}
                placeholder="Patreon URL" />
            </div>
            <div style={styles.fieldGrid}>
              <Field label="Artwork Link" value={artworkLink} onChange={updateArtworkLink}
                placeholder="URL" />
            </div>
            <div style={styles.fieldGrid}>
              <Field label="Letterboxd Link" value={letterboxdLink} onChange={updateLetterboxdLink}
                placeholder="Auto-filled from TMDB" />
              <Field label="IMDB Link" value={imdbLink} onChange={updateImdbLink}
                placeholder="Auto-filled from TMDB" />
            </div>
          </div>
        </div>

        {/* Counters */}
        <div style={{ ...styles.sectionLabel, marginTop: 20 }}>Counters</div>
        <div style={styles.counterRow}>
          <Counter
            label="MMM"
            count={mmmCount}
            onInc={() => incCounter(mmmCount, setMmmCount, 'podreview_mmm')}
            onDec={() => decCounter(mmmCount, setMmmCount, 'podreview_mmm')}
            onReset={() => resetCounter(setMmmCount, 'podreview_mmm')}
            onSet={n => { setMmmCount(n); store('podreview_mmm', String(n)); }}
          />
          <Counter
            label="TG"
            count={tgCount}
            onInc={() => incCounter(tgCount, setTgCount, 'podreview_tg')}
            onDec={() => decCounter(tgCount, setTgCount, 'podreview_tg')}
            onReset={() => resetCounter(setTgCount, 'podreview_tg')}
            onSet={n => { setTgCount(n); store('podreview_tg', String(n)); }}
          />
        </div>

        {/* Notes */}
        <div style={{ ...styles.sectionLabel, marginTop: 20 }}>Notes</div>
        <div style={styles.notesSection}>
          <TextArea label="Notable Moments" value={notableMoments} onChange={updateNotable}
            maxLength={5000} placeholder="Type notable moments..." />
          <TextArea label="H Flex" value={hFlex} onChange={updateHFlex} maxLength={200} />
          <TextArea label="J Flex" value={jFlex} onChange={updateJFlex} maxLength={200} />
          <TextArea label="Kev&apos;s Question" value={kevsQuestion} onChange={updateKevQ} maxLength={500} />
          <TextArea label="Tilda H" value={tildaH} onChange={updateTildaH} maxLength={200} />
          <TextArea label="Tilda J" value={tildaJ} onChange={updateTildaJ} maxLength={200} />
          <TextArea label="Tilda Guest" value={tildaGuest} onChange={updateTildaGuest} maxLength={200} />
          <TextArea label="Tilda Corey" value={tildaCorey} onChange={updateTildaCorey} maxLength={200} />
        </div>

        {/* Bottom actions */}
        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'center' }}>
          <button
            onClick={() => setShowPdcConfirm(true)}
            disabled={pdcUpdating}
            style={{ ...styles.btnPrimary, padding: '12px 28px', fontSize: 15 }}
          >
            {pdcUpdating ? 'Updating...' : 'Update PDC'}
          </button>
          <button onClick={copyOutput} style={{ ...styles.btnSecondary, padding: '12px 20px' }}>
            Copy Output
          </button>
        </div>

        <footer style={styles.footer}>
          <span>Data persists locally between sessions</span>
        </footer>
      </div>
    </>
  );
}

// ── Sub-components ──

function ProposalsBanner({
  proposals,
  onAccept,
  onReject,
}: {
  proposals: Array<{ column: Tier2Column; proposed: string; current: string | null; confidence: string; evidence?: string }>;
  onAccept: (column: Tier2Column, value: string) => void;
  onReject: (column: Tier2Column) => void;
}) {
  if (proposals.length === 0) return null;
  return (
    <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <h3 className="mb-1 text-sm font-semibold text-amber-900">
        {proposals.length} proposal{proposals.length === 1 ? '' : 's'} from the transcript
      </h3>
      <p className="mb-3 text-xs text-amber-800">
        Nothing is written to the sheet until you accept and save.
      </p>
      <div className="space-y-3">
        {proposals.map((p) => (
          <div key={p.column} className="rounded border border-amber-200 bg-white p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-xs font-semibold">{p.column}</span>
              {p.confidence === 'low' && (
                <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] uppercase text-gray-700">
                  low confidence
                </span>
              )}
            </div>
            <div className="mb-1 text-sm">
              <span className="text-gray-500">now: </span>
              <span className="text-gray-700">{p.current ?? '(blank)'}</span>
            </div>
            <div className="mb-2 text-sm">
              <span className="text-gray-500">proposed: </span>
              <span className="font-medium text-gray-900">{p.proposed}</span>
            </div>
            {p.evidence && (
              <div className="mb-2 border-l-2 border-gray-200 pl-2 text-xs italic text-gray-600">
                {p.evidence}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onAccept(p.column, p.proposed)}
                className="rounded bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => onReject(p.column)}
                className="rounded bg-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-300"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, small }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; small?: boolean;
}) {
  return (
    <div style={{ flex: small ? '1 1 0' : '1 1 auto', minWidth: small ? 80 : 200 }}>
      <label style={styles.fieldLabel}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || ''}
        style={styles.input}
      />
    </div>
  );
}

function GuestInput({ value, onChange, suggestions }: {
  value: string; onChange: (v: string) => void; suggestions: string[];
}) {
  const [inputVal, setInputVal] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Parse " / "-separated string into array of chips
  const chips = value ? value.split(/\s*\/\s*/).filter(Boolean) : [];

  function setChips(newChips: string[]) {
    onChange(newChips.join(' / '));
  }

  function addGuest(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (chips.some(c => c.toLowerCase() === trimmed.toLowerCase())) return;
    setChips([...chips, trimmed]);
    setInputVal('');
    setShowSuggestions(false);
    setHighlightIdx(-1);
    inputRef.current?.focus();
  }

  function removeGuest(idx: number) {
    setChips(chips.filter((_, i) => i !== idx));
  }

  const filtered = inputVal.trim().length > 0
    ? suggestions.filter(s =>
        s.toLowerCase().includes(inputVal.toLowerCase()) &&
        !chips.some(c => c.toLowerCase() === s.toLowerCase())
      )
    : [];

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < filtered.length) {
        addGuest(filtered[highlightIdx]);
      } else if (inputVal.trim()) {
        addGuest(inputVal);
      }
    } else if (e.key === 'Backspace' && !inputVal && chips.length > 0) {
      removeGuest(chips.length - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <label style={styles.fieldLabel}>Guest</label>
      <div
        style={styles.chipWrap}
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((c, i) => (
          <span key={i} style={styles.chip}>
            {c}
            <button
              onClick={e => { e.stopPropagation(); removeGuest(i); }}
              style={styles.chipX}
              aria-label={`Remove ${c}`}
            >&times;</button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputVal}
          onChange={e => {
            setInputVal(e.target.value);
            setShowSuggestions(true);
            setHighlightIdx(-1);
          }}
          onFocus={() => { if (filtered.length > 0) setShowSuggestions(true); }}
          onKeyDown={handleKeyDown}
          placeholder={chips.length === 0 ? 'Type guest name...' : ''}
          style={styles.chipInput}
        />
      </div>
      {showSuggestions && filtered.length > 0 && (
        <div style={styles.suggestionList}>
          {filtered.slice(0, 8).map((s, i) => (
            <button
              key={s}
              onMouseDown={e => { e.preventDefault(); addGuest(s); }}
              style={{
                ...styles.suggestionItem,
                ...(i === highlightIdx ? styles.suggestionItemActive : {}),
              }}
            >{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function Counter({ label, count, onInc, onDec, onReset, onSet }: {
  label: string; count: number; onInc: () => void; onDec: () => void; onReset: () => void; onSet: (n: number) => void;
}) {
  return (
    <div style={styles.card}>
      <div style={styles.cardH}>
        <span style={styles.cardTitle}>{label}</span>
        <button onClick={onReset} style={styles.btnResetSm}>Reset</button>
      </div>
      <div style={styles.cardC}>
        <div style={styles.counterLayout}>
          <input
            type="number"
            value={count}
            onChange={e => {
              const v = parseInt(e.target.value);
              onSet(isNaN(v) ? 0 : Math.max(0, v));
            }}
            style={styles.countInput}
            min={0}
          />
          <div style={styles.counterBtns}>
            <button onClick={onDec} style={styles.btnDec}>-</button>
            <button onClick={onInc} style={styles.btnInc}>+</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TextArea({ label, value, onChange, maxLength, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  maxLength: number; placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function handleInput(val: string) {
    onChange(val);
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = Math.min(ref.current.scrollHeight, window.innerHeight * 0.6) + 'px';
    }
  }

  useEffect(() => {
    if (ref.current && value) {
      ref.current.style.height = 'auto';
      ref.current.style.height = Math.min(ref.current.scrollHeight, window.innerHeight * 0.6) + 'px';
    }
  }, [value]);

  return (
    <div style={styles.entry}>
      <label style={styles.entryLabel}>{label}</label>
      <textarea
        ref={ref}
        value={value}
        onChange={e => handleInput(e.target.value)}
        maxLength={maxLength}
        placeholder={placeholder || 'Type here...'}
        style={styles.textarea}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            const el = e.currentTarget;
            const s = el.selectionStart || 0;
            const end = el.selectionEnd || 0;
            const newVal = value.slice(0, s) + '\n\n' + value.slice(end);
            handleInput(newVal);
            setTimeout(() => { el.selectionStart = el.selectionEnd = s + 2; }, 0);
          }
        }}
      />
      <div style={styles.meta}>
        <span>{value.length}/{maxLength}</span>
      </div>
    </div>
  );
}

// ── Styles ──

const styles: Record<string, React.CSSProperties> = {
  authWrap: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh',
    background: 'linear-gradient(180deg, #0b0f14, #0a1220 60%)',
    color: '#e6edf3',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  authForm: {
    display: 'flex', flexDirection: 'column', gap: 16,
    padding: 32, borderRadius: 18,
    background: 'radial-gradient(120% 120% at 0% 0%, #0d1627, #0f1623)',
    border: '1px solid #1f2a3a',
    boxShadow: '0 10px 30px rgba(0,0,0,.35)',
    minWidth: 280,
  },
  wrap: {
    maxWidth: 640, margin: '32px auto', padding: '0 16px 32px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#e6edf3',
  },
  top: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, marginBottom: 20,
  },
  h1: { margin: 0, fontSize: 'clamp(18px, 2.8vw, 24px)', letterSpacing: '-0.01em' },
  actions: { display: 'flex', gap: 8 },
  sectionLabel: {
    fontSize: 10, fontWeight: 700, letterSpacing: '.12em',
    textTransform: 'uppercase' as const, color: '#4b6080', margin: '0 2px 8px',
  },
  card: {
    background: 'radial-gradient(120% 120% at 0% 0%, #0d1627, #0f1623)',
    border: '1px solid #1f2a3a', borderRadius: 18,
    boxShadow: '0 10px 30px rgba(0,0,0,.35)', marginBottom: 8,
  },
  cardH: {
    padding: '14px 18px 8px', borderBottom: '1px solid #1b2533',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  cardTitle: { fontSize: 15, fontWeight: 700, letterSpacing: '.2px' },
  cardC: { padding: '16px 18px 20px' },
  counterRow: { display: 'flex', gap: 16, marginBottom: 8 },
  counterLayout: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  },
  count: {
    fontSize: 64, fontWeight: 800, letterSpacing: '.02em', lineHeight: 1, minWidth: 60,
  },
  countInput: {
    fontSize: 48, fontWeight: 800, lineHeight: 1, minWidth: 60, width: 80,
    background: 'transparent', color: '#e6edf3', border: 'none', borderBottom: '2px solid #273043',
    textAlign: 'center' as const, fontFamily: 'inherit', outline: 'none',
    appearance: 'textfield' as const, MozAppearance: 'textfield' as const,
  },
  counterBtns: { display: 'flex', gap: 10, alignItems: 'center' },
  btnPrimary: {
    appearance: 'none' as const, border: '1px solid #334155',
    background: '#3b82f6', color: '#fff',
    padding: '10px 16px', borderRadius: 14, fontWeight: 600, fontSize: 14,
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  btnSecondary: {
    appearance: 'none' as const, border: '1px solid #334155',
    background: '#1f2937', color: '#e6edf3',
    padding: '8px 14px', borderRadius: 12, fontWeight: 600, fontSize: 13,
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  btnInc: {
    appearance: 'none' as const, border: '1px solid #3b82f6', background: '#3b82f6',
    color: '#fff', width: 52, height: 52, borderRadius: 14,
    fontSize: 22, fontWeight: 700, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  btnDec: {
    appearance: 'none' as const, border: '1px solid #334155', background: '#1f2937',
    color: '#e6edf3', width: 52, height: 52, borderRadius: 14,
    fontSize: 26, fontWeight: 700, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  btnResetSm: {
    appearance: 'none' as const, fontSize: 11, padding: '5px 10px', borderRadius: 8,
    background: 'transparent', border: '1px solid #334155', color: '#9aa7b5',
    cursor: 'pointer',
  },
  input: {
    width: '100%', boxSizing: 'border-box' as const,
    background: '#0f1726', color: '#e6edf3',
    border: '1px solid #273043', borderRadius: 10,
    padding: '10px 12px', fontSize: 14, fontFamily: 'inherit',
    outline: 'none',
  },
  fieldLabel: {
    display: 'block', fontWeight: 600, fontSize: 12,
    margin: '0 2px 4px', color: '#9aa7b5',
  },
  fieldGrid: {
    display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' as const,
  },
  notesSection: {
    background: 'rgba(15, 22, 35, 0.5)', border: '1px solid #1a2535',
    borderRadius: 20, padding: 16,
    display: 'flex', flexDirection: 'column' as const, gap: 12,
  },
  entry: {
    background: 'linear-gradient(180deg, #121826, #0c1220)',
    border: '1px solid #1f2a3a', borderRadius: 14, padding: '12px 14px 10px',
  },
  entryLabel: {
    display: 'block', fontWeight: 700, fontSize: 13,
    margin: '0 2px 8px', color: '#c9d5e0',
  },
  textarea: {
    width: '100%', boxSizing: 'border-box' as const,
    background: '#0f1726', color: '#e6edf3',
    border: '1px solid #273043', borderRadius: 10,
    padding: '10px 12px', resize: 'none' as const,
    lineHeight: 1.5, fontSize: 14, fontFamily: 'inherit',
    minHeight: 44, maxHeight: '60vh', overflowY: 'auto' as const,
    outline: 'none',
  },
  meta: {
    display: 'flex', justifyContent: 'flex-end',
    color: '#4b6080', fontSize: 11, marginTop: 5,
  },
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    color: '#4b6080', fontSize: 11, marginTop: 14, padding: '0 2px',
  },
  toast: {
    position: 'fixed' as const, bottom: 28, left: '50%',
    transform: 'translateX(-50%)',
    background: '#1e3a5f', border: '1px solid #3b82f6',
    color: '#e6edf3', padding: '10px 20px', borderRadius: 12,
    fontSize: 13, fontWeight: 600, zIndex: 9999, whiteSpace: 'nowrap' as const,
  },
  toastError: { background: '#3f1a1a', borderColor: '#ef4444' },
  toastWarn: { background: '#3a2e10', borderColor: '#f59e0b' },
  btnDanger: {
    appearance: 'none' as const, border: '1px solid #ef4444',
    background: '#ef4444', color: '#fff',
    padding: '10px 16px', borderRadius: 14, fontWeight: 600, fontSize: 14,
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  overlay: {
    position: 'fixed' as const, inset: 0,
    background: 'rgba(0,0,0,.65)', zIndex: 9998,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  confirmBox: {
    background: '#0d1627', border: '1px solid #334155', borderRadius: 18,
    padding: '28px 32px', maxWidth: 320, width: '90%', textAlign: 'center' as const,
    boxShadow: '0 20px 60px rgba(0,0,0,.6)',
  },
  chipWrap: {
    display: 'flex', flexWrap: 'wrap' as const, gap: 6,
    alignItems: 'center',
    background: '#0f1726', border: '1px solid #273043', borderRadius: 10,
    padding: '6px 10px', minHeight: 40, cursor: 'text',
  },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: '#1e3a5f', border: '1px solid #3b82f6', borderRadius: 6,
    padding: '3px 8px', fontSize: 13, fontWeight: 500, color: '#93c5fd',
    whiteSpace: 'nowrap' as const,
  },
  chipX: {
    appearance: 'none' as const, background: 'none', border: 'none',
    color: '#6b9bd2', cursor: 'pointer', fontSize: 15, fontWeight: 700,
    padding: '0 0 0 2px', lineHeight: 1,
  },
  chipInput: {
    flex: 1, minWidth: 80, background: 'transparent', border: 'none',
    color: '#e6edf3', fontSize: 14, fontFamily: 'inherit', outline: 'none',
    padding: '4px 0',
  },
  suggestionList: {
    position: 'absolute' as const, top: '100%', left: 0, right: 0,
    background: '#0d1627', border: '1px solid #1f2a3a', borderRadius: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,.5)', zIndex: 100,
    maxHeight: 200, overflowY: 'auto' as const, marginTop: 4,
  },
  suggestionItem: {
    display: 'block', width: '100%', padding: '8px 14px',
    background: 'transparent', border: 'none', borderBottom: '1px solid #1b2533',
    color: '#e6edf3', cursor: 'pointer', textAlign: 'left' as const,
    fontFamily: 'inherit', fontSize: 13,
  },
  suggestionItemActive: {
    background: '#1e3a5f',
  },
  errorText: { color: '#ef4444', fontSize: 13 },
  editingBadge: {
    display: 'inline-block', padding: '4px 10px', borderRadius: 8,
    background: '#1e3a5f', border: '1px solid #3b82f6',
    fontSize: 12, fontWeight: 600, color: '#93c5fd',
  },
  tmdbSpinner: {
    position: 'absolute' as const, right: 12, top: 10,
    fontSize: 12, color: '#4b6080',
  },
  tmdbDropdown: {
    position: 'absolute' as const, top: '100%', left: 0, right: 0,
    background: '#0d1627', border: '1px solid #1f2a3a', borderRadius: 12,
    boxShadow: '0 10px 30px rgba(0,0,0,.5)', zIndex: 100,
    maxHeight: 320, overflowY: 'auto' as const, marginTop: 4,
  },
  tmdbItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    width: '100%', padding: '10px 14px',
    background: 'transparent', border: 'none', borderBottom: '1px solid #1b2533',
    color: '#e6edf3', cursor: 'pointer', textAlign: 'left' as const,
    fontFamily: 'inherit', fontSize: 14,
  },
  tmdbPoster: {
    width: 32, height: 48, objectFit: 'cover' as const, borderRadius: 4,
  },
  tmdbCustom: {
    width: '100%', padding: '10px 14px',
    background: 'transparent', border: 'none',
    color: '#3b82f6', cursor: 'pointer', textAlign: 'left' as const,
    fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
  },
  episodeList: {
    maxHeight: 240, overflowY: 'auto' as const,
    border: '1px solid #1f2a3a', borderRadius: 12,
    background: '#0d1627',
  },
  episodeItem: {
    display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '8px 14px',
    background: 'transparent', border: 'none', borderBottom: '1px solid #1b2533',
    color: '#e6edf3', cursor: 'pointer', textAlign: 'left' as const,
    fontFamily: 'inherit', fontSize: 13,
  },
};
