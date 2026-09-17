import { expect, test } from 'bun:test';
import { visibleSplitRatio } from '../../src/components/splitPaneLayout';

test('resizing preserves room for both expanded panes without changing saved preference', () => {
  const savedRatio = 0.25;
  expect(visibleSplitRatio(savedRatio, 1200, 320)).toBeCloseTo(320 / 1200);
  expect(visibleSplitRatio(savedRatio, 892, 320)).toBeCloseTo(320 / 892);
  expect(visibleSplitRatio(savedRatio, 1600, 320)).toBe(savedRatio);
  expect(visibleSplitRatio(0.9, 892, 320)).toBeCloseTo(1 - 320 / 892);
});

test('collapse remains explicit and impossibly narrow panes share available space', () => {
  expect(visibleSplitRatio(0, 500, 320)).toBe(0);
  expect(visibleSplitRatio(1, 500, 320)).toBe(1);
  expect(visibleSplitRatio(0.3, 500, 320)).toBe(0.5);
  expect(visibleSplitRatio(Number.NaN, 900, 320)).toBe(0.5);
});
