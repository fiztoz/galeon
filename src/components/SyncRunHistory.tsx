import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  FileClock,
  Loader2,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import type { SyncRunRecord } from '../types';
import type { SyncRunLog } from '../hooks/useSyncRunLog';

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * The things the row must react to, derived once so the markup and the tests
 * agree on what "worth noticing" means:
 *
 * - `hasDeletions` gets the row a red treatment — deletions are permanent and
 *   a scheduled run makes them while nobody is watching.
 * - `unattended` drives the schedule/manual badge, which must never be
 *   ambiguous (this is the whole reason the log exists).
 * - `deletesSkipped` marks a scheduled run that planned deletions but withheld
 *   them over the profile's delete budget — visible behaviour worth an
 *   explicit badge, since a plain "0 deletes" would read as a calm run.
 * - `pathsCapped` catches the backend capping `deletedPaths` at 200 while
 *   `deletes` keeps the true count, so the list is never presented as complete.
 */
export interface RunViewFlags {
  hasDeletions: boolean;
  unattended: boolean;
  deletesSkipped: boolean;
  failed: boolean;
  pathsCapped: boolean;
  errorsCapped: boolean;
}

export function summarizeRun(run: SyncRunRecord): RunViewFlags {
  return {
    hasDeletions: run.deletes > 0,
    unattended: run.trigger === 'schedule',
    deletesSkipped: run.deletesBlocked != null,
    failed: !run.succeeded,
    pathsCapped: run.deletedPaths.length < run.deletes,
    errorsCapped: run.errors.length < run.failures,
  };
}

/**
 * Compact relative age for a run row. `nowMs` is an argument (not read inside)
 * so the boundary behaviour is testable instead of time-dependent.
 */
export function runAgeLabel(startedAtMs: number, nowMs: number): string {
  const secs = Math.floor((nowMs - startedAtMs) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86_400 * 30) return `${Math.floor(secs / 86_400)}d ago`;
  return new Date(startedAtMs).toLocaleDateString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
}

// ── Row pieces ───────────────────────────────────────────────────────────────

function Metric({
  icon,
  label,
  value,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  danger: boolean;
}) {
  return (
    <span
      title={`${label}: ${value}`}
      className={`flex items-center space-x-1 text-xs font-mono ${
        danger && value > 0 ? 'text-status-danger' : 'text-zinc-500'
      }`}
    >
      {icon}
      <span>{value}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function RunRow({
  run,
  nowMs,
  expanded,
  onToggle,
}: {
  run: SyncRunRecord;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const flags = summarizeRun(run);
  const detailId = `sync-run-detail-${run.id}`;
  const absolute = new Date(run.startedAtMs).toLocaleString();

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? detailId : undefined}
        className={`w-full text-left px-3 py-2 rounded-lg border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-gale-teal ${
          flags.hasDeletions
            ? 'bg-status-danger/10 border border-status-danger/40 border-l-2 border-l-status-danger hover:bg-status-danger/15'
            : 'bg-zinc-800/30 border border-zinc-800 hover:bg-zinc-800/50'
        }`}
      >
        <div className="flex items-center space-x-2 flex-wrap gap-y-1">
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
            : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-zinc-500" />}

          <span className="text-sm font-medium text-zinc-200 truncate max-w-[14rem]">
            {run.profileName}
          </span>

          <span className={`text-xs px-1.5 py-0.5 rounded font-mono
            ${run.direction === 'localToRemote'
              ? 'bg-gale-teal/15 text-gale-teal'
              : 'bg-emerald-400/15 text-status-success'}`}>
            {run.direction === 'localToRemote' ? '→ remote' : '← local'}
          </span>

          {/* Trigger: the scheduler's run must never read like a run the user
              started, so unattended gets colour + icon + border and manual
              stays plain zinc. */}
          {flags.unattended ? (
            <span
              title="Unattended — started by the scheduler"
              className="flex items-center space-x-1 text-xs px-1.5 py-0.5 rounded font-mono border border-gale-teal/40 bg-gale-teal/10 text-gale-teal"
            >
              <Clock className="w-3 h-3" />
              <span>scheduled</span>
            </span>
          ) : (
            <span
              title="Started by you"
              className="text-xs px-1.5 py-0.5 rounded font-mono border border-zinc-700 bg-zinc-800 text-zinc-400"
            >
              manual
            </span>
          )}

          {run.succeeded ? (
            <span className="flex items-center space-x-1 text-xs px-1.5 py-0.5 rounded bg-status-success/10 text-status-success">
              <CheckCircle className="w-3 h-3" />
              <span>success</span>
            </span>
          ) : (
            <span className="flex items-center space-x-1 text-xs px-1.5 py-0.5 rounded font-medium bg-status-danger/15 text-status-danger">
              <AlertTriangle className="w-3 h-3" />
              <span>failed</span>
            </span>
          )}

          {/* A scheduled run that withheld its deletions must not read as a
              calmly empty delete count — say why nothing was removed. */}
          {flags.deletesSkipped && run.deletesBlocked && (
            <span
              title={`Planned to delete ${run.deletesBlocked.planned}; the profile allows ${run.deletesBlocked.cap} on a schedule`}
              className="flex items-center space-x-1 text-xs px-1.5 py-0.5 rounded font-mono bg-amber-400/15 text-status-warning"
            >
              <ShieldAlert className="w-3 h-3" />
              <span>deletes withheld</span>
            </span>
          )}

          <span className="ml-auto flex items-center space-x-2 shrink-0">
            <Metric icon={<ArrowUpFromLine className="w-3 h-3" />} label="uploads" value={run.uploads} danger={false} />
            <Metric icon={<ArrowDownToLine className="w-3 h-3" />} label="downloads" value={run.downloads} danger={false} />
            <Metric icon={<Trash2 className="w-3 h-3" />} label="deletes" value={run.deletes} danger />
            <Metric icon={<AlertTriangle className="w-3 h-3" />} label="failures" value={run.failures} danger />
            <time
              dateTime={new Date(run.startedAtMs).toISOString()}
              title={absolute}
              className="text-xs font-mono text-zinc-500"
            >
              {runAgeLabel(run.startedAtMs, nowMs)}
            </time>
          </span>
        </div>

        {/* Failures are readable without expanding — the full list is below. */}
        {!run.succeeded && run.errors.length > 0 && (
          <p className="mt-1.5 flex items-center space-x-1.5 pl-5 text-xs text-status-danger">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            <span className="truncate">{run.errors[0]}</span>
            {run.errors.length > 1 && (
              <span className="text-zinc-500 shrink-0">+{run.errors.length - 1} more</span>
            )}
          </p>
        )}
      </button>

      {expanded && (
        <div id={detailId} className="mt-1.5 ml-6 pl-3 border-l border-zinc-800 space-y-3 text-xs">
          <p className="text-zinc-500 font-mono">
            {absolute} · took {formatDuration(Math.max(0, run.finishedAtMs - run.startedAtMs))}
          </p>

          {run.deletes > 0 ? (
            <div>
              <p className="flex items-center space-x-1.5 mb-1 font-medium text-status-danger">
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {run.deletes} permanent deletion{run.deletes !== 1 ? 's' : ''}
                </span>
              </p>
              <ul className="pl-5 max-h-48 overflow-y-auto space-y-0.5 font-mono">
                {run.deletedPaths.map((path, i) => (
                  <li key={`${i}-${path}`} className="text-status-danger truncate" title={path}>
                    {path}
                  </li>
                ))}
              </ul>
              {flags.pathsCapped && (
                <p className="mt-1 text-zinc-500">
                  Showing {run.deletedPaths.length} of {run.deletes} — the rest were dropped from
                  the record to keep it small.
                </p>
              )}
            </div>
          ) : run.deletesBlocked != null ? (
            // The budget refusal, spelled out in the detail a user opens after
            // noticing their destination stopped being mirrored.
            <p className="text-zinc-500">
              This run planned to delete {run.deletesBlocked.planned} object
              {run.deletesBlocked.planned !== 1 ? 's' : ''} but the profile allows{' '}
              {run.deletesBlocked.cap} on a schedule, so nothing was deleted. Raise the limit in
              the profile's schedule settings — or run it manually, which previews the diff first.
            </p>
          ) : (
            <p className="text-zinc-500">No deletions in this run.</p>
          )}

          {run.failures > 0 && (
            <div>
              <p className="flex items-center space-x-1.5 mb-1 font-medium text-status-danger">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{run.failures} failure{run.failures !== 1 ? 's' : ''}</span>
              </p>
              <ul className="pl-5 max-h-40 overflow-y-auto space-y-0.5 list-disc list-inside">
                {run.errors.map((err, i) => (
                  <li key={`${i}-${err}`} className="text-status-danger break-words">
                    {err}
                  </li>
                ))}
              </ul>
              {flags.errorsCapped && (
                <p className="mt-1 text-zinc-500">
                  Showing {run.errors.length} of {run.failures} — the rest were dropped from the
                  record to keep it small.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

/**
 * "Run history" — what each one-way sync actually did, newest first.
 *
 * Lives in the Saved Profiles tab of `SyncPanel`. Reads and clears go through
 * `useSyncRunLog`, which the panel also uses to refresh after a run is applied.
 */
export function SyncRunHistory({ log }: { log: SyncRunLog }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  // Relative labels ("5m ago") must not go stale while the panel sits open.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (log.runs.length === 0) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [log.runs.length]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleClear = async () => {
    const ok = await log.clearHistory();
    if (ok) {
      setConfirmClear(false);
      setExpanded(new Set());
    }
  };

  const busy = log.loading || log.clearing;
  const hasRows = !log.loading && log.runs.length > 0;

  return (
    <section aria-labelledby="sync-run-history-heading" className="mt-6 pt-4 border-t border-zinc-800">
      <div className="flex items-center justify-between mb-3">
        <h3
          id="sync-run-history-heading"
          className="flex items-center space-x-2 text-sm font-semibold text-zinc-200"
        >
          <FileClock className="w-4 h-4 text-gale-teal" />
          <span>Run history</span>
        </h3>
        {log.runs.length > 0 && !confirmClear && (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            disabled={busy}
            className="flex items-center space-x-1.5 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-status-danger transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear history</span>
          </button>
        )}
      </div>

      {/* Clear confirmation — same inline footer pattern the diff tab uses for
          deletions, rather than a second modal. */}
      {confirmClear && (
        <div className="p-3 mb-3 rounded-lg bg-amber-500/10 border border-amber-500/40">
          <p className="flex items-center space-x-2 mb-1 text-sm font-medium text-status-warning">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Clear run history</span>
          </p>
          <p className="mb-3 text-xs text-zinc-400">
            Permanently removes all{' '}
            <strong className="text-status-warning">
              {log.runs.length} recorded run{log.runs.length !== 1 ? 's' : ''}
            </strong>
            , including the record of what each run deleted. This cannot be undone.
          </p>
          {log.clearError && (
            <p role="alert" className="mb-2 text-xs text-status-danger">{log.clearError}</p>
          )}
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={log.clearing}
              className="px-4 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-500 font-medium transition-colors disabled:opacity-50"
            >
              {log.clearing ? 'Clearing…' : 'Clear history'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              disabled={log.clearing}
              className="px-4 py-1.5 text-sm rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {log.loading && log.runs.length === 0 ? (
        <div className="flex items-center space-x-2 py-4 text-xs text-zinc-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>Loading run history…</span>
        </div>
      ) : log.error && log.runs.length === 0 ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 p-3 text-xs rounded-lg bg-status-danger/10 border border-status-danger/30 text-status-danger"
        >
          <span>{log.error}</span>
          <button
            type="button"
            onClick={() => void log.refresh()}
            className="shrink-0 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      ) : log.runs.length === 0 ? (
        <div className="py-6 text-center text-xs text-zinc-500">
          <FileClock className="w-6 h-6 mx-auto mb-1.5 opacity-40" />
          <p>No runs recorded yet</p>
          <p className="mt-1 text-zinc-600">
            Every sync run — and anything it permanently deletes — shows up here.
          </p>
        </div>
      ) : (
        <>
          {/* Rows still held from the last good read: say the list may be stale
              rather than pretending it is current. */}
          {log.error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 p-2 mb-2 text-xs rounded-lg bg-status-danger/10 border border-status-danger/30 text-status-danger"
            >
              <span>{log.error} — showing the last loaded history.</span>
              <button
                type="button"
                onClick={() => void log.refresh()}
                className="shrink-0 underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          )}
          <ul className={`space-y-1.5 ${hasRows ? '' : 'opacity-60'}`}>
            {log.runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                nowMs={nowMs}
                expanded={expanded.has(run.id)}
                onToggle={() => toggle(run.id)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
