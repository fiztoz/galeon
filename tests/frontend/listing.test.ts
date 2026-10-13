import { test, expect, mock } from 'bun:test';
import { hookHarness } from './harness';
const harness = hookHarness();
const requests: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
mock.module('@tauri-apps/api/core', () => ({invoke: () => new Promise((resolve, reject) => requests.push({resolve,reject}))}));
const { useObjectListing, useObjectSorting } = await import('../../src/hooks/useObjectListing');

// `list_directory` returns a DirectoryListing envelope, not a bare array.
const listing = (objects: unknown[], over: Partial<{truncated:boolean;returned:number;limit:number}> = {}) => ({
  objects,
  truncated: false,
  returned: objects.length,
  limit: 20000,
  ...over,
});

test('latest listing owns rows, spinner, and failure state; action errors remain separate', async () => {
  const render = () => harness.render(() => useObjectListing('test'));
  let hook = render();
  const first = hook.fetchDirectory('old/'); const second = hook.fetchDirectory('new/');
  requests[1].resolve(listing([{name:'new',fullKey:'new'}])); await second;
  requests[0].reject('old failure'); await first; hook = render();
  expect(hook.objects[0].fullKey).toBe('new'); expect(hook.loading).toBe(false); expect(hook.listFailed).toBe(false);
  expect(hook.truncated).toBeNull();
  hook.setError('delete failed'); hook = render(); expect(hook.error).toBe('delete failed'); expect(hook.listFailed).toBe(false);
  const third=hook.fetchDirectory('broken/'); requests[2].reject('Error: denied'); await third; hook=render();
  expect(hook.error).toBe('denied'); expect(hook.listFailed).toBe(true); expect(hook.objects).toEqual([]);
  harness.unmount();
});

test('a capped listing surfaces a truncation notice instead of looking complete', async () => {
  const render = () => harness.render(() => useObjectListing('test'));
  let hook = render();
  const at = requests.length; // the queue is shared across tests in this file
  const request = hook.fetchDirectory('huge/');
  requests[at].resolve(listing([{name:'a',fullKey:'a'}], {truncated:true, returned:1, limit:20000}));
  await request; hook = render();
  expect(hook.objects).toHaveLength(1);
  expect(hook.truncated).toEqual({returned:1, limit:20000});
  harness.unmount();
});

test('an untruncated listing raises no notice', async () => {
  const render = () => harness.render(() => useObjectListing('test'));
  let hook = render();
  const at = requests.length;
  const request = hook.fetchDirectory('exact/');
  requests[at].resolve(listing([{name:'a',fullKey:'a'}]));
  await request; hook = render();
  expect(hook.truncated).toBeNull();
  harness.unmount();
});

test('a failed listing clears any stale truncation notice', async () => {
  const render = () => harness.render(() => useObjectListing('test'));
  let hook = render();
  const at = requests.length;
  const capped = hook.fetchDirectory('huge/');
  requests[at].resolve(listing([{name:'a',fullKey:'a'}], {truncated:true, returned:1, limit:20000}));
  await capped; hook = render();
  expect(hook.truncated).not.toBeNull();
  const failing = hook.fetchDirectory('broken/');
  requests[at + 1].reject('Error: denied'); await failing; hook = render();
  expect(hook.truncated).toBeNull();
  harness.unmount();
});
test('filtering and folder-size sorting retain visible row order', () => {
  const objects = [
    {name:'z-folder',fullKey:'z/',objectType:'folder' as const,sizeBytes:null,lastModified:null},
    {name:'a-folder',fullKey:'a/',objectType:'folder' as const,sizeBytes:null,lastModified:null},
    {name:'file',fullKey:'file',objectType:'file' as const,sizeBytes:1,lastModified:null},
  ];
  const render = () => harness.render(() => useObjectSorting(objects, {'z/':{totalBytes:2},'a/':{totalBytes:10}}));
  let hook=render(); hook.handleSort('size'); hook=render();
  expect(hook.filteredObjects.map(o=>o.fullKey)).toEqual(['z/','a/','file']);
  hook.setSearchQuery('folder'); hook=render(); expect(hook.filteredObjects.map(o=>o.fullKey)).toEqual(['z/','a/']);
  harness.unmount();
});
