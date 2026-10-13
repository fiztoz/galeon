import { expect, test } from 'bun:test';
import { findOverwrites } from '../../src/components/SyncPanel';

// One-way sync copies the source over the destination by design, so a differing
// file is replaced even when the destination is newer. That is correct behaviour,
// but the user is only told "size differs" — these tests pin the warning that
// makes the consequence visible.
const entry = (over: Partial<SyncPlanEntry> = {}): SyncPlanEntry => ({
  relativePath: 'f.bin',
  action: 'upload',
  reason: 'size differs',
  localSize: 10,
  remoteSize: 20,
  localModified: null,
  remoteModified: null,
  direction: 'localToRemote',
  ...over,
});

const EARLIER = '2026-01-01T00:00:00Z';
const LATER = '2026-06-01T00:00:00Z';

test('localToRemote warns when the remote copy is newer', () => {
  const out = findOverwrites(
    [entry({ localModified: EARLIER, remoteModified: LATER })],
    'localToRemote',
  );
  expect(out).toEqual([{ relativePath: 'f.bin', destination: 'remote' }]);
});

test('remoteToLocal warns when the local copy is newer', () => {
  const out = findOverwrites(
    [entry({ action: 'download', direction: 'remoteToLocal', localModified: LATER, remoteModified: EARLIER })],
    'remoteToLocal',
  );
  expect(out).toEqual([{ relativePath: 'f.bin', destination: 'local' }]);
});

test('an ordinary forward sync does not warn', () => {
  // Source newer: replacing the destination is the whole point.
  expect(
    findOverwrites([entry({ localModified: LATER, remoteModified: EARLIER })], 'localToRemote'),
  ).toEqual([]);
});

test('equal timestamps do not warn', () => {
  expect(
    findOverwrites([entry({ localModified: LATER, remoteModified: LATER })], 'localToRemote'),
  ).toEqual([]);
});

test('deletes are never reported as overwrites', () => {
  // A delete is surfaced by the existing delete confirmation, not here.
  expect(
    findOverwrites(
      [entry({ action: 'deleteRemote', localModified: EARLIER, remoteModified: LATER })],
      'localToRemote',
    ),
  ).toEqual([]);
});

test('skips entries with a missing or unparseable timestamp', () => {
  expect(findOverwrites([entry({ remoteModified: null })], 'localToRemote')).toEqual([]);
  expect(
    findOverwrites([entry({ remoteModified: 'not-a-date' })], 'localToRemote'),
  ).toEqual([]);
});

test('collects every overwriting entry', () => {
  const out = findOverwrites(
    [
      entry({ relativePath: 'a.bin', localModified: EARLIER, remoteModified: LATER }),
      entry({ relativePath: 'b.bin', localModified: LATER, remoteModified: EARLIER }),
      entry({ relativePath: 'c.bin', localModified: EARLIER, remoteModified: LATER }),
    ],
    'localToRemote',
  );
  expect(out.map((o) => o.relativePath)).toEqual(['a.bin', 'c.bin']);
});

test('an empty plan produces no warnings', () => {
  expect(findOverwrites([], 'localToRemote')).toEqual([]);
});