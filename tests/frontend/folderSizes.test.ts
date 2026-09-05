import { test, expect, mock } from 'bun:test';
import { hookHarness, flush } from './harness';
const harness = hookHarness();
const requests: { prefix: string; resolve: (value: unknown) => void }[] = [];
const cancelled: string[] = [];
mock.module('@tauri-apps/api/core', () => ({ invoke: (command: string, args: any) => {
  if (command === 'cancel_prefix_size') { cancelled.push(args.jobId); return Promise.resolve(); }
  return new Promise(resolve => requests.push({ prefix: args.prefix, resolve }));
} }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
const { useFolderSizes } = await import('../../src/hooks/useFolderSizes');
test('late size responses are cancelled after navigation and unmount', async () => {
  const objects = [{name: 'child', fullKey: 'old/child/', objectType: 'folder' as const, sizeBytes: null, lastModified: null}];
  harness.render(() => useFolderSizes('test', 'old/', true, false, objects));
  const oldRequests = requests.splice(0);
  harness.render(() => useFolderSizes('test', 'new/', true, true, objects));
  for (const [i, request] of oldRequests.entries()) request.resolve({jobId: `old-${i}`, cached: false});
  await flush();
  expect(cancelled.sort()).toEqual(oldRequests.map((_, i) => `old-${i}`).sort());
  harness.render(() => useFolderSizes('test', 'new/', true, false, []));
  const newRequests = requests.splice(0);
  harness.unmount();
  newRequests.forEach((request, i) => request.resolve({jobId: `new-${i}`, cached: false}));
  await flush();
  for (const [i] of newRequests.entries()) expect(cancelled).toContain(`new-${i}`);
});
