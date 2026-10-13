import { describe, expect, test } from 'bun:test';
import {
  buildOffsets,
  computeWindow,
  DEFAULT_ROW_HEIGHT,
  OVERSCAN_ROWS,
  recordHeight,
} from '../../src/hooks/useWindowedRange';

const uniform = (count: number, height = 40) => buildOffsets(new Array(count).fill(height), count);

describe('computeWindow', () => {
  test('renders nothing for an empty list', () => {
    expect(computeWindow(0, [], 0, 600)).toEqual({ start: 0, end: 0 });
  });

  test('renders everything when the list fits the viewport', () => {
    // 5 rows of 40px = 200px tall, viewport 600px: nothing can be culled.
    expect(computeWindow(5, uniform(5), 0, 600)).toEqual({ start: 0, end: 5 });
  });

  test('keeps a small list fully rendered regardless of scroll offset', () => {
    const offsets = uniform(5);
    const result = computeWindow(5, offsets, 100, 600);
    expect(result.start).toBe(0);
    expect(result.end).toBe(5);
  });

  test('windows a 100k list to roughly the viewport height', () => {
    const count = 100_000;
    const height = 40;
    const offsets = uniform(count, height);
    const viewport = 800;
    const result = computeWindow(count, offsets, 0, viewport);

    const expectedRows = Math.ceil(viewport / height) + OVERSCAN_ROWS * 2;
    expect(result.end - result.start).toBeLessThanOrEqual(expectedRows);
    // The whole point: a tiny slice out of a huge list.
    expect(result.end - result.start).toBeLessThan(100);
  });

  test('window follows the scroll offset through the middle of a long list', () => {
    const count = 10_000;
    const height = 40;
    const offsets = uniform(count, height);
    const scrollTop = 200_000; // row 5000

    const { start, end } = computeWindow(count, offsets, scrollTop, 800);
    const firstVisible = Math.floor(scrollTop / height);

    expect(firstVisible).toBeGreaterThanOrEqual(start);
    expect(firstVisible).toBeLessThan(end);
  });

  test('clamps to the list bounds at the top', () => {
    const result = computeWindow(1000, uniform(1000), 0, 800);
    expect(result.start).toBe(0);
  });

  test('clamps to the list bounds at the bottom', () => {
    const offsets = uniform(1000, 40);
    const maxScroll = 40_000 - 800;
    const result = computeWindow(1000, offsets, maxScroll, 800);
    expect(result.end).toBe(1000);
    expect(result.start).toBeLessThanOrEqual(1000);
  });

  test('never returns an inverted range when scrolled past the end', () => {
    const offsets = uniform(100, 40);
    const result = computeWindow(100, offsets, 999_999, 800);
    expect(result.end).toBeGreaterThanOrEqual(result.start);
    expect(result.end).toBeLessThanOrEqual(100);
  });

  test('handles ragged (measured) row heights', () => {
    // Rows alternate tall/short, as the compact layout does.
    const heights = new Array(200).fill(0).map((_, i) => (i % 2 ? 56 : 32));
    const offsets = buildOffsets(heights, 200);
    const result = computeWindow(200, offsets, 1000, 600);
    expect(result.start).toBeGreaterThanOrEqual(0);
    expect(result.end).toBeLessThanOrEqual(200);
    expect(result.end).toBeGreaterThan(result.start);
  });

  test('falls back to the full list when offsets are incomplete', () => {
    // Offsets not measured for every row yet: better to render all than to
    // scroll into a hole.
    expect(computeWindow(50, uniform(10), 0, 800)).toEqual({ start: 0, end: 50 });
  });

  test('start is always within bounds for a single-row list', () => {
    expect(computeWindow(1, uniform(1), 0, 800)).toEqual({ start: 0, end: 1 });
  });
});

describe('spacer composition', () => {
  // The mounted rows plus the two spacers must add up to the real scroll height,
  // or the list grows or shrinks every time the window moves.
  const compose = (heights: number[], scrollTop: number, viewport: number) => {
    const count = heights.length;
    const offsets = buildOffsets(heights, count);
    const lastHeight = heights[count - 1] || DEFAULT_ROW_HEIGHT;
    const total = count > 0 ? offsets[count - 1] + lastHeight : 0;
    const { start, end } = computeWindow(count, offsets, scrollTop, viewport);
    const topSpacer = start > 0 ? offsets[start] : 0;
    const bottomSpacer = end < count ? total - offsets[end] : 0;
    return { start, end, mounted: end - start, topSpacer, bottomSpacer, total, real: total };
  };

  test('mounted rows + spacers reconstruct the full scroll height', () => {
    const heights = new Array(10_000).fill(41);
    const { topSpacer, bottomSpacer, total, real } = compose(heights, 200_000, 800);
    expect(topSpacer + bottomSpacer + 0).toBeLessThanOrEqual(real);
    // The spacers carry everything except the handful of mounted rows.
    expect(topSpacer + bottomSpacer).toBeGreaterThan(0);
  });

  test('at the top of the list there is no leading spacer', () => {
    const { topSpacer, start } = compose(new Array(5000).fill(40), 0, 800);
    expect(start).toBe(0);
    expect(topSpacer).toBe(0);
  });

  test('bottom spacer is never negative', () => {
    const { bottomSpacer } = compose(new Array(1000).fill(40), 39_200, 800);
    expect(bottomSpacer).toBeGreaterThanOrEqual(0);
  });

  test('total height survives an unmeasured last row', () => {
    // The last row has never been observed (0), so the default must be added
    // back or a whole row vanishes from the scrollbar.
    const heights = new Array(300).fill(DEFAULT_ROW_HEIGHT);
    heights[299] = 0;
    const offsets = buildOffsets(heights, 300);
    // 300 rows at DEFAULT_ROW_HEIGHT each.
    expect(offsets[299] + DEFAULT_ROW_HEIGHT).toBe(300 * DEFAULT_ROW_HEIGHT);
  });

  test('empty list composes to zero', () => {
    const { topSpacer, bottomSpacer, total } = compose([], 0, 800);
    expect(topSpacer).toBe(0);
    expect(bottomSpacer).toBe(0);
    expect(total).toBe(0);
  });
});

describe('buildOffsets', () => {
  test('accumulates offsets', () => {
    expect(buildOffsets([10, 20, 30], 3)).toEqual([0, 10, 30]);
  });

  test('fills unmeasured rows with the default height', () => {
    expect(buildOffsets([10, 0, 0], 3)).toEqual([0, 10, 10 + DEFAULT_ROW_HEIGHT]);
  });

  test('produces zero offsets for an empty list', () => {
    expect(buildOffsets([], 0)).toEqual([]);
  });
});

describe('recordHeight', () => {
  test('records a first measurement', () => {
    const heights = recordHeight([], 0, 41);
    expect(heights).toEqual([41]);
  });

  test('returns null when the height is unchanged', () => {
    // Stability matters: a no-op update must not reset the scroll position.
    expect(recordHeight([41], 0, 41)).toBeNull();
  });

  test('returns null for a non-positive measurement', () => {
    // A row hidden mid-measure reports 0; keeping it would corrupt the offsets.
    expect(recordHeight([41], 0, 0)).toBeNull();
  });

  test('does not mutate the input', () => {
    const original = [41, 42];
    recordHeight(original, 0, 99);
    expect(original).toEqual([41, 42]);
  });
});