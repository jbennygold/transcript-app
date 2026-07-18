'use client';

import { useState, useMemo, useCallback } from 'react';
import type { DialogueEntry } from '@/types/transcript';
import type { CleanupChange } from '@/app/api/cleanup-transcript/route';

export interface CleanupDecision {
  change: CleanupChange;
  accepted: boolean;
}

interface CleanupReviewProps {
  changes: CleanupChange[];
  dialogues: DialogueEntry[];
  onApply: (accepted: CleanupChange[], decisions: CleanupDecision[]) => void;
  onCancel: () => void;
  onSeekTo?: (timestamp: string) => void;
  title?: string;
}

const TYPE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  sample: { label: 'Movie Sample', color: 'text-purple-700', bg: 'bg-purple-50 border-purple-200' },
  spelling: { label: 'Spelling', color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200' },
  speaker: { label: 'Speaker', color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200' },
  voicemailer: { label: 'Voicemailer', color: 'text-green-700', bg: 'bg-green-50 border-green-200' },
};

export default function CleanupReview({ changes, dialogues, onApply, onCancel, onSeekTo, title }: CleanupReviewProps) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(changes.map((_, i) => i)));
  // Track user edits to newValue — keyed by change index
  const [edits, setEdits] = useState<Record<number, string>>({});

  const grouped = useMemo(() => {
    const groups: Record<string, { change: CleanupChange; idx: number }[]> = {};
    for (let i = 0; i < changes.length; i++) {
      const type = changes[i].type;
      if (!groups[type]) groups[type] = [];
      groups[type].push({ change: changes[i], idx: i });
    }
    return groups;
  }, [changes]);

  const toggleAll = (type: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const { idx } of grouped[type]) {
        if (checked) next.add(idx); else next.delete(idx);
      }
      return next;
    });
  };

  const toggle = (idx: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const updateEdit = useCallback((idx: number, value: string) => {
    setEdits(prev => ({ ...prev, [idx]: value }));
  }, []);

  const getEffectiveChange = useCallback((idx: number): CleanupChange => {
    const change = changes[idx];
    if (idx in edits) {
      return { ...change, newValue: edits[idx] };
    }
    return change;
  }, [changes, edits]);

  const handleApply = () => {
    const accepted = changes
      .map((_, i) => i)
      .filter(i => selected.has(i))
      .map(i => getEffectiveChange(i));
    const decisions: CleanupDecision[] = changes.map((_, i) => ({
      change: getEffectiveChange(i),
      accepted: selected.has(i),
    }));
    onApply(accepted, decisions);
  };

  const typeOrder = ['sample', 'voicemailer', 'speaker', 'spelling'];

  return (
    <div className="bg-white rounded-lg shadow">
      <div className="p-6 border-b">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">{title ?? 'Review Cleanup Changes'}</h2>
            <p className="mt-1 text-sm text-gray-600">
              {changes.length} proposed change{changes.length !== 1 ? 's' : ''} · {selected.size} selected
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded border"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={selected.size === 0}
              className={`px-4 py-2 text-sm rounded font-medium ${
                selected.size > 0
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-200 text-gray-500 cursor-not-allowed'
              }`}
            >
              Apply {selected.size} Change{selected.size !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
        {typeOrder.filter(t => grouped[t]).map(type => {
          const items = grouped[type];
          const meta = TYPE_LABELS[type] || { label: type, color: 'text-gray-700', bg: 'bg-gray-50 border-gray-200' };
          const allChecked = items.every(({ idx }) => selected.has(idx));
          const someChecked = items.some(({ idx }) => selected.has(idx));

          return (
            <div key={type}>
              <div className="flex items-center gap-3 mb-3">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={el => { if (el) el.indeterminate = someChecked && !allChecked; }}
                  onChange={e => toggleAll(type, e.target.checked)}
                  className="w-4 h-4"
                />
                <span className={`text-sm font-semibold ${meta.color}`}>
                  {meta.label} ({items.length})
                </span>
              </div>

              <div className="space-y-2 ml-7">
                {items.map(({ change, idx }) => {
                  const d = dialogues[change.index];
                  const editedValue = idx in edits ? edits[idx] : null;
                  const displayNewValue = editedValue ?? change.newValue;
                  const isEdited = editedValue !== null && editedValue !== change.newValue;

                  return (
                    <div
                      key={idx}
                      className={`flex items-start gap-3 p-3 rounded border ${
                        selected.has(idx) ? meta.bg : 'bg-white border-gray-200 opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(idx)}
                        onChange={() => toggle(idx)}
                        className="w-4 h-4 mt-0.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
                          {onSeekTo && d?.timestamp && (
                            <button
                              type="button"
                              onClick={() => onSeekTo(d.timestamp)}
                              className="hover:text-blue-600 transition-colors"
                              title="Play from this timestamp"
                            >
                              &#9654;
                            </button>
                          )}
                          <span className="font-mono">{d?.timestamp}</span>
                          <span>#{change.index}</span>
                          {isEdited && (
                            <span className="text-amber-600 font-medium">edited</span>
                          )}
                        </div>
                        {change.field === 'name' ? (
                          <div className="text-sm">
                            <span className="line-through text-red-600">{change.oldValue}</span>
                            <span className="mx-2 text-gray-400">&rarr;</span>
                            <input
                              type="text"
                              value={displayNewValue}
                              onChange={e => updateEdit(idx, e.target.value)}
                              className="font-medium text-green-700 bg-transparent border-b border-dashed border-green-300 focus:border-green-600 outline-none px-1"
                              style={{ width: `${Math.max(displayNewValue.length + 2, 8)}ch` }}
                            />
                            <span className="text-gray-500 ml-2">
                              &ldquo;{d?.text.slice(0, 80)}{(d?.text.length ?? 0) > 80 ? '...' : ''}&rdquo;
                            </span>
                          </div>
                        ) : (
                          <div className="text-sm space-y-1">
                            <div className="line-through text-red-600 break-words">{change.oldValue}</div>
                            <textarea
                              value={displayNewValue}
                              onChange={e => updateEdit(idx, e.target.value)}
                              rows={Math.min(3, Math.ceil(displayNewValue.length / 80))}
                              className="w-full font-medium text-green-700 bg-transparent border border-dashed border-green-300 focus:border-green-600 outline-none rounded px-2 py-1 resize-y"
                            />
                          </div>
                        )}
                        <p className="text-xs text-gray-500 mt-1">{change.reason}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
