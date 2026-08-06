'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { DialogueEntry } from '@/types/transcript';
import { useAudioSync } from '@/hooks/useAudioSync';
import AudioPlayer from '@/components/AudioPlayer';
import { secondsToTimestamp } from '@/lib/timestamps';
import {
  buildSegmentMeta,
  isInterjection,
  isSampleCandidate,
  isSounderCandidate,
} from '@/lib/reviewHeuristics';
import {
  proposeSpeakerMapping,
  CONTAMINANT_SPEAKER,
  type SpeakerProposal,
} from '@/lib/speaker-proposal';

interface SpeakerMapperProps {
  dialogues: DialogueEntry[];
  audioUrl: string | null;
  onMappingComplete: (mappedDialogues: DialogueEntry[]) => void;
  onCancel: () => void;
  guestName?: string | null;
  episodeName?: string | null;
}

interface HistoryEntry {
  dialogues: DialogueEntry[];
  description: string;
}

interface DialogueBlock {
  indices: number[];
  name: string;
  start: number;
  end: number;
  textPreview: string;
}

const PAGE_SIZE = 50;

const HOST_SPEAKERS = ['Matt Haitch', 'Jason Goldman'];
const DEFAULT_VOICEMAILERS = [
  'Corey',
  'kev voicemail',
  'birria',
  'Mr Java',
  'Lizzen',
  'Animal Mother',
  'Ethan',
];
const CATEGORY_SPEAKERS = [
  'Sounder/FX',
  'Movie Sample',
  'Voicemail (Unknown)',
  'Overtalk/Interjection',
];

const VIEW_MODE_KEY = 'review.viewMode';
const HIDE_INTERJECTIONS_KEY = 'review.hideInterjections';
const HIGHLIGHT_SAMPLES_KEY = 'review.highlightSamples';
const RECENT_SPEAKERS_KEY = 'review.roster.recent';

const readStored = <T,>(key: string, fallback: T): T => {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const writeStored = (key: string, value: unknown) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors
  }
};

export default function SpeakerMapper({
  dialogues: initialDialogues,
  audioUrl,
  onMappingComplete,
  onCancel,
  guestName,
  episodeName,
}: SpeakerMapperProps) {
  // State
  const [dialogues, setDialogues] = useState<DialogueEntry[]>(initialDialogues);
  const [currentPage, setCurrentPage] = useState(1);
  const [recentSpeakers, setRecentSpeakers] = useState<string[]>(() =>
    readStored<string[]>(RECENT_SPEAKERS_KEY, [])
  );

  // Mapping mode state
  const [activeMappingLabel, setActiveMappingLabel] = useState<string | null>(null);
  const [excludedIndices, setExcludedIndices] = useState<Set<number>>(new Set());
  const [customSpeaker, setCustomSpeaker] = useState('');

  // Individual selection state
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  // Filter state
  const [speakerFilter, setSpeakerFilter] = useState<string>('all');
  const [focusRange, setFocusRange] = useState<{ start: number; end: number } | null>(null);
  const [rangeStartInput, setRangeStartInput] = useState('');
  const [rangeEndInput, setRangeEndInput] = useState('');
  const [viewMode, setViewMode] = useState<'segments' | 'blocks'>(() =>
    readStored<'segments' | 'blocks'>(VIEW_MODE_KEY, 'segments')
  );
  const [hideInterjections, setHideInterjections] = useState<boolean>(() =>
    readStored<boolean>(HIDE_INTERJECTIONS_KEY, false)
  );
  const [highlightSamples, setHighlightSamples] = useState<boolean>(() =>
    readStored<boolean>(HIGHLIGHT_SAMPLES_KEY, true)
  );
  // Sample detection state
  const [detectingSamples, setDetectingSamples] = useState(false);
  const [detectedSampleCount, setDetectedSampleCount] = useState<number | null>(null);
  // Undo/redo history
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Refs
  const customInputRef = useRef<HTMLInputElement>(null);
  const sounderAutoAppliedRef = useRef(false);

  // Auto-proposal. `originalLabels` is the raw diarization label per turn,
  // snapshotted before the proposal renames anything — panel rows re-apply
  // against it so renaming stays a one-click bulk operation afterwards.
  const [proposal, setProposal] = useState<SpeakerProposal | null>(null);
  const originalLabelsRef = useRef<string[]>([]);
  const proposalAppliedRef = useRef(false);

  // Audio sync
  const { state: audioState, controls, setAudioRef } = useAudioSync(dialogues);

  useEffect(() => {
    sounderAutoAppliedRef.current = false;
  }, [initialDialogues]);

  const segmentMeta = useMemo(
    () => buildSegmentMeta(dialogues, audioState.duration),
    [dialogues, audioState.duration]
  );

  const totalDuration = useMemo(() => {
    if (!segmentMeta.length) return 0;
    return segmentMeta[segmentMeta.length - 1].end;
  }, [segmentMeta]);

  const primaryShortcuts = useMemo(() => {
    const shortcuts: string[] = [...HOST_SPEAKERS];
    if (guestName && guestName.trim()) {
      shortcuts.push(guestName.trim());
    }
    for (const fallback of DEFAULT_VOICEMAILERS) {
      if (shortcuts.length >= 6) break;
      if (!shortcuts.includes(fallback)) {
        shortcuts.push(fallback);
      }
    }
    return shortcuts.slice(0, 6);
  }, [guestName]);

  const voicemailSpeakers = useMemo(() => {
    const merged = [...DEFAULT_VOICEMAILERS];
    for (const name of recentSpeakers) {
      if (
        !merged.includes(name) &&
        !primaryShortcuts.includes(name) &&
        !CATEGORY_SPEAKERS.includes(name)
      ) {
        merged.push(name);
      }
    }
    return merged;
  }, [recentSpeakers, primaryShortcuts]);

  const speakerSuggestions = useMemo(() => {
    const merged = [
      ...primaryShortcuts,
      ...voicemailSpeakers,
      ...CATEGORY_SPEAKERS,
      ...recentSpeakers,
    ];
    return Array.from(new Set(merged.filter(Boolean)));
  }, [primaryShortcuts, voicemailSpeakers, recentSpeakers]);

  const computeVisibleIndices = useCallback(
    (rangeOverride?: { start: number; end: number } | null) => {
      const indices: number[] = [];
      const range = typeof rangeOverride === 'undefined' ? focusRange : rangeOverride;

      for (let i = 0; i < dialogues.length; i++) {
        if (speakerFilter !== 'all' && dialogues[i].name !== speakerFilter) continue;

        const meta = segmentMeta[i];
        if (hideInterjections && meta && isInterjection(dialogues[i].text, meta.duration)) continue;

        if (range && meta) {
          if (meta.start < range.start || meta.start > range.end) continue;
        }

        indices.push(i);
      }

      return indices;
    },
    [dialogues, focusRange, hideInterjections, segmentMeta, speakerFilter]
  );

  const visibleIndices = useMemo(() => computeVisibleIndices(), [computeVisibleIndices]);
  const segmentStartIndex = (currentPage - 1) * PAGE_SIZE;
  const segmentEndIndex = Math.min(segmentStartIndex + PAGE_SIZE, visibleIndices.length);
  const pageIndices = useMemo(
    () => visibleIndices.slice(segmentStartIndex, segmentEndIndex),
    [visibleIndices, segmentStartIndex, segmentEndIndex]
  );
  const pageDialogues = useMemo(
    () => pageIndices.map((i) => dialogues[i]),
    [pageIndices, dialogues]
  );

  // Count unique speakers detected
  const detectedSpeakers = useMemo(() => {
    const speakers = new Set<string>();
    for (const d of dialogues) {
      speakers.add(d.name);
    }
    return speakers.size;
  }, [dialogues]);

  // Get unique speaker labels for quick buttons and filter
  const uniqueSpeakerLabels = useMemo(() => {
    const labelCounts = new Map<string, number>();
    for (const d of dialogues) {
      labelCounts.set(d.name, (labelCounts.get(d.name) || 0) + 1);
    }
    return Array.from(labelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [dialogues]);

  // Check if a speaker label looks like a placeholder (e.g., "Speaker A")
  const isPlaceholderLabel = useCallback((name: string) => {
    return /^(Speaker\s*)?[A-Z]$/i.test(name);
  }, []);

  // Count unassigned segments (placeholder speakers)
  const unassignedCount = useMemo(() => {
    return dialogues.filter(d => isPlaceholderLabel(d.name)).length;
  }, [dialogues, isPlaceholderLabel]);

  const isFilterActive = speakerFilter !== 'all' || focusRange !== null || hideInterjections;
  const mappingScopeVisible = isFilterActive;

  // Segments in scope for mapping (matching label, not excluded)
  const segmentsInScope = useMemo(() => {
    if (!activeMappingLabel) return new Set<number>();
    const indices = new Set<number>();
    const visibleSet = mappingScopeVisible ? new Set(visibleIndices) : null;
    dialogues.forEach((d, i) => {
      if (
        d.name === activeMappingLabel &&
        !excludedIndices.has(i) &&
        (!visibleSet || visibleSet.has(i))
      ) {
        indices.add(i);
      }
    });
    return indices;
  }, [dialogues, activeMappingLabel, excludedIndices, mappingScopeVisible, visibleIndices]);

  // Total segments matching the active label
  const totalMatchingSegments = useMemo(() => {
    if (!activeMappingLabel) return 0;
    return dialogues.filter(d => d.name === activeMappingLabel).length;
  }, [dialogues, activeMappingLabel]);

  const visibleMatchingSegments = useMemo(() => {
    if (!activeMappingLabel) return 0;
    return visibleIndices.filter(i => dialogues[i].name === activeMappingLabel).length;
  }, [visibleIndices, dialogues, activeMappingLabel]);

  const sounderCandidates = useMemo(() => {
    const indices: number[] = [];
    for (let i = 0; i < Math.min(2, dialogues.length); i++) {
      if (isPlaceholderLabel(dialogues[i].name) && isSounderCandidate(dialogues[i], i)) {
        indices.push(i);
      }
    }
    return indices;
  }, [dialogues, isPlaceholderLabel]);

  const blocks = useMemo<DialogueBlock[]>(() => {
    if (visibleIndices.length === 0) return [];

    const result: DialogueBlock[] = [];
    let current: DialogueBlock | null = null;
    let lastIndex = -1;
    let lastEnd = 0;

    for (const idx of visibleIndices) {
      const meta = segmentMeta[idx];
      const start = meta ? meta.start : 0;
      const end = meta ? meta.end : start;
      const gap = idx === lastIndex + 1 ? start - lastEnd : Number.POSITIVE_INFINITY;

      if (current && dialogues[idx].name === current.name && gap <= 4) {
        current.indices.push(idx);
        current.end = end;
        lastIndex = idx;
        lastEnd = end;
        continue;
      }

      if (current) {
        result.push(current);
      }

      current = {
        indices: [idx],
        name: dialogues[idx].name,
        start,
        end,
        textPreview: dialogues[idx].text,
      };
      lastIndex = idx;
      lastEnd = end;
    }

    if (current) {
      result.push(current);
    }

    return result;
  }, [visibleIndices, dialogues, segmentMeta]);

  const pageBlocks = useMemo(() => {
    const blockStart = (currentPage - 1) * PAGE_SIZE;
    return blocks.slice(blockStart, blockStart + PAGE_SIZE);
  }, [blocks, currentPage]);

  const effectiveTotalPages = useMemo(() => {
    const count = viewMode === 'blocks' ? blocks.length : visibleIndices.length;
    return Math.max(1, Math.ceil(count / PAGE_SIZE));
  }, [blocks.length, visibleIndices.length, viewMode]);

  useEffect(() => {
    setCurrentPage((prev) => Math.min(prev, effectiveTotalPages));
  }, [effectiveTotalPages]);

  useEffect(() => {
    writeStored(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    writeStored(HIDE_INTERJECTIONS_KEY, hideInterjections);
  }, [hideInterjections]);

  useEffect(() => {
    writeStored(HIGHLIGHT_SAMPLES_KEY, highlightSamples);
  }, [highlightSamples]);

  useEffect(() => {
    writeStored(RECENT_SPEAKERS_KEY, recentSpeakers);
  }, [recentSpeakers]);

  // Save to history before making changes
  const saveToHistory = useCallback((description: string) => {
    setHistory(prev => {
      // Remove any future history if we're not at the end
      const newHistory = prev.slice(0, historyIndex + 1);
      // Add current state
      newHistory.push({ dialogues: [...dialogues], description });
      // Limit history size
      if (newHistory.length > 20) {
        newHistory.shift();
        return newHistory;
      }
      return newHistory;
    });
    setHistoryIndex(prev => Math.min(prev + 1, 19));
  }, [dialogues, historyIndex]);

  const trackRecentSpeaker = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setRecentSpeakers((prev) => {
      const next = [trimmed, ...prev.filter((n) => n !== trimmed)];
      return next.slice(0, 8);
    });
  }, []);

  const applySpeakerToIndices = useCallback(
    (indices: Set<number> | number[], newSpeakerName: string, description?: string) => {
      const trimmed = newSpeakerName.trim();
      if (!trimmed) return;
      const indexSet = indices instanceof Set ? indices : new Set(indices);
      if (indexSet.size === 0) return;

      saveToHistory(description || `Assign "${trimmed}" to ${indexSet.size} segment(s)`);

      setDialogues((prev) =>
        prev.map((d, i) => (indexSet.has(i) ? { ...d, name: trimmed } : d))
      );
      trackRecentSpeaker(trimmed);
    },
    [saveToHistory, trackRecentSpeaker]
  );

  // Re-assign every turn whose ORIGINAL diarization label matches, so a panel
  // row still bulk-renames after the proposal has already changed the names.
  const renameProposedLabel = useCallback(
    (originalLabel: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;
      const indices = originalLabelsRef.current
        .map((label, i) => (label === originalLabel ? i : -1))
        .filter((i) => i >= 0);
      if (indices.length === 0) return;
      applySpeakerToIndices(indices, trimmed, `Rename ${originalLabel} → ${trimmed}`);
      setProposal((prev) =>
        prev
          ? {
              ...prev,
              labels: prev.labels.map((l) =>
                l.label === originalLabel
                  ? { ...l, proposedName: trimmed, confidence: 'high', warnings: [] }
                  : l,
              ),
            }
          : prev,
      );
    },
    [applySpeakerToIndices],
  );

  useEffect(() => {
    if (sounderAutoAppliedRef.current) return;
    if (sounderCandidates.length === 0) return;
    sounderAutoAppliedRef.current = true;
    applySpeakerToIndices(sounderCandidates, 'Sounder/FX', 'Auto-detect sounder');
  }, [sounderCandidates, applySpeakerToIndices]);

  // Propose a mapping once, on mount, as a SINGLE history entry so Ctrl+Z
  // reverts the whole proposal at once.
  //
  // Guarded on placeholder labels: /review/new?load= feeds this component an
  // already-mapped transcript, and re-running the proposal there would be
  // destructive — it would re-classify "birria" as a caller label and re-strip
  // turns a human already corrected by hand.
  useEffect(() => {
    if (proposalAppliedRef.current) return;
    if (initialDialogues.length === 0) return;

    const placeholders = initialDialogues.filter((d) => isPlaceholderLabel(d.name)).length;
    if (placeholders < initialDialogues.length / 2) return;

    proposalAppliedRef.current = true;
    originalLabelsRef.current = initialDialogues.map((d) => d.name);

    const result = proposeSpeakerMapping(initialDialogues, { guestName });
    setProposal(result);
    if (result.degenerate) return;

    const renames = new Map<string, string>();
    for (const label of result.labels) {
      if (label.proposedName) renames.set(label.label, label.proposedName);
    }
    const contaminated = new Set(result.contaminants.map((c) => c.index));
    if (renames.size === 0 && contaminated.size === 0) return;

    saveToHistory(`Auto-proposed mapping (${renames.size} speakers, ${contaminated.size} stray turns)`);
    setDialogues((prev) =>
      prev.map((d, i) => {
        if (contaminated.has(i)) return { ...d, name: CONTAMINANT_SPEAKER };
        const proposed = renames.get(d.name);
        return proposed ? { ...d, name: proposed } : d;
      }),
    );
  }, [initialDialogues, guestName, isPlaceholderLabel, saveToHistory]);

  // Undo
  const undo = useCallback(() => {
    if (historyIndex >= 0) {
      const entry = history[historyIndex];
      setDialogues(entry.dialogues);
      setHistoryIndex(prev => prev - 1);
    }
  }, [history, historyIndex]);

  // Redo
  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const entry = history[historyIndex + 1];
      setDialogues(entry.dialogues);
      setHistoryIndex(prev => prev + 1);
    }
  }, [history, historyIndex]);

  const canUndo = historyIndex >= 0;
  const canRedo = historyIndex < history.length - 1;

  // Detect movie samples via LLM
  const detectSamples = useCallback(async () => {
    if (!episodeName || detectingSamples) return;
    setDetectingSamples(true);
    setDetectedSampleCount(null);
    try {
      const resp = await fetch('/api/detect-samples', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dialogues, episodeName }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const indices: number[] = data.sampleIndices ?? [];
      if (indices.length > 0) {
        applySpeakerToIndices(indices, 'Movie Sample', `Auto-detect ${indices.length} sample(s)`);
      }
      setDetectedSampleCount(indices.length);
    } catch (err) {
      console.error('Sample detection failed:', err);
      setDetectedSampleCount(-1);
    } finally {
      setDetectingSamples(false);
    }
  }, [episodeName, detectingSamples, dialogues, applySpeakerToIndices]);

  // Enter mapping mode for a label
  const enterMappingMode = useCallback((label: string) => {
    setActiveMappingLabel(label);
    setExcludedIndices(new Set());
    setCustomSpeaker('');
  }, []);

  // Exit mapping mode
  const exitMappingMode = useCallback(() => {
    setActiveMappingLabel(null);
    setExcludedIndices(new Set());
    setCustomSpeaker('');
  }, []);

  // Clear individual selection
  const clearSelection = useCallback(() => {
    setSelectedIndices(new Set());
    setLastSelectedIndex(null);
  }, []);

  // Toggle segment exclusion (moved before handleSegmentClick to avoid reference error)
  const toggleSegmentExclusion = useCallback((globalIndex: number) => {
    setExcludedIndices(prev => {
      const next = new Set(prev);
      if (next.has(globalIndex)) {
        next.delete(globalIndex);
      } else {
        next.add(globalIndex);
      }
      return next;
    });
  }, []);

  // Handle segment click for individual selection
  const handleSegmentClick = useCallback((globalIndex: number, e: React.MouseEvent) => {
    // Don't handle if clicking on interactive elements
    if (
      e.target instanceof HTMLButtonElement ||
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLSelectElement
    ) {
      return;
    }

    // If in mapping mode, toggle exclusion instead
    if (activeMappingLabel && dialogues[globalIndex]?.name === activeMappingLabel) {
      toggleSegmentExclusion(globalIndex);
      return;
    }

    // Exit mapping mode if active
    if (activeMappingLabel) {
      exitMappingMode();
    }

    setSelectedIndices(prev => {
      const next = new Set(prev);

      if (e.shiftKey && lastSelectedIndex !== null) {
        // Range selection
        const start = Math.min(lastSelectedIndex, globalIndex);
        const end = Math.max(lastSelectedIndex, globalIndex);
        for (let i = start; i <= end; i++) {
          next.add(i);
        }
      } else if (e.ctrlKey || e.metaKey) {
        // Toggle selection
        if (next.has(globalIndex)) {
          next.delete(globalIndex);
        } else {
          next.add(globalIndex);
        }
      } else {
        // Single selection - clear others
        next.clear();
        next.add(globalIndex);
      }

      return next;
    });

    setLastSelectedIndex(globalIndex);
  }, [activeMappingLabel, dialogues, lastSelectedIndex, toggleSegmentExclusion, exitMappingMode]);

  // Apply speaker to selected segments
  const applyToSelected = useCallback((newSpeakerName: string) => {
    if (!newSpeakerName.trim() || selectedIndices.size === 0) return;
    applySpeakerToIndices(
      selectedIndices,
      newSpeakerName.trim(),
      `Assign "${newSpeakerName.trim()}" to ${selectedIndices.size} segment(s)`
    );
    clearSelection();
  }, [selectedIndices, applySpeakerToIndices, clearSelection]);

  // Select all segments matching active label
  const selectAllMatching = useCallback(() => {
    setExcludedIndices(new Set());
  }, []);

  // Deselect all segments (exclude all matching)
  const deselectAllMatching = useCallback(() => {
    if (!activeMappingLabel) return;
    const allMatchingIndices = new Set<number>();
    const visibleSet = mappingScopeVisible ? new Set(visibleIndices) : null;
    dialogues.forEach((d, i) => {
      if (d.name === activeMappingLabel && (!visibleSet || visibleSet.has(i))) {
        allMatchingIndices.add(i);
      }
    });
    setExcludedIndices(allMatchingIndices);
  }, [activeMappingLabel, dialogues, mappingScopeVisible, visibleIndices]);

  // Apply mapping to selected segments
  const applyMapping = useCallback((newSpeakerName: string) => {
    if (!newSpeakerName.trim() || segmentsInScope.size === 0) return;
    applySpeakerToIndices(
      segmentsInScope,
      newSpeakerName.trim(),
      `Map "${activeMappingLabel}" → "${newSpeakerName.trim()}"`
    );
    exitMappingMode();
  }, [segmentsInScope, activeMappingLabel, exitMappingMode, applySpeakerToIndices]);

  // Audio seek on timestamp click
  const handleTimestampClick = useCallback(async (timestamp: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!audioUrl) return;

    controls.seekToTimestamp(timestamp);
    try {
      await controls.play();
    } catch (err) {
      console.error('Audio play failed:', err);
    }
  }, [audioUrl, controls]);

  const handleTimeClick = useCallback(async (time: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!audioUrl) return;

    controls.seekTo(time);
    try {
      await controls.play();
    } catch (err) {
      console.error('Audio play failed:', err);
    }
  }, [audioUrl, controls]);

  // Handle speaker label click
  const handleSpeakerLabelClick = useCallback((label: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (activeMappingLabel === label) {
      exitMappingMode();
    } else {
      enterMappingMode(label);
    }
  }, [activeMappingLabel, enterMappingMode, exitMappingMode]);

  // Page navigation
  const goToPage = useCallback((page: number) => {
    setCurrentPage(Math.max(1, Math.min(page, effectiveTotalPages)));
  }, [effectiveTotalPages]);

  const parseTimeInput = useCallback((value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const secs = Number(trimmed);
      return Number.isFinite(secs) ? secs : null;
    }

    const parts = trimmed.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    const numbers = parts.map((part) => Number(part));
    if (numbers.some((num) => Number.isNaN(num))) return null;

    if (numbers.length === 2) {
      return numbers[0] * 60 + numbers[1];
    }
    return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  }, []);

  const applyFocusRange = useCallback(
    (range: { start: number; end: number } | null, position: 'start' | 'end' = 'start') => {
      setFocusRange(range);
      if (range) {
        setRangeStartInput(secondsToTimestamp(range.start));
        setRangeEndInput(secondsToTimestamp(range.end));
      }

      if (!range) {
        setCurrentPage(1);
        return;
      }

      const indices = computeVisibleIndices(range);
      if (!indices.length) return;

      const targetIndex = position === 'end' ? indices.length - 1 : 0;
      const targetPage = Math.floor(targetIndex / PAGE_SIZE) + 1;
      setCurrentPage(targetPage);
    },
    [computeVisibleIndices]
  );

  const clearFocusRange = useCallback(() => {
    applyFocusRange(null, 'start');
  }, [applyFocusRange]);

  const selectRangeSegments = useCallback(() => {
    const start = parseTimeInput(rangeStartInput);
    const end = parseTimeInput(rangeEndInput);
    if (start === null || end === null) return;
    const range = { start: Math.min(start, end), end: Math.max(start, end) };
    const indices = computeVisibleIndices(range);
    setSelectedIndices(new Set(indices));
    if (indices.length) {
      setLastSelectedIndex(indices[indices.length - 1]);
    }
  }, [computeVisibleIndices, parseTimeInput, rangeStartInput, rangeEndInput]);

  const focusManualRange = useCallback(() => {
    const start = parseTimeInput(rangeStartInput);
    const end = parseTimeInput(rangeEndInput);
    if (start === null || end === null) return;
    const range = { start: Math.min(start, end), end: Math.max(start, end) };
    applyFocusRange(range, 'start');
  }, [applyFocusRange, parseTimeInput, rangeStartInput, rangeEndInput]);

  // Find next unassigned segment and navigate to it
  const goToNextUnassigned = useCallback(() => {
    const scopeIndices = isFilterActive ? visibleIndices : dialogues.map((_, i) => i);
    if (scopeIndices.length === 0) return;

    const currentIndexInScope = Math.min(segmentStartIndex, scopeIndices.length - 1);

    const findInScope = (startAt: number, endAt: number) => {
      for (let s = startAt; s < endAt; s++) {
        const globalIndex = scopeIndices[s];
        if (isPlaceholderLabel(dialogues[globalIndex].name)) {
          const targetPage = Math.floor(s / PAGE_SIZE) + 1;
          setCurrentPage(targetPage);
          enterMappingMode(dialogues[globalIndex].name);
          return true;
        }
      }
      return false;
    };

    if (findInScope(currentIndexInScope, scopeIndices.length)) return;
    findInScope(0, currentIndexInScope);
  }, [dialogues, segmentStartIndex, isPlaceholderLabel, enterMappingMode, isFilterActive, visibleIndices]);

  // Submit handler
  const handleSubmit = useCallback(() => {
    onMappingComplete(dialogues);
  }, [dialogues, onMappingComplete]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Escape to exit mapping mode or clear selection
      if (e.key === 'Escape') {
        if (activeMappingLabel) {
          exitMappingMode();
        } else if (selectedIndices.size > 0) {
          clearSelection();
        }
        return;
      }

      // Undo: Ctrl+Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Redo: Ctrl+Shift+Z or Ctrl+Y
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }

      // Number keys 1-6 for quick assign when in mapping mode or selection mode
      if ((activeMappingLabel || selectedIndices.size > 0) && e.key >= '1' && e.key <= '6') {
        const index = parseInt(e.key) - 1;
        if (index < primaryShortcuts.length) {
          if (activeMappingLabel) {
            applyMapping(primaryShortcuts[index]);
          } else {
            applyToSelected(primaryShortcuts[index]);
          }
        }
        return;
      }

      // 'n' for next unassigned
      if (e.key === 'n' && !activeMappingLabel) {
        goToNextUnassigned();
        return;
      }

      if (e.key === 'b' && !activeMappingLabel) {
        setViewMode((prev) => (prev === 'blocks' ? 'segments' : 'blocks'));
        return;
      }
      if (e.key === 'm' && !activeMappingLabel) {
        setHighlightSamples((prev) => !prev);
        return;
      }
      if (e.key === 'h' && !activeMappingLabel) {
        setHideInterjections((prev) => !prev);
        return;
      }

      // Arrow keys for pagination
      if (e.key === 'ArrowLeft' && !activeMappingLabel) {
        goToPage(currentPage - 1);
        return;
      }
      if (e.key === 'ArrowRight' && !activeMappingLabel) {
        goToPage(currentPage + 1);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeMappingLabel,
    primaryShortcuts,
    applyMapping,
    exitMappingMode,
    undo,
    redo,
    goToNextUnassigned,
    goToPage,
    currentPage,
    selectedIndices,
    applyToSelected,
    clearSelection,
    setViewMode,
    setHighlightSamples,
    setHideInterjections,
  ]);

  // Get the global index for a dialogue in the filtered/paginated view
  const getGlobalIndex = useCallback((pageIndex: number) => {
    return pageIndices[pageIndex];
  }, [pageIndices]);

  return (
    <div className="bg-white rounded-lg shadow">
      {/* Header */}
      <div className="p-6 border-b">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Map Speakers</h2>
            <p className="mt-1 text-sm text-gray-600">
              Detected {detectedSpeakers} speaker(s) · {dialogues.length} segments
              {unassignedCount > 0 && (
                <span className="text-orange-600 ml-1">· {unassignedCount} unassigned</span>
              )}
            </p>
          </div>

          {/* Undo/Redo buttons */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              className={`p-2 rounded text-sm ${
                canUndo
                  ? 'text-gray-600 hover:bg-gray-100'
                  : 'text-gray-300 cursor-not-allowed'
              }`}
              title="Undo (Ctrl+Z)"
            >
              ↶ Undo
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              className={`p-2 rounded text-sm ${
                canRedo
                  ? 'text-gray-600 hover:bg-gray-100'
                  : 'text-gray-300 cursor-not-allowed'
              }`}
              title="Redo (Ctrl+Y)"
            >
              ↷ Redo
            </button>
          </div>
        </div>

        {/* Filters and controls */}
        <div className="mt-3 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label htmlFor="speaker-filter" className="text-sm text-gray-600">Filter:</label>
            <select
              id="speaker-filter"
              value={speakerFilter}
              onChange={(e) => {
                setSpeakerFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="text-sm border rounded px-2 py-1"
            >
              <option value="all">All speakers</option>
              {uniqueSpeakerLabels.map(({ name, count }) => (
                <option key={name} value={name}>
                  {name} ({count})
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-sm text-gray-600">View:</span>
            <button
              type="button"
              onClick={() => setViewMode('segments')}
              className={`px-2 py-1 text-sm rounded border ${
                viewMode === 'segments' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'
              }`}
            >
              Segments
            </button>
            <button
              type="button"
              onClick={() => setViewMode('blocks')}
              className={`px-2 py-1 text-sm rounded border ${
                viewMode === 'blocks' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'
              }`}
            >
              Blocks
            </button>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={hideInterjections}
              onChange={(e) => setHideInterjections(e.target.checked)}
            />
            Hide interjections (h)
          </label>

          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={highlightSamples}
              onChange={(e) => setHighlightSamples(e.target.checked)}
            />
            Highlight samples (m)
          </label>

          {episodeName && (
            <button
              type="button"
              onClick={detectSamples}
              disabled={detectingSamples}
              className={`px-3 py-1 text-sm rounded border ${
                detectingSamples
                  ? 'bg-gray-100 text-gray-400 cursor-wait'
                  : 'bg-purple-50 text-purple-700 border-purple-300 hover:bg-purple-100'
              }`}
            >
              {detectingSamples
                ? 'Detecting...'
                : detectedSampleCount === null
                  ? 'Detect Samples'
                  : detectedSampleCount === -1
                    ? 'Detect Samples (error)'
                    : detectedSampleCount === 0
                      ? 'No samples found'
                      : `${detectedSampleCount} sample(s) labeled`}
            </button>
          )}

          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Range:</label>
            <input
              type="text"
              value={rangeStartInput}
              onChange={(e) => setRangeStartInput(e.target.value)}
              placeholder="0:00"
              className="w-20 text-sm border rounded px-2 py-1"
            />
            <span className="text-gray-400">–</span>
            <input
              type="text"
              value={rangeEndInput}
              onChange={(e) => setRangeEndInput(e.target.value)}
              placeholder="3:00"
              className="w-20 text-sm border rounded px-2 py-1"
            />
            <button
              type="button"
              onClick={focusManualRange}
              className="px-2 py-1 text-sm rounded border bg-white hover:bg-gray-100"
            >
              Focus
            </button>
            <button
              type="button"
              onClick={selectRangeSegments}
              className="px-2 py-1 text-sm rounded border bg-white hover:bg-gray-100"
            >
              Select
            </button>
            {focusRange && (
              <button
                type="button"
                onClick={clearFocusRange}
                className="px-2 py-1 text-sm rounded border bg-white hover:bg-gray-100 text-red-600"
              >
                Clear focus
              </button>
            )}
          </div>

          {unassignedCount > 0 && (
            <button
              type="button"
              onClick={goToNextUnassigned}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              Next unassigned (n)
            </button>
          )}

          <span className="text-xs text-gray-400">
            Click to select · Shift+click range · 1-6 assign · Esc cancel
          </span>
        </div>
      </div>

      {/* Cast panel — confirm or correct the auto-proposal */}
      {proposal && !proposal.degenerate && proposal.labels.length > 0 && (
        <div className="p-4 border-b bg-indigo-50">
          <div className="flex items-center justify-between mb-3">
            <span className="font-medium text-indigo-900">
              Proposed cast — {proposal.labels.length} labels ·{' '}
              {proposal.contaminants.length} stray turns moved
            </span>
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              className="text-sm text-indigo-700 hover:text-indigo-900 disabled:text-indigo-300"
            >
              Undo proposal
            </button>
          </div>

          <div className="space-y-1">
            {proposal.labels.map((row) => (
              <div key={row.label} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-gray-500 w-8">{row.label}</span>
                <input
                  type="text"
                  defaultValue={row.proposedName ?? ''}
                  placeholder="unassigned"
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value.trim() !== row.proposedName) {
                      renameProposedLabel(row.label, e.target.value);
                    }
                  }}
                  className={`px-2 py-1 border rounded w-44 ${
                    row.confidence === 'low' ? 'border-orange-400 bg-orange-50' : 'border-gray-300'
                  }`}
                  list="known-speakers-panel"
                />
                <span className="text-gray-600 w-28">
                  {row.kind === 'caller' && row.runTurnCount !== row.turnCount
                    ? `${row.turnCount}→${row.runTurnCount} turns`
                    : `${row.turnCount} turns`}
                </span>
                <span className="font-mono text-xs text-gray-500 w-28">
                  {row.runStart && row.runEnd ? `${row.runStart}–${row.runEnd}` : ''}
                </span>
                <span className="text-gray-500 truncate flex-1">
                  {row.warnings.length > 0 ? (
                    <span className="text-orange-700">⚠ {row.warnings.join(' · ')}</span>
                  ) : (
                    `"${row.sampleText.slice(0, 60)}…"`
                  )}
                </span>
              </div>
            ))}
          </div>
          <datalist id="known-speakers-panel">
            {speakerSuggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      )}

      {/* Audio Player */}
      {audioUrl && (
        <div className="border-b">
          <AudioPlayer
            audioSrc={audioUrl}
            state={audioState}
            controls={controls}
            setAudioRef={setAudioRef}
          />
        </div>
      )}

      {/* Individual Selection Panel */}
      {selectedIndices.size > 0 && !activeMappingLabel && (
        <div className="p-4 border-b bg-green-50 border-l-4 border-green-500">
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="font-medium text-green-900">
                {selectedIndices.size} segment{selectedIndices.size > 1 ? 's' : ''} selected
              </span>
              <span className="ml-2 text-sm text-green-700">
                Click to select, Shift+click for range, Ctrl+click to toggle
              </span>
            </div>
            <button
              type="button"
              onClick={clearSelection}
              className="text-green-700 hover:text-green-900 text-sm"
            >
              Clear (Esc)
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-wide text-green-700">Hosts/Guest</span>
              {primaryShortcuts.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => applyToSelected(name)}
                  className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors"
                >
                  <span className="opacity-60 mr-1">{index + 1}</span>
                  {name}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-wide text-green-700">Voicemailers</span>
              {voicemailSpeakers.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => applyToSelected(name)}
                  className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors"
                >
                  {name}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-wide text-green-700">Categories</span>
              {CATEGORY_SPEAKERS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => applyToSelected(name)}
                  className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors"
                >
                  {name}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1">
              <input
                type="text"
                value={customSpeaker}
                onChange={(e) => setCustomSpeaker(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customSpeaker.trim()) {
                    applyToSelected(customSpeaker);
                  }
                  if (e.key === 'Escape') {
                    clearSelection();
                  }
                }}
                placeholder="Custom name..."
                className="px-2 py-1.5 text-sm border rounded-md w-40 focus:ring-2 focus:ring-green-500 focus:border-green-500"
                list="known-speakers-selection"
              />
              <datalist id="known-speakers-selection">
                {speakerSuggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={() => applyToSelected(customSpeaker)}
                disabled={!customSpeaker.trim()}
                className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                  !customSpeaker.trim()
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-green-600 text-white hover:bg-green-700'
                }`}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mapping Mode Panel */}
      {activeMappingLabel && (
        <div className="p-4 border-b bg-blue-50 border-l-4 border-blue-500">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <div>
                <span className="font-medium text-blue-900">
                  Mapping: {activeMappingLabel}
                </span>
                <span className="ml-2 text-sm text-blue-700">
                  {segmentsInScope.size} of {mappingScopeVisible ? visibleMatchingSegments : totalMatchingSegments} segments selected
                  {mappingScopeVisible && (
                    <span className="ml-1 text-blue-500">(filtered)</span>
                  )}
                </span>
              </div>
              {/* Select All / None buttons */}
              <div className="flex items-center gap-1 text-sm">
                <button
                  type="button"
                  onClick={selectAllMatching}
                  className="px-2 py-0.5 text-blue-700 hover:bg-blue-100 rounded"
                >
                  All
                </button>
                <span className="text-blue-400">|</span>
                <button
                  type="button"
                  onClick={deselectAllMatching}
                  className="px-2 py-0.5 text-blue-700 hover:bg-blue-100 rounded"
                >
                  None
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={exitMappingMode}
              className="text-blue-700 hover:text-blue-900 text-sm"
            >
              Cancel (Esc)
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-wide text-blue-700">Hosts/Guest</span>
              {primaryShortcuts.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => applyMapping(name)}
                  disabled={segmentsInScope.size === 0}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    segmentsInScope.size === 0
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  <span className="opacity-60 mr-1">{index + 1}</span>
                  {name}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-wide text-blue-700">Voicemailers</span>
              {voicemailSpeakers.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => applyMapping(name)}
                  disabled={segmentsInScope.size === 0}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    segmentsInScope.size === 0
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-wide text-blue-700">Categories</span>
              {CATEGORY_SPEAKERS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => applyMapping(name)}
                  disabled={segmentsInScope.size === 0}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    segmentsInScope.size === 0
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1">
              <input
                ref={customInputRef}
                type="text"
                value={customSpeaker}
                onChange={(e) => setCustomSpeaker(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    applyMapping(customSpeaker);
                  }
                  if (e.key === 'Escape') {
                    exitMappingMode();
                  }
                }}
                placeholder="Custom name..."
                className="px-2 py-1.5 text-sm border rounded-md w-40 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                list="known-speakers-mapping"
                autoFocus
              />
              <datalist id="known-speakers-mapping">
                {speakerSuggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={() => applyMapping(customSpeaker)}
                disabled={segmentsInScope.size === 0 || !customSpeaker.trim()}
                className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                  segmentsInScope.size === 0 || !customSpeaker.trim()
                    ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                }`}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dialogue List */}
      <div className="divide-y max-h-[50vh] overflow-y-auto">
        {viewMode === 'blocks' ? (
          pageBlocks.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              No blocks match the current filters.
            </div>
          ) : (
            pageBlocks.map((block) => {
              const blockSelected = block.indices.every((i) => selectedIndices.has(i));
              const blockActive = block.indices.includes(audioState.activeSegmentIndex);
              const blockSample = highlightSamples && block.indices.some((i) => isSampleCandidate(dialogues[i].text));
              const blockStart = secondsToTimestamp(block.start);
              const blockEnd = secondsToTimestamp(block.end);

              return (
                <div
                  key={`${block.indices[0]}-${block.start}`}
                  onClick={(e) => {
                    if (
                      e.target instanceof HTMLButtonElement ||
                      e.target instanceof HTMLInputElement
                    ) {
                      return;
                    }
                    if (activeMappingLabel) {
                      exitMappingMode();
                    }
                    if (blockSelected) {
                      clearSelection();
                    } else {
                      setSelectedIndices(new Set(block.indices));
                      setLastSelectedIndex(block.indices[block.indices.length - 1]);
                    }
                  }}
                  className={`flex items-start gap-3 p-3 transition-colors cursor-pointer ${
                    blockSelected
                      ? 'bg-green-100 border-l-4 border-green-500'
                      : blockActive
                        ? 'bg-yellow-50'
                        : blockSample
                          ? 'bg-amber-50 border-l-4 border-amber-300'
                          : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="pt-0.5 w-5">
                    {blockSelected && (
                      <input
                        type="checkbox"
                        checked={blockSelected}
                        onChange={() => {
                          if (blockSelected) {
                            clearSelection();
                          } else {
                            setSelectedIndices(new Set(block.indices));
                            setLastSelectedIndex(block.indices[block.indices.length - 1]);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 rounded border-gray-300 cursor-pointer text-green-600 focus:ring-green-500"
                      />
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={(e) => handleTimeClick(block.start, e)}
                    className={`text-sm font-mono min-w-[90px] text-left ${
                      audioUrl
                        ? 'text-blue-600 hover:text-blue-800 hover:underline'
                        : 'text-gray-400'
                    }`}
                    disabled={!audioUrl}
                    title={audioUrl ? 'Click to play from here' : 'No audio available'}
                  >
                    {blockStart}–{blockEnd}
                  </button>

                  <button
                    type="button"
                    onClick={(e) => handleSpeakerLabelClick(block.name, e)}
                    className={`text-sm font-medium min-w-[120px] text-left px-2 py-0.5 rounded transition-colors ${
                      activeMappingLabel === block.name
                        ? 'bg-blue-600 text-white'
                        : isPlaceholderLabel(block.name)
                          ? 'text-orange-600 hover:bg-orange-100 border border-orange-300'
                          : 'text-gray-900 hover:bg-gray-200 border border-gray-300'
                    }`}
                    title="Click to map all segments with this speaker"
                  >
                    {block.name}
                  </button>

                  <p className="text-sm flex-1 line-clamp-2 text-gray-700">
                    {block.textPreview}
                  </p>

                  <span className="text-xs text-gray-500">
                    {block.indices.length} seg
                  </span>
                </div>
              );
            })
          )
        ) : pageDialogues.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">
            No segments match the current filters.
          </div>
        ) : (
          pageDialogues.map((dialogue, pageIndex) => {
            const globalIndex = getGlobalIndex(pageIndex);
            const isActiveSegment = audioState.activeSegmentIndex === globalIndex;
            const matchesActiveLabel = activeMappingLabel === dialogue.name;
            const isExcluded = excludedIndices.has(globalIndex);
            const isInScope = matchesActiveLabel && !isExcluded;
            const isDimmed = activeMappingLabel && !matchesActiveLabel;
            const isSelected = selectedIndices.has(globalIndex);
            const isSample = highlightSamples && isSampleCandidate(dialogue.text);

            return (
              <div
                key={`${globalIndex}-${dialogue.timestamp}`}
                onClick={(e) => handleSegmentClick(globalIndex, e)}
                className={`flex items-start gap-3 p-3 transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-green-100 border-l-4 border-green-500'
                    : isInScope
                      ? 'bg-blue-50 border-l-4 border-blue-500'
                      : isExcluded && matchesActiveLabel
                        ? 'bg-gray-100 border-l-4 border-gray-300'
                        : isActiveSegment
                          ? 'bg-yellow-50'
                          : isSample
                            ? 'bg-amber-50 border-l-4 border-amber-300'
                            : isDimmed
                              ? 'bg-gray-50 opacity-50'
                              : 'hover:bg-gray-50'
                }`}
              >
                {/* Checkbox - for selected segments or segments matching active label */}
                <div className="pt-0.5 w-5">
                  {(matchesActiveLabel || isSelected) && (
                    <input
                      type="checkbox"
                      checked={matchesActiveLabel ? !isExcluded : isSelected}
                      onChange={() => {
                        if (matchesActiveLabel) {
                          toggleSegmentExclusion(globalIndex);
                        } else {
                          setSelectedIndices(prev => {
                            const next = new Set(prev);
                            if (next.has(globalIndex)) {
                              next.delete(globalIndex);
                            } else {
                              next.add(globalIndex);
                            }
                            return next;
                          });
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className={`h-4 w-4 rounded border-gray-300 cursor-pointer ${
                        matchesActiveLabel ? 'text-blue-600 focus:ring-blue-500' : 'text-green-600 focus:ring-green-500'
                      }`}
                    />
                  )}
                </div>

                {/* Timestamp */}
                <button
                  type="button"
                  onClick={(e) => handleTimestampClick(dialogue.timestamp, e)}
                  className={`text-sm font-mono min-w-[60px] text-left ${
                    audioUrl
                      ? 'text-blue-600 hover:text-blue-800 hover:underline'
                      : 'text-gray-400'
                  }`}
                  disabled={!audioUrl}
                  title={audioUrl ? 'Click to play from here' : 'No audio available'}
                >
                  {dialogue.timestamp}
                </button>

                {/* Speaker Label - clickable to enter mapping mode */}
                <button
                  type="button"
                  onClick={(e) => handleSpeakerLabelClick(dialogue.name, e)}
                  className={`text-sm font-medium min-w-[100px] text-left px-2 py-0.5 rounded transition-colors ${
                    activeMappingLabel === dialogue.name
                      ? 'bg-blue-600 text-white'
                      : isPlaceholderLabel(dialogue.name)
                        ? 'text-orange-600 hover:bg-orange-100 border border-orange-300'
                        : 'text-gray-900 hover:bg-gray-200 border border-gray-300'
                  }`}
                  title="Click to map all segments with this speaker"
                >
                  {dialogue.name}
                </button>

                {/* Text */}
                <p className={`text-sm flex-1 line-clamp-2 ${
                  isDimmed ? 'text-gray-400' : 'text-gray-700'
                }`}>
                  {dialogue.text}
                </p>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      <div className="p-4 border-t bg-gray-50 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage === 1}
          className={`px-4 py-2 text-sm rounded-md transition-colors ${
            currentPage === 1
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-white border text-gray-700 hover:bg-gray-50'
          }`}
        >
          ← Prev
        </button>

        <span className="text-sm text-gray-600">
          Page {currentPage} of {effectiveTotalPages}
          {viewMode === 'segments' && isFilterActive && (
            <span className="text-gray-400 ml-1">
              ({visibleIndices.length} filtered)
            </span>
          )}
          {viewMode === 'blocks' && (
            <span className="text-gray-400 ml-1">
              ({blocks.length} blocks)
            </span>
          )}
        </span>

        <button
          type="button"
          onClick={() => goToPage(currentPage + 1)}
          disabled={currentPage === effectiveTotalPages}
          className={`px-4 py-2 text-sm rounded-md transition-colors ${
            currentPage === effectiveTotalPages
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-white border text-gray-700 hover:bg-gray-50'
          }`}
        >
          Next →
        </button>
      </div>

      {/* Footer Actions */}
      <div className="p-6 border-t bg-gray-50 flex justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-gray-700 bg-white border rounded-md hover:bg-gray-50"
        >
          Skip Mapping
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          Apply & Continue
        </button>
      </div>
    </div>
  );
}
