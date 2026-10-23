import React, { useEffect, useState, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, CheckCircle, XCircle, Pause, Play, X, RotateCcw } from 'lucide-react';
import { formatSize } from './Explorer';
import { shouldPersistProgress } from './transferPersist';

export interface TransferState {
  id: string;
  remoteKey: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  bytesPerSecond: number;
  status: 'queued' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'verifying' | 'retrying';
  direction: 'upload' | 'download';
  error?: string;
  profileId?: string;
  localPath?: string;
  retryAttempt?: number;
  retryMax?: number;
}

export interface TransferQueueEntry {
  id: string;
  direction: string;
  remote_key: string;
  local_path: string;
  profile_id: string;
  /**
   * Backend-owned: the storage session the transfer runs against, set at
   * enqueue time. Retrying a failed transfer rebuilds it from this, so the
   * queue merge never clears it — `restore_transfers` may hand it back here.
   */
  session_id?: string;
  status: string;
  bytes_transferred: number;
  total_bytes: number;
  created_at: string;
  updated_at: string;
  error: string | null;
}

// Brand progress bar colors (doubloon = in motion, gale-teal = done, red-500 = failed)
const progressBarColor = (status: TransferState['status']) => {
  if (status === 'failed') return 'bg-red-500';
  if (status === 'completed') return 'bg-gradient-to-r from-gale-teal to-emerald-400';
  if (status === 'verifying') return 'bg-gradient-to-r from-gale-teal to-emerald-400 animate-pulse';
  if (status === 'paused') return 'bg-zinc-700';
  if (status === 'retrying') return 'bg-amber-600/80 animate-pulse';
  return 'bg-gradient-to-r from-doubloon via-amber-500 to-amber-400';
};

const statusChip = (status: TransferState['status']) => {
  switch (status) {
    case 'queued':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-zinc-800 text-zinc-400 border border-zinc-700/30">Queued</span>;
    case 'active':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-doubloon/15 text-doubloon border border-doubloon/20">Active</span>;
    case 'retrying':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-status-warning/10 text-status-warning border border-status-warning/30">Retrying</span>;
    case 'paused':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-zinc-800/50 text-zinc-500 border border-zinc-700/20">Paused</span>;
    case 'completed':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-gale-teal/15 text-gale-teal border border-gale-teal/20">Completed</span>;
    case 'failed':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-status-danger/10 text-status-danger border border-status-danger/30">Failed</span>;
    case 'cancelled':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-zinc-800/50 text-zinc-500 border border-zinc-700/20">Cancelled</span>;
    case 'verifying':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-gale-teal/15 text-gale-teal animate-pulse border border-gale-teal/20">Verifying</span>;
  }
};

/**
 * What the drawer header reports about the queue's remaining work: bytes left
 * to move and, when something is actually moving, how long THE CURRENT PACE
 * needs for that. Remaining counts every unfinished transfer — queued, active,
 * paused, retrying, verifying — because they all owe bytes; the ETA divides by
 * the speed of ACTIVE transfers only, so a fully paused queue answers
 * "1.2 GB left" honestly while refusing to fabricate an ETA from a
 * standing-still line. Values clamp at zero: a retried transfer can briefly
 * report a smaller bytesTransferred, and negative work must never render.
 */
export interface QueueDrain {
  /** Bytes still owed by every non-terminal transfer. */
  remainingBytes: number;
  /** Current sum of active transfer speeds. */
  throughputBytes: number;
  /** remainingBytes ÷ throughputBytes, or null while nothing moves. */
  etaSeconds: number | null;
}

const UNFINISHED_TRANSFER_STATUSES: TransferState['status'][] = [
  'queued',
  'active',
  'paused',
  'verifying',
  'retrying',
];

export function queueDrain(transfers: TransferState[]): QueueDrain {
  const remainingBytes = transfers
    .filter((t) => UNFINISHED_TRANSFER_STATUSES.includes(t.status))
    .reduce((sum, t) => sum + Math.max(0, t.totalBytes - t.bytesTransferred), 0);
  const throughputBytes = transfers
    .filter((t) => t.status === 'active')
    .reduce((sum, t) => sum + t.bytesPerSecond, 0);
  return {
    remainingBytes,
    throughputBytes,
    etaSeconds: remainingBytes > 0 && throughputBytes > 0 ? remainingBytes / throughputBytes : null,
  };
}

/** "~2m 14s"-style wall-clock rendering of a queue-drain ETA. */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s`;
  let m = Math.floor(seconds / 60);
  let s = Math.round(seconds % 60);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

interface TransferManagerProps {
  onRetry?: (transfer: TransferState) => void;
}

export const TransferManager: React.FC<TransferManagerProps> = ({ onRetry }) => {
  const [transfers, setTransfers] = useState<Record<string, TransferState>>({});
  const [isOpen, setIsOpen] = useState(false);
  const [restoredCount, setRestoredCount] = useState(0);

  // The list as of the last update, read synchronously by the event listeners.
  // Every change goes through `updateTransfers`, so listeners can work out the
  // next row — and whether to persist it — outside a setState updater. Updaters
  // must stay pure: React may run them twice (StrictMode) or late.
  const transfersRef = useRef<Record<string, TransferState>>({});
  const updateTransfers = useCallback(
    (next: (prev: Record<string, TransferState>) => Record<string, TransferState>) => {
      const updated = next(transfersRef.current);
      if (updated === transfersRef.current) return;
      transfersRef.current = updated;
      setTransfers(updated);
    },
    [],
  );
  // When each transfer (by remote key) was last written to the queue.
  const lastPersistedAtRef = useRef<Map<string, number>>(new Map());

  // Load persisted transfers on mount
  useEffect(() => {
    const loadPersistedTransfers = async () => {
      try {
        const queue = await invoke<TransferQueueEntry[]>('restore_transfers');
        // Count only: the entries carry local paths and profile ids.
        if (import.meta.env.DEV) {
          console.debug('[TransferManager] Restored transfers:', queue.length);
        }
        if (queue.length > 0) {
          setRestoredCount(queue.length);
          updateTransfers(prev => {
            const updated = { ...prev };
            for (const entry of queue) {
              updated[entry.remote_key] = {
                id: entry.id,
                remoteKey: entry.remote_key,
                bytesTransferred: entry.bytes_transferred,
                totalBytes: entry.total_bytes,
                percentage: entry.total_bytes > 0 ? (entry.bytes_transferred / entry.total_bytes * 100) : 0,
                bytesPerSecond: 0,
                status: entry.status as TransferState['status'],
                direction: entry.direction as 'upload' | 'download',
                error: entry.error || undefined,
                profileId: entry.profile_id,
                localPath: entry.local_path,
              };
            }
            return updated;
          });
        }
      } catch (err) {
        console.error('[TransferManager] Failed to restore transfers:', err);
      }
    };
    loadPersistedTransfers();
  }, [updateTransfers]);

  // Persist transfer to queue
  const persistTransfer = useCallback(async (transfer: TransferState) => {
    lastPersistedAtRef.current.set(transfer.remoteKey, Date.now());
    try {
      const entry: TransferQueueEntry = {
        id: transfer.id,
        direction: transfer.direction,
        remote_key: transfer.remoteKey,
        local_path: transfer.localPath || '',
        profile_id: transfer.profileId || '',
        status: transfer.status,
        bytes_transferred: transfer.bytesTransferred,
        total_bytes: transfer.totalBytes,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error: transfer.error || null,
      };
      await invoke('update_transfer_queue_entry', { entry });
    } catch (err) {
      console.error('Failed to persist transfer:', err);
    }
  }, []);

  useEffect(() => {
    const unlistenStarted = listen<{
      id: string;
      remoteKey: string;
      localPath: string;
      direction: string;
      totalBytes: number;
      profileId: string;
    }>('transfer-started', (event) => {
      const p = event.payload;
      const existing = transfersRef.current[p.remoteKey];
      const updated: TransferState = {
        id: p.id,
        remoteKey: p.remoteKey,
        bytesTransferred: existing?.bytesTransferred ?? 0,
        totalBytes: p.totalBytes || existing?.totalBytes || 0,
        percentage: existing?.percentage ?? 0,
        bytesPerSecond: 0,
        status: 'active',
        direction: (p.direction as 'upload' | 'download') || 'download',
        profileId: p.profileId || existing?.profileId,
        localPath: p.localPath || existing?.localPath,
      };
      updateTransfers((prev) => ({ ...prev, [p.remoteKey]: updated }));
      persistTransfer(updated);
      setIsOpen(true);
    });

    const unlistenProgress = listen<{
      remoteKey: string;
      bytesTransferred: number;
      totalBytes: number;
      percentage: number;
      bytesPerSecond: number;
      direction: string;
    }>('transfer-progress', (event) => {
      const payload = event.payload;
      const existing = transfersRef.current[payload.remoteKey];
      const updated: TransferState = {
        id: existing?.id || payload.remoteKey,
        remoteKey: payload.remoteKey,
        bytesTransferred: payload.bytesTransferred,
        totalBytes: payload.totalBytes,
        percentage: payload.percentage,
        bytesPerSecond: payload.bytesPerSecond,
        status: 'active',
        direction: (payload.direction as 'upload' | 'download') || existing?.direction || 'download',
        profileId: existing?.profileId,
        localPath: existing?.localPath,
      };
      // A chunk in flight when pause was clicked still emits one progress
      // event after transfer-paused; don't let it flip the row back to active.
      if (existing?.status === 'paused') {
        updated.status = 'paused';
      }
      updateTransfers((prev) => ({ ...prev, [payload.remoteKey]: updated }));
      // Progress is saved at most every few seconds per transfer, so a crash
      // resumes from a recent offset without writing the queue on every chunk.
      if (shouldPersistProgress(lastPersistedAtRef.current.get(payload.remoteKey), Date.now())) {
        persistTransfer(updated);
      }
    });

    const unlistenComplete = listen<string>('transfer-complete', (event) => {
      const remoteKey = event.payload;
      const item = transfersRef.current[remoteKey];
      if (!item) return;
      const updated = { ...item, percentage: 100, status: 'completed' as const };
      updateTransfers((prev) => ({ ...prev, [remoteKey]: updated }));
      persistTransfer(updated);
    });

    const unlistenFailed = listen<{
      remoteKey: string;
      error: string;
      localPath?: string;
      direction?: string;
    }>('transfer-failed', (event) => {
      const payload = event.payload;
      const item = transfersRef.current[payload.remoteKey];
      const updated: TransferState = {
        id: item?.id || payload.remoteKey,
        remoteKey: payload.remoteKey,
        bytesTransferred: item?.bytesTransferred || 0,
        totalBytes: item?.totalBytes || 0,
        percentage: item?.percentage || 0,
        bytesPerSecond: 0,
        status: 'failed',
        direction: (payload.direction as 'upload' | 'download') || item?.direction || 'download',
        error: payload.error,
        profileId: item?.profileId,
        localPath: payload.localPath || item?.localPath,
      };
      updateTransfers((prev) => ({ ...prev, [payload.remoteKey]: updated }));
      persistTransfer(updated);
    });

    const unlistenRetrying = listen<{
      remoteKey: string;
      attempt: number;
      maxAttempts: number;
      nextDelayMs: number;
      message: string;
    }>('transfer-retrying', (event) => {
      const p = event.payload;
      updateTransfers((prev) => {
        const item = prev[p.remoteKey];
        if (!item) return prev;
        return {
          ...prev,
          [p.remoteKey]: {
            ...item,
            status: 'retrying',
            bytesPerSecond: 0,
            error: p.message,
            retryAttempt: p.attempt,
            retryMax: p.maxAttempts,
          },
        };
      });
    });

    // Paused / resumed / verifying / cancelled: set the status and save it.
    const setStatus = (item: TransferState | undefined, status: TransferState['status']) => {
      if (!item) return undefined;
      const updated = { ...item, status };
      updateTransfers((prev) => ({ ...prev, [item.remoteKey]: updated }));
      persistTransfer(updated);
      return updated;
    };
    const byId = (transferId: string) =>
      Object.values(transfersRef.current).find((t) => t.id === transferId);

    const unlistenPaused = listen<string>('transfer-paused', (event) => {
      setStatus(byId(event.payload), 'paused');
    });

    const unlistenResumed = listen<string>('transfer-resumed', (event) => {
      setStatus(byId(event.payload), 'active');
    });

    const unlistenVerifying = listen<string>('transfer-verifying', (event) => {
      setStatus(transfersRef.current[event.payload], 'verifying');
    });

    const unlistenCancelled = listen<string>('transfer-cancelled', (event) => {
      const updated = setStatus(byId(event.payload), 'cancelled');
      if (!updated) return;
      // Remove cancelled transfers after a short delay
      setTimeout(() => {
        updateTransfers((p) => {
          const { [updated.remoteKey]: _, ...rest } = p;
          return rest;
        });
        lastPersistedAtRef.current.delete(updated.remoteKey);
      }, 2000);
    });

    return () => {
      unlistenStarted.then((f) => f());
      unlistenProgress.then((f) => f());
      unlistenComplete.then((f) => f());
      unlistenFailed.then((f) => f());
      unlistenRetrying.then((f) => f());
      unlistenPaused.then((f) => f());
      unlistenResumed.then((f) => f());
      unlistenCancelled.then((f) => f());
      unlistenVerifying.then((f) => f());
    };
  }, [persistTransfer, updateTransfers]);

  const handlePause = async (transferId: string) => {
    try {
      await invoke('pause_transfer', { transferId });
    } catch (err) {
      console.error('Failed to pause transfer:', err);
    }
  };

  const handleCancel = async (transfer: TransferState) => {
    try {
      await invoke('cancel_transfer', { transferId: transfer.id });
    } catch {
      // No live worker (transfer restored from a previous session):
      // mark it cancelled in the queue and drop the row locally.
      persistTransfer({ ...transfer, status: 'cancelled' });
      updateTransfers((prev) => {
        const { [transfer.remoteKey]: _, ...rest } = prev;
        return rest;
      });
    }
  };

  const handleResume = async (transfer: TransferState) => {
    try {
      // Live worker parked on its pause gate: wake it in place.
      await invoke('resume_transfer', { transferId: transfer.id });
    } catch {
      // No live worker (restored from a previous session): re-initiate.
      // Downloads pick up from the .part file offset automatically.
      if (onRetry && transfer.localPath) {
        onRetry(transfer);
        updateTransfers((prev) => {
          const { [transfer.remoteKey]: _, ...rest } = prev;
          return rest;
        });
      }
    }
  };

  const handleClearCompleted = async () => {
    try {
      await invoke('clear_completed_transfers');
      updateTransfers(prev => {
        const updated: Record<string, TransferState> = {};
        for (const [key, transfer] of Object.entries(prev)) {
          if (transfer.status !== 'completed' && transfer.status !== 'cancelled') {
            updated[key] = transfer;
          }
        }
        return updated;
      });
    } catch (err) {
      console.error('Failed to clear completed transfers:', err);
    }
  };

  const formatSpeed = (bps: number) => {
    if (bps === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bps) / Math.log(k));
    return parseFloat((bps / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const transferList = Object.values(transfers);
  const activeCount = transferList.filter((t) => t.status === 'active').length;
  const completedCount = transferList.filter((t) => t.status === 'completed').length;

  if (transferList.length === 0) return null;

  // One drain computation feeds both header segments: the live speed and the
  // "what's left / how long" readout.
  const drain = queueDrain(transferList);

  return (
    <div className={`relative shrink-0 max-h-[45dvh] bg-zinc-900 border-t border-zinc-800 flex flex-col ${isOpen ? 'h-80' : 'h-[42px]'}`}>
      {/* Restored transfers banner */}
      {restoredCount > 0 && (
        <div className="bg-status-warning/10 border-b border-status-warning/30 px-6 py-1.5 flex items-center justify-between shrink-0">
          <span className="text-xs text-status-warning font-mono metric-text">
            {restoredCount} interrupted transfer{restoredCount > 1 ? 's' : ''} restored from previous session
          </span>
          <button
            onClick={() => setRestoredCount(0)}
            className="text-xs text-status-warning hover:text-status-warning"
          >
            Dismiss
          </button>
        </div>
      )}
      
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between px-6 py-2 cursor-pointer hover:bg-zinc-800/60 transition-colors shrink-0"
      >
        <div className="flex items-center space-x-3">
          {activeCount > 0 ? (
            <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-doubloon/20 text-doubloon border border-doubloon/30 animate-pulse">
              {activeCount} Active
            </span>
          ) : (
            <ArrowDownToLine className="w-4 h-4 text-gale-teal" />
          )}
          <span className="font-medium text-sm font-display">
            Transfers
          </span>
          <span className="text-xs text-zinc-500">({transferList.length} total)</span>
          {activeCount > 0 && drain.throughputBytes > 0 && (
            <span className="text-xs text-doubloon font-semibold font-mono metric-text ml-2">
              {formatSpeed(drain.throughputBytes)}
            </span>
          )}
          {drain.remainingBytes > 0 && (
            <span className="text-xs text-zinc-400 font-mono metric-text">
              {formatSize(drain.remainingBytes)} left
              {drain.etaSeconds !== null ? ` · ~${formatEta(drain.etaSeconds)}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          {completedCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); handleClearCompleted(); }}
              className="text-xs bg-zinc-800 hover:bg-zinc-700 px-3 py-1 rounded-full font-medium transition-colors text-zinc-400 hover:text-zinc-200"
            >
              Clear Completed
            </button>
          )}
          <button className="text-xs bg-zinc-800 hover:bg-zinc-700 px-3 py-1 rounded-full font-medium transition-colors">
            {isOpen ? 'Minimize' : 'Expand'}
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-4 divide-y divide-zinc-800/50 galeon-scrollbar">
          {transferList.map((transfer) => (
            <div key={transfer.remoteKey} className="pt-4 flex flex-col space-y-2">
              <div className="flex justify-between items-center text-xs">
                <div className="flex items-center space-x-2 max-w-md">
                  {transfer.direction === 'upload' ? (
                    <ArrowUpFromLine className="w-3.5 h-3.5 text-doubloon shrink-0" />
                  ) : (
                    <ArrowDownToLine className="w-3.5 h-3.5 text-gale-teal shrink-0" />
                  )}
                  <span className="font-medium truncate text-zinc-200">{transfer.remoteKey}</span>
                  {statusChip(transfer.status)}
                </div>
                <div className="flex items-center space-x-2">
                  {transfer.status === 'active' && (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin text-doubloon" />
                      <span className="text-doubloon font-mono metric-text">{formatSpeed(transfer.bytesPerSecond)}</span>
                    </>
                  )}
                  {transfer.status === 'retrying' && (
                    <span className="text-status-warning text-[10px] max-w-[10rem] truncate" title={transfer.error}>
                      Retry {transfer.retryAttempt ?? '?'}/{transfer.retryMax ?? '?'}…
                    </span>
                  )}
                  {transfer.status === 'verifying' && (
                    <Loader2 className="w-3 h-3 animate-spin text-gale-teal" />
                  )}
                  {transfer.status === 'paused' && (
                    <span className="text-zinc-400">Paused</span>
                  )}
                  {transfer.status === 'completed' && (
                    <span className="text-status-success flex items-center space-x-1">
                      <CheckCircle className="w-3.5 h-3.5" />
                    </span>
                  )}
                  {transfer.status === 'failed' && (
                    <span className="text-status-danger flex items-center space-x-1" title={transfer.error}>
                      <XCircle className="w-3.5 h-3.5" />
                    </span>
                  )}
                  {transfer.status === 'cancelled' && (
                    <span className="text-zinc-500">Cancelled</span>
                  )}
                  
                  {/* Control buttons */}
                  {(transfer.status === 'active' || transfer.status === 'retrying') && (
                    <div className="flex items-center space-x-1 ml-2">
                      {transfer.status === 'active' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handlePause(transfer.id); }}
                          className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
                          title="Pause"
                        >
                          <Pause className="w-3 h-3" />
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCancel(transfer); }}
                        className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-status-danger"
                        title="Cancel"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}

                  {/* Paused: resume the live worker in place, or re-initiate if restored */}
                  {transfer.status === 'paused' && (
                    <div className="flex items-center space-x-1 ml-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleResume(transfer); }}
                        className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
                        title="Resume"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCancel(transfer); }}
                        className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-status-danger"
                        title="Cancel"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}

                  {transfer.status === 'failed' && onRetry && transfer.localPath && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRetry(transfer);
                        // Remove failed transfer from list
                        updateTransfers(prev => {
                          const { [transfer.remoteKey]: _, ...rest } = prev;
                          return rest;
                        });
                      }}
                      className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-status-warning"
                      title="Retry"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
              
              <div className="relative w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={`absolute top-0 bottom-0 left-0 transition-all duration-100 ${progressBarColor(transfer.status)}`}
                  style={{ width: `${transfer.percentage}%` }}
                />
              </div>
              
              <div className="flex justify-between text-[10px] text-zinc-500 font-mono metric-text">
                <span>{transfer.percentage.toFixed(1)}%</span>
                <span>
                  {transfer.status === 'failed' && transfer.error ? (
                    <span className="text-status-danger truncate max-w-xs font-sans" title={transfer.error}>
                      {transfer.error}
                    </span>
                  ) : (
                    <>
                      {parseFloat((transfer.bytesTransferred / 1024 / 1024).toFixed(2))} MB /{' '}
                      {parseFloat((transfer.totalBytes / 1024 / 1024).toFixed(2))} MB
                    </>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
