import { expect, test } from 'bun:test';
import { runAgeLabel, summarizeRun } from '../../src/components/SyncRunHistory';
import type { SyncRunRecord } from '../../src/types';

const NOW = 1_700_000_000_000;

const record = (patch: Partial<SyncRunRecord> = {}): SyncRunRecord => ({
  id: 'run-1',
  profileId: 'profile-1',
  profileName: 'Nightly backup',
  direction: 'localToRemote',
  trigger: 'manual',
  startedAtMs: NOW - 60_000,
  finishedAtMs: NOW,
  succeeded: true,
  uploads: 3,
  downloads: 0,
  deletes: 0,
  failures: 0,
  deletedPaths: [],
  errors: [],
  ...patch,
});

// The unattended case is the reason this log exists: a scheduled run that
// removed files has to be unmistakable in the list.
test('a scheduled run that deleted files is flagged unattended and deleting', () => {
  const flags = summarizeRun(record({
    trigger: 'schedule',
    deletes: 2,
    deletedPaths: ['old/a.bin', 'old/b.bin'],
  }));
  expect(flags.unattended).toBe(true);
  expect(flags.hasDeletions).toBe(true);
  expect(flags.failed).toBe(false);
});

test('a manual clean run is neither unattended nor deleting', () => {
  const flags = summarizeRun(record());
  expect(flags.unattended).toBe(false);
  expect(flags.hasDeletions).toBe(false);
  expect(flags.failed).toBe(false);
});

test('a run with failures is flagged failed', () => {
  const flags = summarizeRun(record({ succeeded: false, failures: 1, errors: ['a.bin: timeout'] }));
  expect(flags.failed).toBe(true);
  expect(flags.errorsCapped).toBe(false);
});

// The backend caps the detail lists at 200 while the counts stay exact, so the
// UI must know the list is partial instead of presenting it as everything.
test('a capped path list is reported as capped, an exact one is not', () => {
  expect(summarizeRun(record({ deletes: 500, deletedPaths: ['a', 'b'] })).pathsCapped).toBe(true);
  expect(summarizeRun(record({ deletes: 2, deletedPaths: ['a', 'b'] })).pathsCapped).toBe(false);
  expect(summarizeRun(record({ deletes: 0, deletedPaths: [] })).pathsCapped).toBe(false);
});

test('a capped error list is reported as capped', () => {
  expect(summarizeRun(record({ failures: 300, errors: ['e1'], succeeded: false })).errorsCapped).toBe(true);
  expect(summarizeRun(record({ failures: 1, errors: ['e1'], succeeded: false })).errorsCapped).toBe(false);
  expect(summarizeRun(record({ failures: 0, errors: [] })).errorsCapped).toBe(false);
});

test('run age labels cover each unit and fall back to a date when old', () => {
  expect(runAgeLabel(NOW - 2_000, NOW)).toBe('just now');
  expect(runAgeLabel(NOW - 30_000, NOW)).toBe('30s ago');
  expect(runAgeLabel(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  expect(runAgeLabel(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
  expect(runAgeLabel(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  expect(runAgeLabel(NOW - 400 * 86_400_000, NOW)).toBe(new Date(NOW - 400 * 86_400_000).toLocaleDateString());
});
