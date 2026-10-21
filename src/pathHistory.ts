/**
 * Navigation history for a file pane.
 *
 * Each pane keeps its own stack: the remote pane's entries are prefixes, the
 * local pane's are paths. The rules are pure so both panes share one
 * definition of "where did I come from" and it can be tested without a DOM.
 */

export type PathHistoryState = { past: string[]; current: string; future: string[] };

export function initialPathHistory(current: string): PathHistoryState {
  return { past: [], current, future: [] };
}

/** Remember a new location. Pushing the current one again is a no-op. */
export function pushPath(state: PathHistoryState, next: string): PathHistoryState {
  if (next === state.current) return state;
  return { past: [...state.past, state.current].slice(-50), current: next, future: [] };
}

/** Step back to the previous location, or null when there is none. */
export function backPath(state: PathHistoryState): PathHistoryState | null {
  const previous = state.past[state.past.length - 1];
  if (previous === undefined) return null;
  return { past: state.past.slice(0, -1), current: previous, future: [state.current, ...state.future] };
}

/** Step forward to the next location, or null when there is none. */
export function forwardPath(state: PathHistoryState): PathHistoryState | null {
  const next = state.future[0];
  if (next === undefined) return null;
  return { past: [...state.past, state.current], current: next, future: state.future.slice(1) };
}

/**
 * Move to a location that is already in the stack — back or forward.
 *
 * The location itself is not recorded again: walking the history must not
 * grow it.
 */
export function moveWithinHistory(state: PathHistoryState, next: string): PathHistoryState {
  if (state.past[state.past.length - 1] === next) return backPath(state) ?? state;
  if (state.future[0] === next) return forwardPath(state) ?? state;
  return state;
}

/**
 * The parent of a location, or null when it is already the pane root.
 *
 * `fsProtocol` locations are absolute paths (`/var/log`); object prefixes are
 * relative and end in a slash (`a/b/`).
 */
export function parentPrefix(prefix: string, fsProtocol: boolean): string | null {
  if (fsProtocol && (prefix === '/' || prefix === '')) return null;
  const parts = prefix.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  parts.pop();
  if (!fsProtocol) return parts.length === 0 ? '' : parts.join('/') + '/';
  return parts.length === 0 ? '/' : '/' + parts.join('/');
}
