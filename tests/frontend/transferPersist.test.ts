import { test, expect } from 'bun:test';
import { PROGRESS_PERSIST_INTERVAL_MS, shouldPersistProgress } from '../../src/components/transferPersist';

test('the first progress event of a transfer is saved', () => {
  expect(shouldPersistProgress(undefined, 0)).toBe(true);
  expect(shouldPersistProgress(undefined, 123_456)).toBe(true);
});

test('progress inside the interval is not saved', () => {
  expect(shouldPersistProgress(10_000, 10_000)).toBe(false);
  expect(shouldPersistProgress(10_000, 10_000 + PROGRESS_PERSIST_INTERVAL_MS - 1)).toBe(false);
});

test('progress is saved once the interval has passed', () => {
  expect(shouldPersistProgress(10_000, 10_000 + PROGRESS_PERSIST_INTERVAL_MS)).toBe(true);
  expect(shouldPersistProgress(10_000, 60_000)).toBe(true);
});

test('a steady stream of events saves on the interval, not by luck', () => {
  // The old check was `Date.now() % 5000 < 100`: whether a save happened
  // depended on where events fell on the wall clock, and a stream with a
  // period that skipped that 100 ms window never saved at all.
  let last: number | undefined;
  const saved: number[] = [];
  for (let now = 1_000_150; now <= 1_000_150 + 20_000; now += 250) {
    if (shouldPersistProgress(last, now)) {
      saved.push(now);
      last = now;
    }
  }
  expect(saved).toEqual([1_000_150, 1_005_150, 1_010_150, 1_015_150, 1_020_150]);
});

test('a clock that steps backwards does not stall saves', () => {
  expect(shouldPersistProgress(50_000, 40_000)).toBe(true);
});

test('the interval can be overridden', () => {
  expect(shouldPersistProgress(0, 999, 1000)).toBe(false);
  expect(shouldPersistProgress(0, 1000, 1000)).toBe(true);
});
