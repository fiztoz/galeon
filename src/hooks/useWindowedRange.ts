import { useCallback, useEffect, useState } from 'react';

/**
 * Windowed-render bookkeeping for long lists.
 *
 * Galeon's stated bar (docs/DIRECTION.md) is 60 fps at 100k objects, but rows
 * vary in height — the compact layout adds a second date line under each name
 * (index.css `.compact-date`) — so a fixed-height slice would drift. This hook
 * keeps the whole list addressable while only asking for a window of rows.
 *
 * Pure arithmetic, deliberately free of React and of the DOM, so the math can
 * be tested directly (tests/frontend/windowedRange.test.ts) and reused by any
 * pane that grows a long list.
 */

/** Rows rendered above and below the viewport, to hide scroll-boundary seams. */
export const OVERSCAN_ROWS = 8;

/**
 * Resolve the inclusive `[start, end)` row range to render for a scroll offset.
 *
 * `offsets[i]` is the pixel offset of row `i`; it must be sorted ascending and
 * is treated as read-only. `rowCount` is the total number of rows.
 */
export function computeWindow(
  rowCount: number,
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number = OVERSCAN_ROWS,
): { start: number; end: number } {
  if (rowCount <= 0) return { start: 0, end: 0 };
  if (offsets.length < rowCount) return { start: 0, end: rowCount };

  // First row whose bottom edge is below the viewport top.
  let start = binarySearchOffset(offsets, scrollTop);
  // One past the last row whose top edge is above the viewport bottom.
  let end = binarySearchOffset(offsets, scrollTop + viewportHeight) + 1;

  start = clamp(start - overscan, 0, rowCount);
  end = clamp(end + overscan, 0, rowCount);
  if (end < start) end = start;
  return { start, end };
}

/**
 * Index of the last row whose offset is `<= target`, or 0 when `target` precedes
 * every row. Binary search over a sorted offset array.
 */
function binarySearchOffset(offsets: number[], target: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Track a scroll container's size and scroll offset, re-rendering only when
 * either changes. Uses a `ResizeObserver` when available (it is in every
 * webview Galeon targets) and falls back to window resize events.
 */
export function useScrollViewport(ref: React.RefObject<HTMLElement | null>) {
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setViewport(prev => {
      const next = { scrollTop: el.scrollTop, height: el.clientHeight };
      // Avoid a render when nothing observable moved.
      if (prev.scrollTop === next.scrollTop && prev.height === next.height) return prev;
      return next;
    });
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    measure();
    el.addEventListener('scroll', measure, { passive: true });

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    } else {
      window.addEventListener('resize', measure);
    }

    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, measure]);

  return viewport;
}

/**
 * Accumulated pixel offsets for rows whose measured heights live in `heights`.
 * Missing entries fall back to `DEFAULT_ROW_HEIGHT` until measured. `0` is how
 * "not measured" is represented, so the test is explicitly `> 0` rather than
 * `??` — `??` would let a `0` through and collapse the row to zero height.
 */
export function buildOffsets(heights: number[], count: number): number[] {
  const offsets = new Array<number>(count);
  let acc = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = acc;
    const height = heights[i];
    acc += height && height > 0 ? height : DEFAULT_ROW_HEIGHT;
  }
  return offsets;
}

/**
 * Record a row's measured height and report the next offsets when it changed.
 * Returns `null` when the height is unchanged, so the caller can skip the
 * recompute and keep scroll position stable.
 */
export function recordHeight(
  heights: number[],
  index: number,
  measured: number,
): number[] | null {
  if (!(measured > 0)) return null;
  if (heights[index] === measured) return null;
  const next = heights.slice();
  next[index] = measured;
  return next;
}

/**
 * Fallback row height before a row has been measured. Deliberately an estimate:
 * the compact layout is taller, and `measureElement` corrects it on first paint.
 */
export const DEFAULT_ROW_HEIGHT = 41;