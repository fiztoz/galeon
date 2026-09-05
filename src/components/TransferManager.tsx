import React, { useEffect, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDownToLine, ArrowUpFromLine, Loader2, CheckCircle, XCircle, Pause, Play, X, RotateCcw } from 'lucide-react';

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
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-900/40 text-amber-300 border border-amber-700/30">Retrying</span>;
    case 'paused':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-zinc-800/50 text-zinc-500 border border-zinc-700/20">Paused</span>;
    case 'completed':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-gale-teal/15 text-gale-teal border border-gale-teal/20">Completed</span>;
    case 'failed':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-red-950/50 text-red-400 border border-red-900/30">Failed</span>;
    case 'cancelled':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-zinc-800/50 text-zinc-500 border border-zinc-700/20">Cancelled</span>;
    case 'verifying':
      return <span className="px-2 py-0.5 rounded-full text-[10px] bg-gale-teal/15 text-gale-teal animate-pulse border border-gale-teal/20">Verifying</span>;
  }
};

interface TransferManagerProps {
  onRetry?: (transfer: TransferState) => void;
}

export const TransferManager: React.FC<TransferManagerProps> = ({ onRetry }) => {
  const [transfers, setTransfers] = useState<Record<string, TransferState>>({});
  const [isOpen, setIsOpen] = useState(false);
  const [restoredCount, setRestoredCount] = useState(0);

  // Load persisted transfers on mount
  useEffect(() => {
    const loadPersistedTransfers = async () => {
      try {
        console.log('[TransferManager] Loading persisted transfers...');
        const queue = await invoke<TransferQueueEntry[]>('restore_transfers');
        console.log('[TransferManager] Restored transfers:', queue.length, queue);
        if (queue.length > 0) {
          setRestoredCount(queue.length);
          setTransfers(prev => {
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
  }, []);

  // Persist transfer to queue
  const persistTransfer = useCallback(async (transfer: TransferState) => {
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
      setTransfers((prev) => {
        const existing = prev[p.remoteKey];
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
        persistTransfer(updated);
        return { ...prev, [p.remoteKey]: updated };
      });
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
      setTransfers((prev) => {
        const existing = prev[payload.remoteKey];
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
        // Debounced persist - only persist every 5 seconds
        if (!existing || Date.now() % 5000 < 100) {
          persistTransfer(updated);
        }
        return { ...prev, [payload.remoteKey]: updated };
      });
    });

    const unlistenComplete = listen<string>('transfer-complete', (event) => {
      const remoteKey = event.payload;
      setTransfers((prev) => {
        const item = prev[remoteKey];
        if (!item) return prev;
        const updated = { ...item, percentage: 100, status: 'completed' as const };
        persistTransfer(updated);
        return { ...prev, [remoteKey]: updated };
      });
    });

    const unlistenFailed = listen<{
      remoteKey: string;
      error: string;
      localPath?: string;
      direction?: string;
    }>('transfer-failed', (event) => {
      const payload = event.payload;
      setTransfers((prev) => {
        const item = prev[payload.remoteKey];
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
        persistTransfer(updated);
        return { ...prev, [payload.remoteKey]: updated };
      });
    });

    const unlistenRetrying = listen<{
      remoteKey: string;
      attempt: number;
      maxAttempts: number;
      nextDelayMs: number;
      message: string;
    }>('transfer-retrying', (event) => {
      const p = event.payload;
      setTransfers((prev) => {
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

    const unlistenPaused = listen<string>('transfer-paused', (event) => {
      const transferId = event.payload;
      setTransfers((prev) => {
        const item = Object.values(prev).find(t => t.id === transferId);
        if (!item) return prev;
        const updated = { ...item, status: 'paused' as const };
        persistTransfer(updated);
        return { ...prev, [item.remoteKey]: updated };
      });
    });

    const unlistenResumed = listen<string>('transfer-resumed', (event) => {
      const transferId = event.payload;
      setTransfers((prev) => {
        const item = Object.values(prev).find(t => t.id === transferId);
        if (!item) return prev;
        const updated = { ...item, status: 'active' as const };
        persistTransfer(updated);
        return { ...prev, [item.remoteKey]: updated };
      });
    });

    const unlistenVerifying = listen<string>('transfer-verifying', (event) => {
      const remoteKey = event.payload;
      setTransfers((prev) => {
        const item = prev[remoteKey];
        if (!item) return prev;
        const updated = { ...item, status: 'verifying' as const };
        persistTransfer(updated);
        return { ...prev, [remoteKey]: updated };
      });
    });

    const unlistenCancelled = listen<string>('transfer-cancelled', (event) => {
      const transferId = event.payload;
      setTransfers((prev) => {
        const item = Object.values(prev).find(t => t.id === transferId);
        if (!item) return prev;
        const updated = { ...item, status: 'cancelled' as const };
        persistTransfer(updated);
        // Remove cancelled transfers after a short delay
        setTimeout(() => {
          setTransfers(p => {
            const { [item.remoteKey]: _, ...rest } = p;
            return rest;
          });
        }, 2000);
        return { ...prev, [item.remoteKey]: updated };
      });
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
  }, [persistTransfer]);

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
      setTransfers((prev) => {
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
        setTransfers((prev) => {
          const { [transfer.remoteKey]: _, ...rest } = prev;
          return rest;
        });
      }
    }
  };

  const handleClearCompleted = async () => {
    try {
      await invoke('clear_completed_transfers');
      setTransfers(prev => {
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

  const totalSpeed = transferList
    .filter((t) => t.status === 'active')
    .reduce((sum, t) => sum + t.bytesPerSecond, 0);

  return (
    <div className={`fixed bottom-0 left-0 right-0 bg-zinc-900 border-t-2 border-zinc-800 z-50 transition-all duration-300 flex flex-col ${isOpen ? 'h-80' : 'h-[42px]'}`}>
      {/* Restored transfers banner */}
      {restoredCount > 0 && (
        <div className="bg-amber-900/30 border-b border-amber-800/50 px-6 py-1.5 flex items-center justify-between shrink-0">
          <span className="text-xs text-amber-400 font-mono metric-text">
            {restoredCount} interrupted transfer{restoredCount > 1 ? 's' : ''} restored from previous session
          </span>
          <button
            onClick={() => setRestoredCount(0)}
            className="text-xs text-amber-400 hover:text-amber-300"
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
          {activeCount > 0 && (
            <span className="text-xs text-doubloon font-semibold font-mono metric-text ml-2">
              {formatSpeed(totalSpeed)}
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
                    <span className="text-amber-300 text-[10px] max-w-[10rem] truncate" title={transfer.error}>
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
                    <span className="text-teal-400 flex items-center space-x-1">
                      <CheckCircle className="w-3.5 h-3.5" />
                    </span>
                  )}
                  {transfer.status === 'failed' && (
                    <span className="text-red-400 flex items-center space-x-1" title={transfer.error}>
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
                        className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-red-400"
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
                        className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-red-400"
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
                        setTransfers(prev => {
                          const { [transfer.remoteKey]: _, ...rest } = prev;
                          return rest;
                        });
                      }}
                      className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-amber-400"
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
                    <span className="text-red-400 truncate max-w-xs font-sans" title={transfer.error}>
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
