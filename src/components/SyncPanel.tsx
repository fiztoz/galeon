import { Select } from './Select';
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
  Loader2,
} from 'lucide-react';
import { ConnectionProfile, type SyncRunOutcome } from '../types';
import { useSyncRunLog } from '../hooks/useSyncRunLog';
import { SyncProfilesView } from './SyncProfilesView';
import {
  actionLabel,
  defaultSchedule,
  findOverwrites,
  formatBytes,
  isDeleteAction,
  isSyncPlanStale,
  manualRunAttribution,
  resolveSchedule,
  type SyncDiffInputs,
  type SyncPlanEntry,
  type SyncProfile,
  type SyncSchedule,
} from '../syncModel';

function actionIcon(action: SyncPlanEntry['action']) {
  switch (action) {
    case 'upload': return <ArrowUpFromLine className="w-3.5 h-3.5 text-gale-teal" />;
    case 'download': return <ArrowDownToLine className="w-3.5 h-3.5 text-status-success" />;
    case 'skip': return <Minus className="w-3.5 h-3.5 text-zinc-500" />;
    case 'deleteRemote': return <Trash2 className="w-3.5 h-3.5 text-status-danger" />;
    case 'deleteLocal': return <Trash2 className="w-3.5 h-3.5 text-status-danger" />;
  }
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
  /** Auto-compute the diff once the prefilled profile is loaded ("run now");
   *  execution still goes through the diff + delete-confirmation flow */
  runNow?: boolean;
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
  runNow,
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
  // Unattended-delete allowance for SCHEDULED runs. 0 = never delete on a
  // schedule — the default a new profile starts on, and what "delete
  // extraneous" alone (no number) must fall back to.
  const [maxScheduledDeletes, setMaxScheduledDeletes] = useState(0);

  // ── Diff state ──────────────────────────────────────────────────────────
  const [plan, setPlan] = useState<SyncPlanEntry[]>([]);
  // Inputs the current plan was computed from — compared against the live form
  // to detect a stale plan (see isSyncPlanStale).
  const [planInputs, setPlanInputs] = useState<SyncDiffInputs | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  // Set when "Run sync profile now" prefills the panel; consumed by the
  // auto-run effect below so the diff is computed with the loaded inputs.
  const [autoRunPending, setAutoRunPending] = useState(false);

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
  // Pending per-profile edits of the scheduled-delete budget (the profile's
  // `maxScheduledDeletes`), saved together with the schedule. Absent = unchanged.
  const [budgetEdits, setBudgetEdits] = useState<Record<string, number>>({});
  const [savingScheduleId, setSavingScheduleId] = useState<string | null>(null);

  // ── Run history (profiles view) ─────────────────────────────────────────
  // Fetch/clear state lives in the hook so this file stays a shell (AGENTS 4.3).
  const runLog = useSyncRunLog();
  const refreshRuns = runLog.refresh;
  useEffect(() => {
    if (!isOpen || view !== 'profiles') return;
    void refreshRuns();
  }, [isOpen, view, refreshRuns]);

  // ── Staleness derivation ────────────────────────────────────────────────
  // Any input that feeds compute_sync_diff changing invalidates the reviewed
  // plan — Apply is blocked until the diff is recomputed from these inputs.
  const currentDiffInputs: SyncDiffInputs = {
    localPath,
    remotePrefix,
    direction,
    verifyChecksum,
    deleteExtraneous,
  };
  const planStale = isSyncPlanStale(planInputs, currentDiffInputs, plan.length);

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
      setMaxScheduledDeletes(prefillProfile.maxScheduledDeletes ?? 0);
      setSaveProfileName(prefillProfile.name);
    } else {
      // Default: current prefix, first connection profile selected
      setRemotePrefix(currentRemotePrefix);
      setSelectedConnectionProfileId(profiles[0]?.id ?? '');
    }
    // Always reset computed state on open
    setPlan([]);
    setPlanInputs(null);
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
    // "Run now" requests a diff as soon as the prefill state has landed.
    setAutoRunPending(Boolean(runNow && prefillProfile));
  }, [isOpen, prefillProfile, runNow]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setPlanInputs(null);
    try {
      const result = await invoke<SyncPlanEntry[]>('compute_sync_diff', {
        sessionId,
        localPath,
        remotePrefix,
        direction,
        options: { verifyChecksum, deleteExtraneous },
      });
      setPlan(result);
      // Record exactly what this plan was computed from, so later input edits
      // mark it stale instead of silently running against new paths.
      setPlanInputs({ localPath, remotePrefix, direction, verifyChecksum, deleteExtraneous });
      setView('diff');
    } catch (err) {
      setDiffError(String(err));
      // diffError only renders on the form view — land there when a recompute
      // started from the diff view fails, so the failure is never invisible.
      setView('form');
    } finally {
      setDiffLoading(false);
    }
  }, [sessionId, localPath, remotePrefix, direction, verifyChecksum, deleteExtraneous]);

  // "Run sync profile now": once the prefill effect has loaded the profile's
  // inputs, compute the diff so the run lands on a reviewable plan. The pending
  // flag is consumed synchronously; a failure stays on the form with diffError.
  useEffect(() => {
    if (!isOpen || !autoRunPending) return;
    setAutoRunPending(false);
    void handleComputeDiff();
  }, [isOpen, autoRunPending, handleComputeDiff]);

  const handleApply = useCallback(async () => {
    // Never execute a plan that no longer describes the current inputs — the
    // user would confirm one set of deletions and run another.
    if (planStale) {
      setApplyError('Sync settings changed after this diff was computed. Recompute the diff before applying.');
      return;
    }
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
      // Attribute the run to the loaded profile only when the settings it
      // executed still match that profile; edits turn it ad-hoc.
      const attribution = manualRunAttribution(prefillProfile, {
        connectionProfileId: selectedConnectionProfileId,
        localPath,
        remotePrefix,
        direction,
        verifyChecksum,
        deleteExtraneous,
      });
      // The backend waits for the real transfer outcomes, records the manual
      // run, and answers with the finished run summary (Wire: `SyncRunOutcome`).
      // The stale-plan guard above ran before this point either way.
      const outcome = await invoke<SyncRunOutcome>('execute_sync_plan', {
        sessionId,
        plan,
        deleteExtraneous,
        localPath,
        remotePrefix,
        profileId: connectionProfileId ?? null,
        syncProfileId: attribution?.profileId ?? null,
        syncProfileName: attribution?.profileName ?? null,
      });
      // Refresh history now so this run's row appears without a reload.
      void refreshRuns();
      if (outcome.failures.length > 0) {
        setApplyError(`${outcome.failures.length} sync item(s) failed`);
        return;
      }
      onSyncComplete();
      onClose();
    } catch (err) {
      setApplyError(String(err));
    } finally {
      setApplyLoading(false);
    }
  }, [plan, planStale, sessionId, deleteExtraneous, localPath, remotePrefix, connectionProfileId, selectedConnectionProfileId, direction, verifyChecksum, prefillProfile, confirmDeleteOpen, refreshRuns, onSyncComplete, onClose]);

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
        maxScheduledDeletes,
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
      await onSaveSyncProfile({
        ...profile,
        schedule,
        maxScheduledDeletes: budgetEdits[profile.id] ?? profile.maxScheduledDeletes,
      });
      setScheduleEdits((prev) => {
        const next = { ...prev };
        delete next[profile.id];
        return next;
      });
      setBudgetEdits((prev) => {
        const next = { ...prev };
        delete next[profile.id];
        return next;
      });
    } finally {
      setSavingScheduleId(null);
    }
  };

  /** Load a saved profile back into the form, ready to run. */
  const loadProfileIntoForm = (sp: SyncProfile) => {
    setSelectedConnectionProfileId(sp.connectionProfileId);
    setLocalPath(sp.localPath);
    setRemotePrefix(sp.remotePrefix);
    setDirection(sp.direction);
    setVerifyChecksum(sp.verifyChecksum);
    setDeleteExtraneous(sp.deleteExtraneous);
    setMaxScheduledDeletes(sp.maxScheduledDeletes ?? 0);
    setSaveProfileName(sp.name);
    setView('form');
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
  // Copies that will replace a NEWER file at the destination. Expected for
  // one-way sync (the source is authoritative), but the plan only says "size
  // differs", so say it plainly rather than letting the user discover it.
  const overwrites = planStale ? [] : findOverwrites(plan, direction);
  // The delete-confirmation block must never show for a stale plan: its count
  // comes from a plan that no longer describes the current inputs.
  const showConfirmBlock = confirmDeleteOpen && !planStale;

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
      <div className="bg-zinc-900 border border-zinc-800 galeon-modal-panel rounded-xl shadow-2xl flex flex-col w-[720px] max-h-[88vh]">
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
                  title={v === 'diff' && planStale ? 'Settings changed since this diff — recompute it before applying' : undefined}
                  className={`px-3 py-1 text-xs rounded-full transition-colors font-medium
                    ${view === v
                      ? 'bg-gale-teal text-on-accent'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed'
                    }`}
                >
                  {v === 'form' ? 'Configure' : v === 'diff' ? `Diff${plan.length > 0 ? ` (${plan.length})` : ''}${planStale ? ' ⚠' : ''}` : 'Saved Profiles'}
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
                <Select aria-label="Connection profile"
                  value={selectedConnectionProfileId}
                  onValueChange={(value) => setSelectedConnectionProfileId(value)}
                  className="w-full bg-zinc-800 border border-zinc-700 focus:border-gale-teal focus:ring-1 focus:ring-gale-teal rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none transition-all"
                >
                  <option value="">— select a profile —</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </div>

              {/* Local path */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Local Folder</label>
                <div className="flex space-x-2">
                  <input
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                    placeholder="/path/to/local/folder"
                    className="flex-1 bg-zinc-800 border border-zinc-700 focus:border-gale-teal focus:ring-1 focus:ring-gale-teal rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none transition-all placeholder:text-zinc-500 font-mono"
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
                  className="w-full bg-zinc-800 border border-zinc-700 focus:border-gale-teal focus:ring-1 focus:ring-gale-teal rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none transition-all placeholder:text-zinc-500 font-mono"
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
                      <span className="text-status-warning text-xs font-medium">— will delete files not in source</span>
                    )}
                  </span>
                </label>
                {deleteExtraneous && (
                  <div className="ml-7 space-y-1.5">
                    <label className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                      <span className="shrink-0">Scheduled runs may delete up to</span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={maxScheduledDeletes}
                        onChange={(e) => {
                          const v = Number.parseInt(e.target.value, 10);
                          setMaxScheduledDeletes(Number.isNaN(v) ? 0 : Math.max(0, v));
                        }}
                        className="w-16 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-gale-teal"
                        aria-label="Maximum objects a scheduled run may delete"
                      />
                      <span className="shrink-0">objects</span>
                    </label>
                    <p className="text-xs text-zinc-600">
                      0 (default) means scheduled runs never delete. A run over its limit
                      skips every deletion instead of stopping partway. Manual runs always
                      preview the diff and confirm before touching anything.
                    </p>
                  </div>
                )}
              </div>

              {/* Error */}
              {diffError && (
                <div className="flex items-start space-x-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-status-danger text-sm">
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
                  <span className="flex items-center space-x-1 text-status-success">
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
                  <span className="flex items-center space-x-1 text-status-danger">
                    <Trash2 className="w-3.5 h-3.5" />
                    <span className="tabular-nums">{deleteCount}</span>
                  </span>
                )}
                {deleteCount > 0 && !planStale && (
                  <span className="flex items-center space-x-1.5 text-status-warning text-xs bg-amber-400/10 border border-amber-400/30 rounded px-2 py-0.5">
                    <AlertTriangle className="w-3 h-3" />
                    <span>{deleteCount} file{deleteCount !== 1 ? 's' : ''} will be deleted</span>
                  </span>
                )}
                <span className="ml-auto text-zinc-500 text-xs">{plan.length} total</span>
              </div>

              {/* Stale plan — an input feeding this diff changed */}
              {planStale && (
                <div className="px-6 py-3 border-b border-zinc-800 shrink-0 bg-amber-500/5 flex items-start space-x-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-status-warning" />
                  <div id="sync-stale-warning" className="flex-1 text-xs text-zinc-300 leading-relaxed">
                    <span className="text-status-warning font-semibold">This diff is out of date.</span>{' '}
                    The sync settings changed after it was computed
                    {deleteCount > 0 ? ` — it listed ${deleteCount} file${deleteCount === 1 ? '' : 's'} to delete` : ''},
                    so it no longer describes what Apply would run. Recompute the diff before applying.
                  </div>
                  <button
                    onClick={() => void handleComputeDiff()}
                    disabled={diffLoading}
                    className="shrink-0 px-3 py-1.5 text-xs rounded-lg bg-gale-teal text-on-accent font-semibold hover:bg-deep-current hover:text-white transition-colors disabled:opacity-50"
                  >
                    {diffLoading ? 'Recomputing…' : 'Recompute diff'}
                  </button>
                  <button
                    onClick={() => setView('form')}
                    className="shrink-0 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    Edit settings
                  </button>
                </div>
              )}

              {overwrites.length > 0 && (
                <div className="mx-4 mt-4 px-3 py-2 rounded-lg bg-status-warning/10 border border-status-warning/30 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-status-warning" />
                  <p className="text-xs text-zinc-300 leading-relaxed">
                    <span className="text-status-warning font-semibold">
                      {overwrites.length} file{overwrites.length === 1 ? '' : 's'} will overwrite a
                      newer copy
                    </span>{' '}
                    at the {direction === 'localToRemote' ? 'remote' : 'local'} destination. That is
                    how one-way sync works — the source wins — but the newer version will be gone
                    afterwards
                    {overwrites.length > 0 && (
                      <span className="block mt-1 text-zinc-500">
                        e.g.{' '}
                        {overwrites
                          .slice(0, 3)
                          .map((o) => o.relativePath)
                          .join(', ')}
                        {overwrites.length > 3 ? ` and ${overwrites.length - 3} more` : ''}
                      </span>
                    )}
                    .
                  </p>
                </div>
              )}

              {/* Plan entries */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {Object.entries(groups).map(([action, entries]) => (
                  <div key={action}>
                    <div className="flex items-center space-x-2 mb-2 px-1">
                      {actionIcon(action as SyncPlanEntry['action'])}
                      <span className={`text-xs font-semibold uppercase tracking-widest
                        ${action === 'upload' ? 'text-gale-teal'
                          : action === 'download' ? 'text-status-success'
                          : isDeleteAction(action as SyncPlanEntry['action']) ? 'text-status-danger'
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
                              ? 'bg-status-danger/10 border-l-2 border-red-500'
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
                    {diffLoading
                      ? <p>Computing diff…</p>
                      : <p>Everything is in sync</p>}
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
                  <div className="flex items-start space-x-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-status-danger text-sm">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{applyError}</span>
                  </div>
                )}

                {/* Delete confirmation — only for a fresh plan (showConfirmBlock) */}
                {showConfirmBlock && (
                  <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/40">
                    <p className="text-sm text-status-warning font-medium mb-1 flex items-center space-x-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>Confirm deletion</span>
                    </p>
                    <p className="text-xs text-zinc-400 mb-3">
                      This plan includes deleting <strong className="text-status-warning">{deleteCount} file{deleteCount !== 1 ? 's' : ''}</strong> at the destination. This cannot be undone.
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

                {!showConfirmBlock && (
                  <div className="flex items-center space-x-3">
                    <button
                      onClick={handleApply}
                      disabled={applyLoading || plan.length === 0 || planStale}
                      title={planStale ? 'Sync settings changed — recompute the diff first' : undefined}
                      aria-describedby={planStale ? 'sync-stale-warning' : undefined}
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
                          className="bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded-lg px-3 py-1.5 text-xs text-zinc-200 outline-none transition-all w-36 placeholder:text-zinc-500"
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
            <SyncProfilesView
              syncProfiles={syncProfiles}
              profiles={profiles}
              expandedSchedules={expandedSchedules}
              scheduleEdits={scheduleEdits}
              budgetEdits={budgetEdits}
              savingScheduleId={savingScheduleId}
              runLog={runLog}
              onToggleSchedule={toggleScheduleExpanded}
              onUpdateSchedule={updateScheduleEdit}
              onBudgetEdit={(profileId, value) =>
                setBudgetEdits((prev) => ({ ...prev, [profileId]: value }))}
              onSaveSchedule={handleSaveSchedule}
              onDeleteProfile={onDeleteSyncProfile}
              onLoadProfile={loadProfileIntoForm}
            />
          )}
        </div>
      </div>
    </div>
  );
}
