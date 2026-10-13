import { expect, test } from 'bun:test';
import { isSyncPlanStale, type SyncDiffInputs } from '../../src/components/SyncPanel';

// execute_sync_plan resolves deleteLocal/deleteRemote entries against the LIVE
// local path + remote prefix, so the plan must be invalidated whenever an input
// that feeds compute_sync_diff changes.
const recorded: SyncDiffInputs = {
  localPath: '/data/folder-a',
  remotePrefix: 'backups/a/',
  direction: 'localToRemote',
  verifyChecksum: false,
  deleteExtraneous: false,
};

const withInputs = (patch: Partial<SyncDiffInputs> = {}): SyncDiffInputs => ({ ...recorded, ...patch });

test('plan computed from the live inputs is fresh', () => {
  expect(isSyncPlanStale(recorded, withInputs(), 12)).toBe(false);
});

test('empty plan is never stale — there is nothing to invalidate', () => {
  expect(isSyncPlanStale(recorded, withInputs({ localPath: '/data/folder-b' }), 0)).toBe(false);
  expect(isSyncPlanStale(null, withInputs(), 0)).toBe(false);
});

test('changing the local path marks the plan stale', () => {
  expect(isSyncPlanStale(recorded, withInputs({ localPath: '/data/folder-b' }), 12)).toBe(true);
});

test('changing the remote prefix marks the plan stale', () => {
  expect(isSyncPlanStale(recorded, withInputs({ remotePrefix: 'backups/b/' }), 12)).toBe(true);
});

test('flipping the direction marks the plan stale', () => {
  expect(isSyncPlanStale(recorded, withInputs({ direction: 'remoteToLocal' }), 12)).toBe(true);
});

test('toggling either sync option marks the plan stale', () => {
  expect(isSyncPlanStale(recorded, withInputs({ deleteExtraneous: true }), 12)).toBe(true);
  expect(isSyncPlanStale(recorded, withInputs({ verifyChecksum: true }), 12)).toBe(true);
});

test('a non-empty plan without recorded inputs fails closed', () => {
  expect(isSyncPlanStale(null, withInputs(), 3)).toBe(true);
});
