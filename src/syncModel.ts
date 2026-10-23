/**
 * The frontend's model of a sync: the contract types and the rules about them.
 *
 * Everything here is pure and unit-tested. The panel that renders it lives in
 * `components/SyncPanel.tsx`; this file is the part that decides *what* a sync
 * means, so it can be reasoned about (and tested) without a dialog.
 */

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
  /**
   * The most destination objects a SCHEDULED run may permanently delete.
   * 0 = a scheduled run never deletes (safe default). Manual runs unaffected:
   * they preview the diff and confirm before anything runs.
   */
  maxScheduledDeletes: number;
  lastRunMs: number | null;
  schedule?: SyncSchedule;
}

// ── Helper utilities ─────────────────────────────────────────────────────────

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function actionLabel(action: SyncPlanEntry['action']): string {
  switch (action) {
    case 'upload': return 'Upload';
    case 'download': return 'Download';
    case 'skip': return 'Skip';
    case 'deleteRemote': return 'Delete remote';
    case 'deleteLocal': return 'Delete local';
  }
}

export function isDeleteAction(action: SyncPlanEntry['action']): boolean {
  return action === 'deleteRemote' || action === 'deleteLocal';
}

export const DAYS_OF_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

// ── Diff staleness ──────────────────────────────────────────────────────────

/**
 * The exact inputs a sync plan was computed from. `execute_sync_plan` resolves
 * every `deleteLocal` / `deleteRemote` entry against the LIVE local path and
 * remote prefix, so a plan computed from different inputs must never run — the
 * deletions it lists (and the count the confirmation shows) would not describe
 * the deletions performed.
 */
export interface SyncDiffInputs {
  localPath: string;
  remotePrefix: string;
  direction: 'localToRemote' | 'remoteToLocal';
  verifyChecksum: boolean;
  deleteExtraneous: boolean;
}

/**
 * A plan is stale when it exists but was computed from other inputs.
 * `recorded === null` (no successful diff yet) counts as stale for a non-empty
 * plan — fail closed, never fail open.
 */
export function isSyncPlanStale(
  recorded: SyncDiffInputs | null,
  current: SyncDiffInputs,
  planLength: number,
): boolean {
  if (planLength === 0) return false; // no plan, nothing to invalidate
  if (!recorded) return true;
  return (
    recorded.localPath !== current.localPath ||
    recorded.remotePrefix !== current.remotePrefix ||
    recorded.direction !== current.direction ||
    recorded.verifyChecksum !== current.verifyChecksum ||
    recorded.deleteExtraneous !== current.deleteExtraneous
  );
}

/**
 * Which saved sync profile a manual (panel-executed) run belongs to, or `null`
 * for an ad-hoc run. Every saved-sync-profile load fills the form from that
 * profile; if the settings the run actually used still equal the loaded
 * profile's, the history row can honestly carry its name and id. One edit
 * anywhere in the execution-relevant inputs and the run is no longer what the
 * profile described — ad-hoc then, so the log never blames a profile for
 * settings it did not have when the run executed.
 *
 * Deliberately NOT compared: the display name being retyped, the schedule
 * (manual runs are not schedule-driven), and `maxScheduledDeletes` — manual
 * runs never consult the budget, so a budget edit does not change what this
 * run does.
 */
export interface ManualRunAttribution {
  profileId: string;
  profileName: string;
}

export function manualRunAttribution(
  loadedFrom: SyncProfile | null | undefined,
  inputs: SyncDiffInputs & { connectionProfileId: string },
): ManualRunAttribution | null {
  if (
    loadedFrom &&
    loadedFrom.connectionProfileId === inputs.connectionProfileId &&
    loadedFrom.localPath === inputs.localPath &&
    loadedFrom.remotePrefix === inputs.remotePrefix &&
    loadedFrom.direction === inputs.direction &&
    loadedFrom.verifyChecksum === inputs.verifyChecksum &&
    loadedFrom.deleteExtraneous === inputs.deleteExtraneous
  ) {
    return { profileId: loadedFrom.id, profileName: loadedFrom.name };
  }
  return null;
}

/**
 * Copy entries whose DESTINATION is newer than the source — i.e. the sync will
 * overwrite a file the user changed more recently.
 *
 * This is not a bug: one-way sync means the source is authoritative, so a
 * differing file is copied source-over-destination by design. The planner's
 * `reason` only says "size differs", though, which gives no hint that a newer
 * file is about to be replaced. The plan carries both timestamps, so the UI can
 * say so.
 */
export interface OverwriteWarning {
  relativePath: string;
  /** Which side gets replaced. */
  destination: 'local' | 'remote';
}

const COPY_ACTIONS = new Set(['upload', 'download']);

export function findOverwrites(
  plan: readonly SyncPlanEntry[],
  direction: 'localToRemote' | 'remoteToLocal',
): OverwriteWarning[] {
  const out: OverwriteWarning[] = [];
  for (const entry of plan) {
    if (!COPY_ACTIONS.has(entry.action)) continue;
    if (!entry.localModified || !entry.remoteModified) continue;
    const local = Date.parse(entry.localModified);
    const remote = Date.parse(entry.remoteModified);
    if (Number.isNaN(local) || Number.isNaN(remote)) continue;
    // localToRemote uploads local over remote, so the destination is the remote
    // side; remoteToLocal is the mirror. Only the NEWER side being the
    // destination is worth surfacing.
    const destinationIsNewer =
      direction === 'localToRemote' ? remote > local : local > remote;
    if (destinationIsNewer) {
      out.push({
        relativePath: entry.relativePath,
        destination: direction === 'localToRemote' ? 'remote' : 'local',
      });
    }
  }
  return out;
}

export function defaultSchedule(): SyncSchedule {
  return {
    enabled: false,
    frequency: 'daily',
    atHour: 2,
    atMinute: 0,
  };
}

export function resolveSchedule(profile: SyncProfile, edits: Record<string, SyncSchedule>): SyncSchedule {
  return edits[profile.id] ?? profile.schedule ?? defaultSchedule();
}

export function clampHour(value: number): number {
  return Math.min(23, Math.max(0, Math.floor(value) || 0));
}

export function clampMinute(value: number): number {
  return Math.min(59, Math.max(0, Math.floor(value) || 0));
}
