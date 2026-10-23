import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildOffsets,
  computeWindow,
  DEFAULT_ROW_HEIGHT,
  recordHeight,
  useScrollViewport,
} from './useWindowedRange';

/**
 * React binding for windowed list rendering.
 *
 * The arithmetic lives in `useWindowedRange` (pure, unit-tested); this owns the
 * DOM concerns — scrolling, measuring rows, and spacer heights — so a component
 * only has to spread `visibleRows` between two spacer rows.
 *
 * Rows must carry `data-row-index={index}` so they can be measured, and the
 * returned `topSpacer` / `bottomSpacer` heights must be applied to spacer rows
 * inside the same scroll container.
 */
export function useWindowedRows<T>(items: readonly T[], resetKey: unknown) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const { scrollTop, height: viewportHeight } = useScrollViewport(scrollRef);
  const [rowHeights, setRowHeights] = useState<number[]>([]);

  // Measured heights describe one specific listing; drop them when it changes so
  // a stale row height cannot poison the offsets of the new one.
  useEffect(() => { setRowHeights([]); }, [resetKey]);

  const count = items.length;
  const offsets = useMemo(
    () => buildOffsets(rowHeights, count),
    [rowHeights, count],
  );
  const { start, end } = useMemo(
    () => computeWindow(count, offsets, scrollTop, viewportHeight),
    [count, offsets, scrollTop, viewportHeight],
  );

  // `buildOffsets` gives the *top* of each row, so the full scroll height needs
  // the last row's own height added back — using the raw measured value would
  // drop a whole row from the scrollbar whenever that row is unmeasured.
  const totalHeight =
    count > 0
      ? offsets[count - 1] + (rowHeights[count - 1] || DEFAULT_ROW_HEIGHT)
      : 0;

  // One observer for the mounted window. Rows are found by their data attribute
  // rather than callback refs: an inline ref closure is a new function every
  // render, so React detaches and re-attaches it each time and thrashes the
  // observer. `recordHeight` returning null for an unchanged measurement is what
  // stops this from looping.
  useEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      setRowHeights(prev => {
        let next = prev;
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.rowIndex);
          if (!Number.isInteger(index)) continue;
          const measured = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          const updated = recordHeight(next, index, measured);
          if (updated) next = updated;
        }
        return next;
      });
    });
    for (const node of tbody.querySelectorAll('[data-row-index]')) observer.observe(node);
    return () => observer.disconnect();
  }, [start, end, rowHeights]);

  /**
   * Bring a row into view without disturbing the rest of the scroll position.
   *
   * Only the mounted window exists in the DOM, so moving the keyboard cursor
   * to a row outside it means scrolling the container first — the row is
   * mounted on the next render.
   */
  const scrollToIndex = (index: number) => {
    const el = scrollRef.current;
    if (!el || index < 0 || index >= count) return;

    const top = offsets[index] ?? index * DEFAULT_ROW_HEIGHT;
    const bottom = top + (rowHeights[index] || DEFAULT_ROW_HEIGHT);
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;

    if (top < viewTop) {
      el.scrollTo({ top });
    } else if (bottom > viewBottom) {
      el.scrollTo({ top: bottom - el.clientHeight });
    }
  };

  return {
    scrollRef,
    tbodyRef,
    visibleRows: items.slice(start, end),
    /** Absolute index of a row in `visibleRows`, for selection semantics. */
    indexOf: (windowIndex: number) => start + windowIndex,
    topSpacer: start > 0 ? offsets[start] : 0,
    bottomSpacer: end < count ? Math.max(0, totalHeight - (offsets[end] ?? totalHeight)) : 0,
    hasTopSpacer: start > 0,
    hasBottomSpacer: end < count,
    scrollToIndex,
  };
}