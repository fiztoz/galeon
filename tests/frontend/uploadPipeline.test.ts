import { test, expect, mock } from 'bun:test';
import { hookHarness, flush } from './harness';
const harness = hookHarness();
const listeners = new Map<string, (event: any) => void>();
const removed: string[] = [];
mock.module('@tauri-apps/api/core', () => ({invoke: async () => true}));
mock.module('@tauri-apps/plugin-dialog', () => ({open: async () => ['/local/a.txt']}));
mock.module('@tauri-apps/api/window', () => ({getCurrentWindow: () => ({listen: async (name: string, fn: (event:any)=>void) => {listeners.set(name,fn); return () => {removed.push(name); listeners.delete(name);};}})}));
const { useUploadPipeline } = await import('../../src/hooks/useUploadPipeline');
test('conflicts retain the queue, apply-to-all, target direction, and native drop cleanup', async () => {
  const uploads: string[][] = [], downloads: string[][] = [];
  const options={sessionId:'test',prefix:'remote/',onInitiateUpload:(...args:string[])=>{uploads.push(args);},onInitiateDownload:(...args:string[])=>{downloads.push(args);}};
  const render=()=>harness.render(()=>useUploadPipeline(options));
  let hook=render(); await flush();
  hook.startConflictCheck([
    {direction:'upload',localPath:'/a.txt',remoteKey:'remote/a.txt'},
    {direction:'download',localPath:'C:\\local\\b.txt',remoteKey:'b.txt'},
  ]); hook=render(); hook.handleConflictResolve('rename'); hook=render();
  expect(uploads).toEqual([['/a.txt','remote/a (1).txt']]);
  expect(hook.showConflictModal).toBe(true); expect(hook.pendingConflicts.length).toBe(1);
  hook.handleConflictResolve('rename'); hook=render();
  expect(downloads).toEqual([['b.txt','C:\\local\\b (1).txt']]); expect(hook.showConflictModal).toBe(false);
  hook.startConflictCheck(['x','y'].map(name=>({direction:'upload',localPath:name,remoteKey:name}))); hook=render();
  hook.setApplyToAll(true); hook=render(); hook.handleConflictResolve('skip'); hook=render();
  expect(hook.pendingConflicts).toEqual([]); expect(uploads.length).toBe(1);
  listeners.get('tauri://drag-drop')!({payload:{paths:['/local/dropped.txt']}}); await flush(); hook=render();
  expect(hook.pendingConflicts[0].remoteKey).toBe('remote/dropped.txt');
  hook.setApplyToAll(true); hook=render(); hook.handleConflictResolve('overwrite'); hook=render();
  expect(uploads.at(-1)).toEqual(['/local/dropped.txt','remote/dropped.txt']);
  harness.unmount(); expect(removed.sort()).toEqual(['tauri://drag-drop','tauri://drag-leave','tauri://drag-over']);
});
