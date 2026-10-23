import React from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Play,
  Save,
  Trash2,
} from 'lucide-react';
import { Select } from './Select';
import { SyncRunHistory } from './SyncRunHistory';
import type { SyncRunLog } from '../hooks/useSyncRunLog';
import type { ConnectionProfile } from '../types';
import {
  DAYS_OF_WEEK,
  clampHour,
  clampMinute,
  resolveSchedule,
  type SyncProfile,
  type SyncSchedule,
} from '../syncModel';

type Props = {
  /** The saved sync profiles. */
  syncProfiles: SyncProfile[];
  /** Connection profiles, for naming the destination of each sync. */
  profiles: ConnectionProfile[];
  /** Which profiles have their schedule section expanded. */
  expandedSchedules: Set<string>;
  /** Uncommitted schedule edits, keyed by profile id. */
  scheduleEdits: Record<string, SyncSchedule>;
  /** Uncommitted delete-budget edits, keyed by profile id. */
  budgetEdits: Record<string, number>;
  /** The profile whose schedule is being saved right now. */
  savingScheduleId: string | null;
  /** What each run actually did — deletions included. */
  runLog: SyncRunLog;

  onToggleSchedule: (profileId: string) => void;
  onUpdateSchedule: (profileId: string, profile: SyncProfile, patch: Partial<SyncSchedule>) => void;
  onBudgetEdit: (profileId: string, value: number) => void;
  onSaveSchedule: (profile: SyncProfile) => void;
  onDeleteProfile: (profileId: string) => void;
  /** Load a saved profile back into the form, ready to run. */
  onLoadProfile: (profile: SyncProfile) => void;
};

/**
 * The saved-profiles view: the profiles themselves, their schedules, and what
 * each run did.
 *
 * Nothing here computes a plan or deletes anything — the panel owns the
 * execution, and this view only edits what the panel will run.
 */
export const SyncProfilesView: React.FC<Props> = ({
  syncProfiles,
  profiles,
  expandedSchedules,
  scheduleEdits,
  budgetEdits,
  savingScheduleId,
  runLog,
  onToggleSchedule,
  onUpdateSchedule,
  onBudgetEdit,
  onSaveSchedule,
  onDeleteProfile,
  onLoadProfile,
}) => (
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
                        : 'bg-emerald-400/15 text-status-success'}`}>
                      {sp.direction === 'localToRemote' ? '→ remote' : '← local'}
                    </span>
                    {sp.deleteExtraneous && (
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                          (sp.maxScheduledDeletes ?? 0) === 0
                            ? 'bg-amber-400/15 text-status-warning'
                            : 'bg-emerald-400/15 text-status-success'
                        }`}
                        title={
                          (sp.maxScheduledDeletes ?? 0) === 0
                            ? 'Scheduled runs will not delete anything until you allow a budget'
                            : `Scheduled runs may delete up to ${sp.maxScheduledDeletes} objects`
                        }
                      >
                        {(sp.maxScheduledDeletes ?? 0) === 0
                          ? 'delete extra · scheduled never'
                          : `delete extra · scheduled ≤ ${sp.maxScheduledDeletes}`}
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
                    <span className="mx-1 text-zinc-500">↔</span>
                    <span>{connProfile?.name ?? 'Unknown'}: {sp.remotePrefix || '/'}</span>
                  </div>
                  {sp.lastRunMs && (
                    <div className="text-xs text-zinc-500 mt-0.5 font-mono">
                      Last run: {new Date(sp.lastRunMs).toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="flex items-center space-x-2 ml-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => onLoadProfile(sp)}
                    className="flex items-center space-x-1 px-3 py-1.5 text-xs rounded-lg bg-gale-teal text-on-accent font-semibold hover:bg-deep-current hover:text-white transition-colors"
                    title="Load and run"
                  >
                    <Play className="w-3 h-3" />
                    <span>Run</span>
                  </button>
                  <button
                    onClick={() => onDeleteProfile(sp.id)}
                    className="p-1.5 text-zinc-500 hover:text-status-danger transition-colors rounded"
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
                  onClick={() => onToggleSchedule(sp.id)}
                  className="w-full flex items-center space-x-2 px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 transition-colors"
                >
                  {scheduleExpanded
                    ? <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                    : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
                  <Clock className="w-3.5 h-3.5 shrink-0 text-gale-teal" />
                  <span className="font-medium">Schedule</span>
                  {sp.schedule?.enabled && !scheduleExpanded && (
                    <span className="text-zinc-500 font-mono">
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
                        onChange={(e) => onUpdateSchedule(sp.id, sp, { enabled: e.target.checked })}
                        className="w-3.5 h-3.5 rounded border-zinc-600 bg-zinc-800 accent-gale-teal cursor-pointer"
                      />
                      <span className="text-xs text-zinc-300">Enable scheduled runs</span>
                    </label>

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-xs text-zinc-500 shrink-0">Unattended deletes ≤</label>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={budgetEdits[sp.id] ?? (sp.maxScheduledDeletes ?? 0)}
                        onChange={(e) => {
                          const v = Number.parseInt(e.target.value, 10);
                          onBudgetEdit(sp.id, Number.isNaN(v) ? 0 : Math.max(0, v));
                        }}
                        className="w-16 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-gale-teal"
                        aria-label="Maximum objects a scheduled run may delete"
                      />
                      <span className="text-xs text-zinc-600">0 = a scheduled run never deletes</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-xs text-zinc-500 shrink-0">Frequency</label>
                      <Select aria-label="Schedule frequency"
                        value={schedule.frequency}
                        onValueChange={(value) => onUpdateSchedule(sp.id, sp, {
                          frequency: value as SyncSchedule['frequency'],
                        })}
                        className="bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded px-2 py-1 text-xs text-zinc-200 outline-none"
                      >
                        <option value="once">Once</option>
                        <option value="hourly">Hourly</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                      </Select>

                      {(schedule.frequency === 'daily' || schedule.frequency === 'weekly') && (
                        <>
                          <input
                            type="number"
                            min={0}
                            max={23}
                            value={schedule.atHour}
                            onChange={(e) => onUpdateSchedule(sp.id, sp, { atHour: clampHour(Number(e.target.value)) })}
                            className="w-14 bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded px-2 py-1 text-xs text-zinc-200 font-mono outline-none"
                            title="Hour (0–23)"
                          />
                          <span className="text-xs text-zinc-500">:</span>
                          <input
                            type="number"
                            min={0}
                            max={59}
                            value={schedule.atMinute}
                            onChange={(e) => onUpdateSchedule(sp.id, sp, { atMinute: clampMinute(Number(e.target.value)) })}
                            className="w-14 bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded px-2 py-1 text-xs text-zinc-200 font-mono outline-none"
                            title="Minute (0–59)"
                          />
                        </>
                      )}

                      {schedule.frequency === 'weekly' && (
                        <Select aria-label="Day of week"
                          value={schedule.dayOfWeek ?? 0}
                          onValueChange={(value) => onUpdateSchedule(sp.id, sp, { dayOfWeek: Number(value) })}
                          className="bg-zinc-800 border border-zinc-700 focus:border-gale-teal rounded px-2 py-1 text-xs text-zinc-200 outline-none"
                        >
                          {DAYS_OF_WEEK.map((day, idx) => (
                            <option key={day} value={idx}>{day}</option>
                          ))}
                        </Select>
                      )}
                    </div>

                    {displayNextRunMs != null && schedule.enabled && (
                      <div className="text-xs text-zinc-500 font-mono">
                        Next run: {new Date(displayNextRunMs).toLocaleString()}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => onSaveSchedule(sp)}
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

    {/* What each run actually did — deletions included. */}
    <SyncRunHistory log={runLog} />
  </div>
);
