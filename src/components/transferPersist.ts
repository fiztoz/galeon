/**
 * When the transfer list writes a row back to the persisted queue.
 *
 * Status changes (started, paused, failed, completed…) are always saved. The
 * stream of `transfer-progress` events is not — a fast transfer emits several
 * a second — so progress is saved at most once per interval per transfer. That
 * bounds how stale the resume offset can be after a crash without writing the
 * queue file on every chunk.
 */

/** Save in-flight progress at most this often, per transfer. */
export const PROGRESS_PERSIST_INTERVAL_MS = 5000;

/**
 * Whether a progress event should be persisted.
 *
 * `lastPersistedAt` is when this transfer was last written (any write, status
 * or progress), or undefined if it never was — the first progress event of a
 * transfer is always saved.
 */
export function shouldPersistProgress(
  lastPersistedAt: number | undefined,
  now: number,
  intervalMs: number = PROGRESS_PERSIST_INTERVAL_MS,
): boolean {
  if (lastPersistedAt === undefined) return true;
  // A clock that went backwards (sleep, NTP step) must not stall saves forever.
  if (now < lastPersistedAt) return true;
  return now - lastPersistedAt >= intervalMs;
}
