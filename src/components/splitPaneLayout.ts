/** Keep expanded panes usable after resizing, preserving explicit collapse. */
export function visibleSplitRatio(ratio: number, width: number, minimum: number): number {
  const normalized = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.5;
  if (normalized === 0 || normalized === 1 || width <= 0) return normalized;
  const lower = Math.min(0.5, minimum / width);
  return Math.min(1 - lower, Math.max(lower, normalized));
}
