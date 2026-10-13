import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SyncRunRecord } from '../types';

/**
 * State + actions for the sync run history (`get_sync_runs` /
 * `clear_sync_runs`). Kept out of `SyncPanel` so the panel stays a shell around
 * the feature instead of growing another fetch/dispose lifecycle.
 */
export interface SyncRunLog {
  /** Newest first, exactly as the backend returns it. */
  runs: SyncRunRecord[];
  /** A read is in flight — show a spinner only when we have nothing yet. */
  loading: boolean;
  /** The last read failed; whatever rows we hold may be missing or stale. */
  error: string | null;
  clearing: boolean;
  /** The last clear attempt failed; the rows are still there. */
  clearError: string | null;
  refresh: () => Promise<void>;
  /** Clears every recorded run. Resolves true only when it actually worked. */
  clearHistory: () => Promise<boolean>;
}

function errorMessage(err: unknown, fallback: string): string {
  const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error:\s*/i, '') || fallback;
}

export function useSyncRunLog(): SyncRunLog {
  const [runs, setRuns] = useState<SyncRunRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  // Reads race (tab switches, refresh after a run). Only the most recent one
  // may write state — same rule as `useObjectListing.fetchDirectory`.
  const nonceRef = useRef(0);

  const refresh = useCallback(async () => {
    const nonce = ++nonceRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<SyncRunRecord[]>('get_sync_runs');
      if (nonce !== nonceRef.current) return;
      setRuns(res);
    } catch (err) {
      if (nonce !== nonceRef.current) return;
      // Keep the rows we already hold: a failed read is worth saying out loud,
      // not a reason to hide history the user was just reading.
      setError(errorMessage(err, 'Failed to load the run history.'));
    } finally {
      if (nonce === nonceRef.current) setLoading(false);
    }
  }, []);

  const clearHistory = useCallback(async (): Promise<boolean> => {
    // Drop any read already in flight — it may have read the pre-clear file and
    // would write the rows straight back once the clear lands.
    const clearNonce = ++nonceRef.current;
    setClearing(true);
    setClearError(null);
    try {
      await invoke('clear_sync_runs');
      // Same for a read that started while the clear was running.
      nonceRef.current++;
      setRuns([]);
      setError(null);
      setLoading(false);
      return true;
    } catch (err) {
      // We invalidated the read in flight, so it will never clear the spinner
      // itself. A newer read (started since) owns loading and must not be
      // interrupted, though.
      if (nonceRef.current === clearNonce) setLoading(false);
      setClearError(errorMessage(err, 'Failed to clear the run history.'));
      return false;
    } finally {
      setClearing(false);
    }
  }, []);

  return { runs, loading, error, clearing, clearError, refresh, clearHistory };
}
