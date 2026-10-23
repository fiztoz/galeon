import { test, expect } from 'bun:test';
import { disconnectNeedsConfirm } from '../../src/disconnectGuard';

test('disconnect confirms only while an editor watch is open', () => {
  expect(disconnectNeedsConfirm(0)).toBe(false);
  expect(disconnectNeedsConfirm(1)).toBe(true);
  expect(disconnectNeedsConfirm(3)).toBe(true);
});
