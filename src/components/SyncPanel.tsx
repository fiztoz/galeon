import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowUpFromLine,
  ArrowDownToLine,
  Minus,
  Trash2,
  RefreshCw,
  Save,
  Play,
  X,
  AlertTriangle,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Clock,
  Loader2,
} from 'lucide-react';
import { ConnectionProfile } from '../types';

// ── Contract types (matching backend camelCase exactly) ─────────────────────

export interface SyncOptions {
  verifyChecksum: boolean;
  deleteExtraneous: boolean;
}

export interface SyncPlanEntry {
  relativePath: string;
  action: 'upload' | 'download' | 'skip' | 'deleteRemote' | 'deleteLocal';
  reason: string;
  localSize: number | null;
  remoteSize: number | null;
  localModified: string | null;
  remoteModified: string | null;
  direction: 'localToRemote' | 'remoteToLocal';
}

export interface SyncSchedule {
  enabled: boolean;
  frequency: 'once' | 'hourly' | 'daily' | 'weekly';
  atHour: number;
  atMinute: number;
  dayOfWeek?: number;
  nextRunMs?: number;
}

export interface SyncProfile {
  id: string;
  name: string;
  connectionProfileId: string;
  localPath: string;
  remotePrefix: string;
  direction: 'localToRemote' | 'remoteToLocal';
  verifyChecksum: boolean;
  deleteExtraneous: boolean;
  lastRunMs: number | null;
  schedule?: SyncSchedule;
}

// ── Helper utilities ─────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function actionLabel(action: SyncPlanEntry['action']): string {
  switch (action) {
    case 'upload': return 'Upload';
    case 'download': return 'Download';
    case 'skip': return 'Skip';
    case 'deleteRemote': return 'Delete remote';
    case 'deleteLocal': return 'Delete local';
  }
}

function actionIcon(action: SyncPlanEntry['action']) {
  switch (action) {
    case 'upload': return <ArrowUpFromLine className="w-3.5 h-3.5 text-gale-teal" />;
    case 'download': return <ArrowDownToLine className="w-3.5 h-3.5 text-emerald-400" />;
    case 'skip': return <Minus className="w-3.5 h-3.5 text-zinc-500" />;
    case 'deleteRemote': return <Trash2 className="w-3.5 h-3.5 text-red-500" />;
    case 'deleteLocal': return <Trash2 className="w-3.5 h-3.5 text-red-500" />;
  }
}

function isDeleteAction(action: SyncPlanEntry['action']): boolean {
  return action === 'deleteRemote' || action === 'deleteLocal';
}

const DAYS_OF_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function defaultSchedule(): SyncSchedule {
  return {
    enabled: false,
    frequency: 'daily',
    atHour: 2,
    atMinute: 0,
  };
}

function resolveSchedule(profile: SyncProfile, edits: Record<string, SyncSchedule>): SyncSchedule {
  return edits[profile.id] ?? profile.schedule ?? defaultSchedule();
}

function clampHour(value: number): number {
  return Math.min(23, Math.max(0, Math.floor(value) || 0));
}

function clampMinute(value: number): number {
  return Math.min(59, Math.max(0, Math.floor(value) || 0));
}

// ── Props ────────────────────────────────────────────────────────────────────

interface SyncPanelProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  /** Active connection profile id — links sync transfers to the saved profile */
  connectionProfileId?: string;
  profiles: ConnectionProfile[];
  syncProfiles: SyncProfile[];
  currentRemotePrefix: string;
  /** Prefill form from a saved sync profile for a one-click run */
  prefillProfile?: SyncProfile | null;
  onSaveSyncProfile: (profile: SyncProfile) => Promise<void>;
  onDeleteSyncProfile: (profileId: string) => Promise<void>;
  /** Called when sync execution completes so Explorer can refresh */
  onSyncComplete: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

type PanelView = 'form' | 'diff' | 'profiles';

export function SyncPanel({
  open: isOpen,
  onClose,
  sessionId,
  connectionProfileId,
  profiles,
  syncProfiles,
  currentRemotePrefix,
  prefillProfile,
  onSaveSyncProfile,
  onDeleteSyncProfile,
  onSyncComplete,
}: SyncPanelProps) {
  // ── Form state ──────────────────────────────────────────────────────────
  const [view, setView] = useState<PanelView>('form');

  const [selectedConnectionProfileId, setSelectedConnectionProfileId] = useState<string>('');
  const [localPath, setLocalPath] = useState<string>('');
  const [remotePrefix, setRemotePrefix] = useState<string>(currentRemotePrefix);
  const [direction, setDirection] = useState<'localToRemote' | 'remoteToLocal'>('localToRemote');
  const [verifyChecksum, setVerifyChecksum] = useState(false);
  const [deleteExtraneous, setDeleteExtraneous] = useState(false);

  // ── Diff state ──────────────────────────────────────────────────────────
  const [plan, setPlan] = useState<SyncPlanEntry[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // ── Apply state ─────────────────────────────────────────────────────────
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);

  // ── Save-profile state ──────────────────────────────────────────────────
  const [saveProfileName, setSaveProfileName] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [saveProfileVisible, setSaveProfileVisible] = useState(false);
  const [newProfileSchedule, setNewProfileSchedule] = useState<SyncSchedule | null>(null);

  // ── Schedule state (profiles view) ──────────────────────────────────────
  const [expandedSchedules, setExpandedSchedules] = useState<Set<string>>(new Set());
  const [scheduleEdits, setScheduleEdits] = useState<Record<string, SyncSchedule>>({});
  const [savingScheduleId, setSavingScheduleId] = useState<string | null>(null);

  // Apply prefill when panel opens or prefillProfile changes
  useEffect(() => {
    if (!isOpen) return;
    if (prefillProfile) {
      setSelectedConnectionProfileId(prefillProfile.connectionProfileId);
      setLocalPath(prefillProfile.localPath);
      setRemotePrefix(prefillProfile.remotePrefix);
      setDirection(prefillProfile.direction);
      setVerifyChecksum(prefillProfile.verifyChecksum);
      setDeleteExtraneous(prefillProfile.deleteExtraneous);
      setSaveProfileName(prefillProfile.name);
    } else {
      // Default: current prefix, first connection profile selected
      setRemotePrefix(currentRemotePrefix);
      setSelectedConnectionProfileId(profiles[0]?.id ?? '');
    }
    // Always reset computed state on open
    setPlan([]);
    setDiffError(null);
    setApplyError(null);
    setConfirmDeleteOpen(false);
    setSyncProgress(null);
    setView('form');
    setSaveProfileVisible(false);
    setNewProfileSchedule(null);
    setExpandedSchedules(new Set());
    setScheduleEdits({});
    setSavingScheduleId(null);
  }, [isOpen, prefillProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to sync-progress events while panel is open
  useEffect(() => {
    if (!isOpen) return;
    const unsub = listen<{ done: number; total: number }>('sync-progress', (ev) => {
      setSyncProgress(ev.payload);
    });
    return () => { unsub.then((fn) => fn()).catch(() => {}); };
  }, [isOpen]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handlePickLocalFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') setLocalPath(selected);
  };

  const handleComputeDiff = useCallback(async () => {
    if (!localPath || !remotePrefix) {
      setDiffError('Please fill in local path and remote prefix.');
      return;
    }
    setDiffLoading(true);
    setDiffError(null);
    setPlan([]);
    try {
      const result = await invoke<SyncPlanEntry[]>('compute_sync_diff', {
        sessionId,
        localPath,
        remotePrefix,
        direction,
        options: { verifyChecksum, deleteExtraneous },
      });
      setPlan(result);
      setView('diff');
    } catch (err) {
      setDiffError(String(err));
    } finally {
      setDiffLoading(false);
    }
  }, [sessionId, localPath, remotePrefix, direction, verifyChecksum, deleteExtraneous]);

  const handleApply = useCallback(async () => {
    const hasDeletes = plan.some((e) => isDeleteAction(e.action));
    if (hasDeletes && !confirmDeleteOpen) {
      setConfirmDeleteOpen(true);
      return;
    }
    setConfirmDeleteOpen(false);
    setApplyLoading(true);
    setApplyError(null);
    setSyncProgress(null);
    try {
      const failures = await invoke<number>('execute_sync_plan', {
        sessionId,
        plan,
        deleteExtraneous,
        localPath,
        remotePrefix,
        profileId: connectionProfileId ?? null,
      });
      if (failures > 0) {
        setApplyError(`${failures} sync item(s) failed`);
        return;
      }
      onSyncComplete();
      onClose();
    } catch (err) {
      setApplyError(String(err));
    } finally {
      setApplyLoading(false);
    }
  }, [plan, sessionId, deleteExtraneous, localPath, remotePrefix, connectionProfileId, confirmDeleteOpen, onSyncComplete, onClose]);

  const handleSaveProfile = async () => {
    if (!saveProfileName.trim()) return;
    setSavingProfile(true);
    try {
      const profile: SyncProfile = {
        id: prefillProfile?.id ?? crypto.randomUUID(),
        name: saveProfileName.trim(),
        connectionProfileId: selectedConnectionProfileId,
        localPath,
        remotePrefix,
        direction,
        verifyChecksum,
        deleteExtraneous,
        lastRunMs: prefillProfile?.lastRunMs ?? null,
        ...(newProfileSchedule
          ? { schedule: newProfileSchedule }
          : prefillProfile?.schedule
            ? { schedule: prefillProfile.schedule }
            : {}),
      };
      await onSaveSyncProfile(profile);
      setSaveProfileVisible(false);
      setNewProfileSchedule(null);
    } finally {
      setSavingProfile(false);
    }
  };

  const toggleScheduleExpanded = (profileId: string) => {
    setExpandedSchedules((prev) => {
      const next = new Set(prev);
      if (next.has(profileId)) {
        next.delete(profileId);
      } else {
        next.add(profileId);
      }
      return next;
    });
  };

  const updateScheduleEdit = (profileId: string, profile: SyncProfile, patch: Partial<SyncSchedule>) => {
    setScheduleEdits((prev) => {
      const current = prev[profileId] ?? profile.schedule ?? defaultSchedule();
      const next: SyncSchedule = { ...current, ...patch };
      if (patch.frequency === 'weekly' && next.dayOfWeek === undefined) {
        next.dayOfWeek = 0;
      }
      return { ...prev, [profileId]: next };
    });
  };

  const handleSaveSchedule = async (profile: SyncProfile) => {
    const schedule = resolveSchedule(profile, scheduleEdits);
    setSavingScheduleId(profile.id);
    try {
      await onSaveSyncProfile({ ...profile, schedule });
      setScheduleEdits((prev) => {
        const next = { ...prev };
        delete next[profile.id];
        return next;
      });
    } finally {
      setSavingScheduleId(null);
    }
  };

  if (!isOpen) return null;

  // ── Counts summary ───────────────────────────────────────────────────────
  const counts = plan.reduce(
    (acc, e) => {
      acc[e.action] = (acc[e.action] ?? 0) + 1;
      return acc;
    },
    {} as Record<SyncPlanEntry['action'], number>,
  );
  const deleteCount = (counts.deleteRemote ?? 0) + (counts.deleteLocal ?? 0);

  // Group plan entries by action
  const groups: Record<string, SyncPlanEntry[]> = {};
  const ORDER: SyncPlanEntry['action'][] = ['upload', 'download', 'deleteRemote', 'deleteLocal', 'skip'];
  for (const action of ORDER) {
    const entries = plan.filter((e) => e.action === action);
    if (entries.length > 0) groups[action] = entries;
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl flex flex-col w-[720px] max-h-[88vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
          <div className="flex items-center space-x-3">
            <RefreshCw className="w-5 h-5 text-gale-teal" />
            <h2 className="text-lg font-semibold">Sync</h2>
            {/* Tab strip */}
            <div className="flex items-center space-x-1 ml-4">
              {(['form', 'diff', 'profiles'] as PanelView[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  disabled={v === 'diff' && plan.length === 0}
                  className={`px-3 py-1 text-xs rounded-full transition-colors font-medium
                    ${view === v
                      ? 'bg-gale-teal text-on-accent'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed'
                    }`}
                >
                  {v === 'form' ? 'Configure' : v === 'diff' ? `Diff${plan.length > 0 ? ` (${plan.length})` : ''}` : 'Saved Profiles'}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">

          {/* ── Form view ──────────────────────────────────────────────── */}
          {view === 'form' && (
            <div className="p-6 space-y-5">
              {/* Connection profile */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Connection Profile</label>
                <select
                  value={selectedConnectionProfileId}
                  onChange={(e) => setSelectedConnectionProfileId(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 focus:border-gale-teal focus:ring-1 focus:ring-gale-teal rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none transition-all"
                >
                  <option value="">— select a profile —</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              {/* Local path */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Local Folder</label>
                <div className="flex space-x-2">
                  <input
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    placeholder="/path/to/local/folder"
                    className="flex-1 bg-zinc-800 border border-zinc-700 focus:border-gale-teal focus:ring-1 focus:ring-gale-teal rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none transition-all placeholder:text-zinc-600 font-mono"
                  />
                  <button
                    onClick={handlePickLocalFolder}
                    className="flex items-center space-x-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-300 transition-colors"
                    title="Browse…"
                  >
                    <FolderOpen className="w-4 h-4" />
                    <span>Browse</span>
                  </button>
                </div>
              </div>

              {/* Remote prefix */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Remote Prefix</label>
                <input
                  value={remotePrefix}
                  onChange={(e) => setRemotePrefix(e.target.value)}
                  placeholder="prefix/path/"
                  className="w-full bg-zinc-800 border border-zinc-700 focus:border-gale-teal focus:ring-1 focus:ring-gale-teal rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none transition-all placeholder:text-zinc-600 font-mono"
                />
              </div>

              {/* Direction */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">Direction</label>
                <div className="flex space-x-3">
                  {(['localToRemote', 'remoteToLocal'] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDirection(d)}
                      className={`flex items-center space-x-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all flex-1 justify-center
                        ${direction === d
                          ? 'border-gale-teal bg-gale-teal/10 text-gale-teal'
                          : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                        }`}
                    >
                      {d === 'localToRemote'
                        ? <><ArrowUpFromLine className="w-4 h-4" /><span>Local → Remote</span></>
                        : <><ArrowDownToLine className="w-4 h-4" /><span>Remote → Local</span></>
                      }
                    </button>
                  ))}
                </div>
              </div>

              {/* Options */}
              <div className="space-y-3">
                <label className="block text-xs font-medium text-zinc-400">Options</label>
                <label className="flex items-center space-x-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={verifyChecksum}
                    onChange={(e) => setVerifyChecksum(e.target.checked)}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-gale-teal cursor-pointer"
                  />
                  <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">
                    Verify by checksum <span className="text-zinc-500">(slower, more accurate)</span>
                  </span>
                </label>
                <label className="flex items-center space-x-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={deleteExtraneous}
                    onChange={(e) => setDeleteExtraneous(e.target.checked)}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-gale-teal cursor-pointer"
                  />
                  <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">
                    Delete extraneous at destination{' '}
                    {deleteExtraneous && (
                      <span className="text-amber-400 text-xs font-medium">— will delete files not in source</span>
                    )}
                  </span>
                </label>
              </div>

              {/* Error */}
              {diffError && (
                <div className="flex items-start space-x-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{diffError}</span>
                </div>
              )}

              {/* CTA */}
              <div className="pt-1 flex items-center space-x-3">
                <button
                  onClick={handleComputeDiff}
                  disabled={diffLoading || !localPath || !remotePrefix}
                  className="flex items-center space-x-2 px-5 py-2 bg-gale-teal text-on-accent rounded-lg font-semibold text-sm hover:bg-deep-current hover:text-white transition-colors shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {diffLoading
                    ? <><Loader2 className="w-4 h-4 animate-spin" /><span>Computing diff…</span></>
                    : <><ChevronRight className="w-4 h-4" /><span>Preview diff</span></>
                  }
                </button>
              </div>
            </div>
          )}

          {/* ── Diff view ──────────────────────────────────────────────── */}
          {view === 'diff' && (
            <div className="flex flex-col h-full">
              {/* Summary bar */}
              <div className="px-6 py-3 border-b border-zinc-800 shrink-0 flex items-center space-x-4 font-mono text-sm">
                {(counts.upload ?? 0) > 0 && (
                  <span className="flex items-center space-x-1 text-gale-teal">
                    <ArrowUpFromLine className="w-3.5 h-3.5" />
                    <span className="tabular-nums">{counts.upload}</span>
                  </span>
                )}
                {(counts.download ?? 0) > 0 && (
                  <span className="flex items-center space-x-1 text-emerald-400">
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                    <span className="tabular-nums">{counts.download}</span>
                  </span>
                )}
                {(counts.skip ?? 0) > 0 && (
                  <span className="flex items-center space-x-1 text-zinc-500">
                    <Minus className="w-3.5 h-3.5" />
                    <span className="tabular-nums">{counts.skip}</span>
                  </span>
                )}
                {deleteCount > 0 && (
                  <span className="flex items-center space-x-1 text-red-500">
                    <Trash2 className="w-3.5 h-3.5" />
                    <span className="tabular-nums">{deleteCount}</span>
                  </span>
                )}
                {deleteCount > 0 && (
                  <span className="flex items-center space-x-1.5 text-amber-400 text-xs bg-amber-400/10 border border-amber-400/30 rounded px-2 py-0.5">
                    <AlertTriangle className="w-3 h-3" />
                    <span>{deleteCount} file{deleteCount !== 1 ? 's' : ''} will be deleted</span>
                  </span>
                )}
                <span className="ml-auto text-zinc-500 text-xs">{plan.length} total</span>
              </div>

              {/* Plan entries */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {Object.entries(groups).map(([action, entries]) => (
                  <div key={action}>
                    <div className="flex items-center space-x-2 mb-2 px-1">
                      {actionIcon(action as SyncPlanEntry['action'])}
                      <span className={`text-xs font-semibold uppercase tracking-widest
                        ${action === 'upload' ? 'text-gale-teal'
                          : action === 'download' ? 'text-emerald-400'
                          : isDeleteAction(action as SyncPlanEntry['action']) ? 'text-red-500'
                          : 'text-zinc-500'}`}>
                        {actionLabel(action as SyncPlanEntry['action'])} ({entries.length})
                      </span>
                    </div>
                    <div className="space-y-0.5 rounded-lg border border-zinc-800 overflow-hidden">
                      {entries.map((entry, idx) => (
                        <div
                          key={idx}
                          className={`flex items-center px-3 py-2 text-sm
                            ${isDeleteAction(entry.action)
                              ? 'bg-red-950/20 border-l-2 border-red-500'
                              : entry.action === 'skip'
                              ? 'bg-zinc-900/50'
                              : 'bg-zinc-800/30'}
                            ${idx % 2 === 0 ? '' : 'bg-opacity-50'}`}
                        >
                          <span className="flex-1 font-mono text-xs text-zinc-200 truncate">{entry.relativePath}</span>
                          <span className="text-zinc-500 text-xs ml-3 shrink-0 hidden sm:block">{entry.reason}</span>
                          <span className="font-mono text-xs text-zinc-500 ml-3 shrink-0 tabular-nums w-20 text-right">
                            {formatBytes(entry.localSize ?? entry.remoteSize)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {plan.length === 0 && (
                  <div className="text-center py-12 text-zinc-500">
                    <Minus className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    <p>Everything is in sync</p>
                  </div>
                )}
              </div>

              {/* Apply footer */}
              <div className="px-6 py-4 border-t border-zinc-800 shrink-0 space-y-3">
                {syncProgress && (
                  <div className="text-xs font-mono text-zinc-400 flex items-center space-x-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>{syncProgress.done}/{syncProgress.total} transferred</span>
                  </div>
                )}
                {applyError && (
                  <div className="flex items-start space-x-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{applyError}</span>
                  </div>
                )}

                {/* Delete confirmation */}
                {confirmDeleteOpen && (
                  <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/40">
                    <p className="text-sm text-amber-300 font-medium mb-1 flex items-center space-x-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>Confirm deletion</span>
                    </p>
                    <p className="text-xs text-zinc-400 mb-3">
                      This plan includes deleting <strong className="text-amber-400">{deleteCount} file{deleteCount !== 1 ? 's' : ''}</strong> at the destination. This cannot be undone.
                    </p>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={handleApply}
                        disabled={applyLoading}
                        className="px-4 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-500 font-medium transition-colors disabled:opacity-50"
                      >
                        {applyLoading ? 'Applying…' : 'Apply anyway'}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteOpen(false)}
                        className="px-4 py-1.5 text-sm rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {!confirmDeleteOpen && (
                  <div className="flex items-center space-x-3">
                    <button
                      onClick={handleApply}
                      disabled={applyLoading || plan.length === 0}
                      className="flex items-center space-x-2 px-5 py-2 bg-gale-teal text-on-accent rounded-lg font-semibold text-sm hover:bg-deep-current hover:text-white transition-colors shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {applyLoading
                        ? <><Loader2 className="w-4 h-4 animate-spin" /><span>Applying…</span></>
                        : <><Play className="w-4 h-4" /><span>Apply sync</span></>
                      }
                    </button>
                    <button
                      onClick={() => setView('form')}
                      className="px-4 py-2 text-sm rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
                    >
                      Back
                    </button>
                    {/* Save as profile */}
                    {!saveProfileVisible ? (
                      <button
                        onClick={() => setSaveProfileVisible(true)}
                        className="flex items-center space-x-1.5 ml-auto px-3 py-2 text-xs rounded-lg border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>Save as profile</span>
                      </button>
                    ) : (
                      <div className="ml-auto flex items-center space-x-2">
                        <input
                          value={saveProfileName}
                          onChange={(e) => setSaveProfileName(e.target.value)}
                          placeholder="Profile name…"
                          className="bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded-lg px-3 py-1.5 text-xs text-zinc-200 outline-none transition-all w-36 placeholder:text-zinc-600"
                          onKeyDown={(e) => { if (e.key === 'Enter') handleSaveProfile(); }}
                        />
                        <button
                          onClick={handleSaveProfile}
                          disabled={savingProfile || !saveProfileName.trim()}
                          className="px-3 py-1.5 text-xs rounded-lg bg-gale-teal text-on-accent font-semibold hover:bg-deep-current hover:text-white transition-colors disabled:opacity-50"
                        >
                          {savingProfile ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={() => setSaveProfileVisible(false)}
                          className="p-1.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Saved Profiles view ─────────────────────────────────────── */}
          {view === 'profiles' && (
            <div className="p-6">
              {syncProfiles.length === 0 ? (
                <div className="text-center py-12 text-zinc-500">
                  <Save className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p>No saved sync profiles</p>
                  <p className="text-xs mt-1">Configure a sync and save it as a profile for one-click runs.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {syncProfiles.map((sp) => {
                    const connProfile = profiles.find((p) => p.id === sp.connectionProfileId);
                    const scheduleExpanded = expandedSchedules.has(sp.id);
                    const schedule = resolveSchedule(sp, scheduleEdits);
                    const displayNextRunMs = scheduleEdits[sp.id]?.nextRunMs ?? sp.schedule?.nextRunMs;
                    return (
                      <div
                        key={sp.id}
                        className="rounded-lg border border-zinc-800 bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors group"
                      >
                        <div className="flex items-center p-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center space-x-2 mb-1">
                              <span className="font-medium text-sm text-zinc-200">{sp.name}</span>
                              <span className={`text-xs px-1.5 py-0.5 rounded font-mono
                                ${sp.direction === 'localToRemote'
                                  ? 'bg-gale-teal/15 text-gale-teal'
                                  : 'bg-emerald-400/15 text-emerald-400'}`}>
                                {sp.direction === 'localToRemote' ? '→ remote' : '← local'}
                              </span>
                              {sp.deleteExtraneous && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400 font-mono">
                                  delete extra
                                </span>
                              )}
                              {sp.schedule?.enabled && (
                                <span className="text-xs px-1.5 py-0.5 rounded bg-gale-teal/10 text-gale-teal font-mono flex items-center space-x-1">
                                  <Clock className="w-3 h-3" />
                                  <span>scheduled</span>
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-zinc-500 truncate font-mono">
                              <span>{sp.localPath}</span>
                              <span className="mx-1 text-zinc-600">↔</span>
                              <span>{connProfile?.name ?? 'Unknown'}: {sp.remotePrefix || '/'}</span>
                            </div>
                            {sp.lastRunMs && (
                              <div className="text-xs text-zinc-600 mt-0.5 font-mono">
                                Last run: {new Date(sp.lastRunMs).toLocaleString()}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center space-x-2 ml-3 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => {
                                setSelectedConnectionProfileId(sp.connectionProfileId);
                                setLocalPath(sp.localPath);
                                setRemotePrefix(sp.remotePrefix);
                                setDirection(sp.direction);
                                setVerifyChecksum(sp.verifyChecksum);
                                setDeleteExtraneous(sp.deleteExtraneous);
                                setSaveProfileName(sp.name);
                                setView('form');
                              }}
                              className="flex items-center space-x-1 px-3 py-1.5 text-xs rounded-lg bg-gale-teal text-on-accent font-semibold hover:bg-deep-current hover:text-white transition-colors"
                              title="Load and run"
                            >
                              <Play className="w-3 h-3" />
                              <span>Run</span>
                            </button>
                            <button
                              onClick={() => onDeleteSyncProfile(sp.id)}
                              className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors rounded"
                              title="Delete profile"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        {/* Collapsible schedule section */}
                        <div className="border-t border-zinc-800/80">
                          <button
                            type="button"
                            onClick={() => toggleScheduleExpanded(sp.id)}
                            className="w-full flex items-center space-x-2 px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 transition-colors"
                          >
                            {scheduleExpanded
                              ? <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                              : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
                            <Clock className="w-3.5 h-3.5 shrink-0 text-gale-teal" />
                            <span className="font-medium">Schedule</span>
                            {sp.schedule?.enabled && !scheduleExpanded && (
                              <span className="text-zinc-600 font-mono">
                                · {sp.schedule.frequency}
                                {sp.schedule.nextRunMs != null && (
                                  <> · next {new Date(sp.schedule.nextRunMs).toLocaleString()}</>
                                )}
                              </span>
                            )}
                          </button>

                          {scheduleExpanded && (
                            <div className="px-4 pb-3 space-y-3">
                              <label className="flex items-center space-x-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={schedule.enabled}
                                  onChange={(e) => updateScheduleEdit(sp.id, sp, { enabled: e.target.checked })}
                                  className="w-3.5 h-3.5 rounded border-zinc-600 bg-zinc-800 accent-gale-teal cursor-pointer"
                                />
                                <span className="text-xs text-zinc-300">Enable scheduled runs</span>
                              </label>

                              <div className="flex flex-wrap items-center gap-2">
                                <label className="text-xs text-zinc-500 shrink-0">Frequency</label>
                                <select
                                  value={schedule.frequency}
                                  onChange={(e) => updateScheduleEdit(sp.id, sp, {
                                    frequency: e.target.value as SyncSchedule['frequency'],
                                  })}
                                  className="bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded px-2 py-1 text-xs text-zinc-200 outline-none"
                                >
                                  <option value="once">Once</option>
                                  <option value="hourly">Hourly</option>
                                  <option value="daily">Daily</option>
                                  <option value="weekly">Weekly</option>
                                </select>

                                {(schedule.frequency === 'daily' || schedule.frequency === 'weekly') && (
                                  <>
                                    <input
                                      type="number"
                                      min={0}
                                      max={23}
                                      value={schedule.atHour}
                                      onChange={(e) => updateScheduleEdit(sp.id, sp, { atHour: clampHour(Number(e.target.value)) })}
                                      className="w-14 bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded px-2 py-1 text-xs text-zinc-200 font-mono outline-none"
                                      title="Hour (0–23)"
                                    />
                                    <span className="text-xs text-zinc-600">:</span>
                                    <input
                                      type="number"
                                      min={0}
                                      max={59}
                                      value={schedule.atMinute}
                                      onChange={(e) => updateScheduleEdit(sp.id, sp, { atMinute: clampMinute(Number(e.target.value)) })}
                                      className="w-14 bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded px-2 py-1 text-xs text-zinc-200 font-mono outline-none"
                                      title="Minute (0–59)"
                                    />
                                  </>
                                )}

                                {schedule.frequency === 'weekly' && (
                                  <select
                                    value={schedule.dayOfWeek ?? 0}
                                    onChange={(e) => updateScheduleEdit(sp.id, sp, { dayOfWeek: Number(e.target.value) })}
                                    className="bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded px-2 py-1 text-xs text-zinc-200 outline-none"
                                  >
                                    {DAYS_OF_WEEK.map((day, idx) => (
                                      <option key={day} value={idx}>{day}</option>
                                    ))}
                                  </select>
                                )}
                              </div>

                              {displayNextRunMs != null && schedule.enabled && (
                                <div className="text-xs text-zinc-500 font-mono">
                                  Next run: {new Date(displayNextRunMs).toLocaleString()}
                                </div>
                              )}

                              <button
                                type="button"
                                onClick={() => handleSaveSchedule(sp)}
                                disabled={savingScheduleId === sp.id}
                                className="flex items-center space-x-1.5 px-3 py-1.5 text-xs rounded-lg bg-gale-teal text-on-accent font-semibold hover:bg-deep-current hover:text-white transition-colors disabled:opacity-50"
                              >
                                {savingScheduleId === sp.id
                                  ? <><Loader2 className="w-3 h-3 animate-spin" /><span>Saving…</span></>
                                  : <><Save className="w-3 h-3" /><span>Save schedule</span></>
                                }
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
