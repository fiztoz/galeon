/**
 * Shared-link history for the connected window.
 *
 * Three backend calls and one list, so the shell does not have to hold the
 * invokes itself. Loads are best-effort: a backend hiccup logs and leaves the
 * drawer showing what it already had rather than blocking the user.
 */

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PresignHistoryEntry } from '../types';

export function usePresignHistory() {
  const [presignHistory, setPresignHistory] = useState<PresignHistoryEntry[]>([]);

  const loadPresignHistory = async () => {
    try {
      const history = await invoke<PresignHistoryEntry[]>('get_presign_history');
      setPresignHistory(history);
    } catch (err) {
      console.error('Failed to load presign history:', err);
    }
  };

  const clearPresignHistory = async () => {
    try {
      await invoke('clear_presign_history');
      setPresignHistory([]);
    } catch (err) {
      console.error('Failed to clear presign history:', err);
    }
  };

  const deletePresignHistoryEntry = async (entryId: string) => {
    try {
      await invoke('delete_presign_history_entry', { entryId });
      setPresignHistory(prev => prev.filter(e => e.id !== entryId));
    } catch (err) {
      console.error('Failed to delete presign history entry:', err);
    }
  };

  return {
    presignHistory,
    loadPresignHistory,
    clearPresignHistory,
    deletePresignHistoryEntry,
  };
}
