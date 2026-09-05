import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

/**
 * Resizable two-pane split used by the dual-pane browser.
 *
 * `ratio` is the fraction of the width given to `left`, in 0..1. Two things pull
 * against each other and the clamp below is the compromise:
 *
 *  - neither pane should collapse to an unusable sliver while you are dragging,
 *    so while the pointer is *between* the limits each pane keeps `minPx`;
 *  - you should still be able to give one pane the whole width without reaching
 *    for the toggle, so dragging firmly past `minPx` **snaps** that pane fully
 *    shut instead of stopping at it.
 *
 * So: free movement inside [minPx, width-minPx], snap to 0 or 1 once the pointer
 * goes past the snap zone, and anything in between is clamped.
 */

const NUDGE = 0.02;
const NUDGE_BIG = 0.1;

export interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** Fraction of the width given to `left`, 0..1. */
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /** Minimum width each pane keeps while dragging, and the snap threshold. */
  minPx?: number;
  /** Accessible name for the separator, e.g. "Local and remote pane divider". */
  label: string;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

export const SplitPane: React.FC<SplitPaneProps> = ({
  left,
  right,
  ratio,
  onRatioChange,
  minPx = 320,
  label,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const capturedId = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Map a pointer x position to a ratio, applying the clamp + snap rules. */
  const ratioFromClientX = useCallback(
    (clientX: number) => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width <= 0) return ratio;
      const offset = clientX - box.left;
      // Not enough room for two minimum-sized panes: keep them even.
      if (box.width <= minPx * 2) return 0.5;
      const lo = minPx / box.width;
      const hi = 1 - minPx / box.width;
      if (offset <= minPx * 0.5) return 0; // dragged firmly shut over the left pane
      if (offset >= box.width - minPx * 0.5) return 1; // ...and the right
      return Math.min(hi, Math.max(lo, offset / box.width));
    },
    [minPx, ratio],
  );

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Capture is a nice-to-have: it keeps events coming when the pointer leaves
    // the handle. It is NOT load-bearing, because the move/up listeners below
    // live on `window`. Some environments reject capture for synthesized or
    // already-released pointers, and letting that throw would kill dragging
    // outright — which is exactly what a bare setPointerCapture() does.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
      capturedId.current = e.pointerId;
    } catch {
      capturedId.current = null;
    }
    setDragging(true);
    // Deliberately NOT jumping to the cursor on pointer-down. A jump moves the
    // handle out from under the pointer, which makes double-click-to-reset
    // impossible (the first click relocates the target) and turns a stray click
    // on the divider into a layout change. Movement only takes effect on drag.
  };

  // Window-scoped listeners while dragging: work regardless of pointer capture,
  // and are removed on pointerup/pointercancel so nothing leaks.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => onRatioChange(ratioFromClientX(e.clientX));
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [dragging, onRatioChange, ratioFromClientX]);

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pid = capturedId.current;
    if (pid !== null) {
      try {
        if (e.currentTarget.hasPointerCapture(pid)) e.currentTarget.releasePointerCapture(pid);
      } catch {
        /* capture was never granted; nothing to release */
      }
      capturedId.current = null;
    }
    setDragging(false);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? NUDGE_BIG : NUDGE;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = ratio - step;
    else if (e.key === 'ArrowRight') next = ratio + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    else if (e.key === 'Enter' || e.key === ' ') next = 0.5;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation(); // a focused separator must not drive the list behind it
    onRatioChange(clamp01(next));
  };

  const pct = Math.round(clamp01(ratio) * 100);

  return (
    <div ref={containerRef} className="flex h-full w-full">
      <div className="overflow-hidden" style={{ width: `${pct}%` }}>
        {left}
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        data-no-drag
        onPointerDown={handlePointerDown}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        onDoubleClick={() => onRatioChange(0.5)}
        title={`${label} — drag to resize, double-click to reset`}
        className={`group relative w-1 shrink-0 cursor-col-resize select-none focus:outline-none ${
          dragging
            ? 'bg-gale-teal'
            : 'bg-zinc-800 hover:bg-zinc-600 focus-visible:bg-gale-teal'
        }`}
      >
        {/* Grab affordance that does not widen the hit area. */}
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-1 rounded-full bg-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </div>

      <div className="min-w-0 flex-1 overflow-hidden">
        {right}
      </div>
    </div>
  );
};
