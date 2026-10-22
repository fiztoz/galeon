import { test, expect, mock } from 'bun:test';
import { hookHarness, flush } from './harness';

const harness = hookHarness();

/** Every backend call the hook makes, in order, plus per-test behaviour. */
const calls: string[] = [];
let listResult: unknown[] = [];
let failing: string | null = null;

mock.module('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: { entryId?: string }) => {
    calls.push(args?.entryId ? `${command}:${args.entryId}` : command);
    if (command === failing) return Promise.reject('keychain busy');
    if (command === 'get_presign_history') return Promise.resolve(listResult);
    return Promise.resolve(undefined);
  },
}));

const { usePresignHistory } = await import('../../src/hooks/usePresignHistory');

const entry = (id: string) => ({
  id,
  fileKey: `${id}.pdf`,
  fileName: `${id}.pdf`,
  url: `https://example.test/${id}`,
  expiresInSeconds: 3600,
  createdAt: '2026-10-20T00:00:00Z',
});

test('loading replaces the list with what the backend holds', async () => {
  const first = harness.render(() => usePresignHistory());
  expect(first.presignHistory).toEqual([]);

  listResult = [entry('a'), entry('b')];
  await first.loadPresignHistory();
  await flush();

  const after = harness.render(() => usePresignHistory());
  expect(after.presignHistory.map((e) => e.id)).toEqual(['a', 'b']);
  expect(calls).toContain('get_presign_history');
});

test('clearing asks the backend and empties the list', async () => {
  const value = harness.render(() => usePresignHistory());
  await value.clearPresignHistory();
  await flush();

  const after = harness.render(() => usePresignHistory());
  expect(after.presignHistory).toEqual([]);
  expect(calls).toContain('clear_presign_history');
});

test('deleting one entry removes only that entry', async () => {
  listResult = [entry('a'), entry('b')];
  const value = harness.render(() => usePresignHistory());
  await value.loadPresignHistory();
  await flush();

  await value.deletePresignHistoryEntry('a');
  await flush();

  const after = harness.render(() => usePresignHistory());
  expect(after.presignHistory.map((e) => e.id)).toEqual(['b']);
  expect(calls).toContain('delete_presign_history_entry:a');
});

test('a failed load or delete leaves the drawer as it was', async () => {
  listResult = [entry('a'), entry('b'), entry('c')];
  const value = harness.render(() => usePresignHistory());
  await value.loadPresignHistory();
  await flush();

  failing = 'delete_presign_history_entry';
  await value.deletePresignHistoryEntry('b');
  await flush();

  failing = 'get_presign_history';
  await value.loadPresignHistory();
  await flush();

  const after = harness.render(() => usePresignHistory());
  expect(after.presignHistory.map((e) => e.id)).toEqual(['a', 'b', 'c']);
});