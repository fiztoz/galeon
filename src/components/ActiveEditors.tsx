import React, { useEffect, useRef, useState } from 'react';
import { Pencil, X, Square, FileClock } from 'lucide-react';

// Mirrors the backend `EditSessionInfo` (camelCase) contract from lib.rs.
export interface EditSessionInfo {
  editorId: string;
  sessionId: string;
  remoteKey: string;
  filename: string;
  startedAt: string; // rfc3339
  lastSavedAt: string | null; // rfc3339, null until first save
  saveCount: number;
}

interface ActiveEditorsProps {
  sessions: EditSessionInfo[];
  onStop: (editorId: string) => void;
  onStopAll: () => void;
}

// Compact "x ago" formatter for save timestamps.
function timeAgo(iso: string | null): string {
  if (!iso) return 'not saved yet';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'saved';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 5) return 'saved just now';
  if (secs < 60) return `saved ${secs}s ago`;
  if (secs < 3600) return `saved ${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `saved ${Math.floor(secs / 3600)}h ago`;
  return `saved ${Math.floor(secs / 86400)}d ago`;
}

/**
 * Header control surfacing in-progress "Edit in External Editor" sessions.
 * Shows a count badge and a dropdown to stop individual sessions (which drops
 * the watcher and cleans up the temp copy on the backend).
 */
export const ActiveEditors: React.FC<ActiveEditorsProps> = ({ sessions, onStop, onStopAll }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Re-render once a minute so relative "saved Xm ago" labels stay fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [open]);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Nothing to surface when no edits are in flight.
  if (sessions.length === 0) return null;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Active external editors"
        className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 px-2 py-1 rounded-md font-medium transition-colors"
      >
        <Pencil className="w-3 h-3 text-gale-teal" />
        <span>Editing ({sessions.length})</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <span className="text-sm font-semibold flex items-center space-x-2">
              <FileClock className="w-4 h-4 text-gale-teal" />
              <span>Active Editors</span>
            </span>
            {sessions.length > 1 && (
              <button
                onClick={() => { onStopAll(); setOpen(false); }}
                className="text-xs text-red-400 hover:text-red-300"
              >
                Stop all
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto divide-y divide-zinc-800">
            {sessions.map((s) => (
              <div key={s.editorId} className="flex items-center justify-between px-4 py-3 hover:bg-zinc-800/40">
                <div className="min-w-0 mr-2">
                  <div className="text-sm font-medium truncate" title={s.remoteKey}>{s.filename}</div>
                  <div className="text-xs text-zinc-500 flex items-center space-x-2 mt-0.5">
                    <span>{s.saveCount > 0 ? `saved ${s.saveCount}×` : 'unsaved'}</span>
                    <span>•</span>
                    <span>{timeAgo(s.lastSavedAt)}</span>
                  </div>
                </div>
                <button
                  onClick={() => onStop(s.editorId)}
                  title="Stop editing & clean up temp copy"
                  className="flex items-center space-x-1 text-xs px-2 py-1 rounded-md bg-zinc-800 hover:bg-red-500/20 hover:text-red-300 text-zinc-300 transition-colors shrink-0"
                >
                  <Square className="w-3 h-3" />
                  <span>Stop</span>
                </button>
              </div>
            ))}
          </div>

          <div className="px-4 py-2 text-[11px] text-zinc-600 border-t border-zinc-800">
            Saving in your editor re-uploads automatically. <X className="inline w-3 h-3 align-text-bottom" /> on disconnect or after 2h idle.
          </div>
        </div>
      )}
    </div>
  );
};
