import { test, expect } from 'bun:test';
import { buildCommandActions, type CommandActionContext } from '../../src/commandActions';
import type { EditSessionInfo } from '../../src/components/ActiveEditors';
import type { SyncProfile } from '../../src/components/SyncPanel';

const editor = (editorId: string, filename: string, saveCount = 0): EditSessionInfo => ({
  editorId,
  sessionId: 's1',
  remoteKey: `path/${filename}`,
  filename,
  startedAt: '2026-10-20T00:00:00Z',
  lastSavedAt: null,
  saveCount,
});

const syncProfile = (id: string, name: string): SyncProfile => ({
  id,
  name,
  connectionProfileId: 'p1',
  localPath: '/tmp',
  remotePrefix: 'backup/',
  direction: 'localToRemote',
  verifyChecksum: true,
  deleteExtraneous: false,
  maxScheduledDeletes: 0,
  lastRunMs: null,
});

const context = (over: Partial<CommandActionContext> = {}): CommandActionContext => ({
  connected: true,
  themeLabel: 'Dark',
  dualPaneEnabled: false,
  editSessions: [],
  syncProfiles: [],
  refresh: () => {},
  newFolder: () => {},
  upload: () => {},
  toggleTheme: () => {},
  toggleDualPane: () => {},
  openInspector: () => {},
  openLinks: () => {},
  stopAllEditors: () => {},
  stopEditor: () => {},
  openSync: () => {},
  runSync: () => {},
  runSyncNow: () => {},
  openSettings: () => {},
  showOnboarding: () => {},
  lockCredentials: () => {},
  disconnect: () => {},
  ...over,
});

const ids = (actions: { id: string }[]) => actions.map((a) => a.id);

test('a disconnected window only offers the always-available actions', () => {
  const actions = buildCommandActions(context({ connected: false }));
  expect(ids(actions)).toEqual(['settings', 'onboarding', 'lock-credentials']);
  expect(ids(actions)).not.toContain('disconnect');
});

test('a connected window offers the working actions', () => {
  const actions = buildCommandActions(context());
  for (const id of ['refresh', 'new-folder', 'upload', 'sync-open', 'disconnect', 'links']) {
    expect(ids(actions)).toContain(id);
  }
});

test('the theme row names the current theme', () => {
  const actions = buildCommandActions(context({ themeLabel: 'Light' }));
  expect(actions.find((a) => a.id === 'cycle-theme')?.label).toBe('Theme: Light');
});

test('the dual pane row names what the next click does', () => {
  expect(buildCommandActions(context({ dualPaneEnabled: false })).find((a) => a.id === 'toggle-dual-pane')?.label)
    .toBe('Show Local Pane');
  expect(buildCommandActions(context({ dualPaneEnabled: true })).find((a) => a.id === 'toggle-dual-pane')?.label)
    .toBe('Hide Local Pane');
});

test('editor actions appear only while an editor is open', () => {
  expect(ids(buildCommandActions(context()))).not.toContain('stop-all-editors');

  const actions = buildCommandActions(context({
    editSessions: [editor('e1', 'notes.md', 2), editor('e2', 'todo.md')],
  }));
  expect(ids(actions)).toContain('stop-all-editors');
  expect(ids(actions)).toContain('stop-edit-e1');
  expect(ids(actions)).toContain('stop-edit-e2');
  expect(actions.find((a) => a.id === 'stop-edit-e1')?.hint).toBe('saved 2×');
  expect(actions.find((a) => a.id === 'stop-edit-e2')?.hint).toBe('unsaved');
});

test('each sync profile gets a run row and a previewing run-now row', () => {
  const actions = buildCommandActions(context({ syncProfiles: [syncProfile('s1', 'Nightly')] }));
  expect(ids(actions)).toContain('run-sync-s1');
  expect(ids(actions)).toContain('run-sync-now-s1');
  expect(actions.find((a) => a.id === 'run-sync-now-s1')?.hint).toContain('previews diff');
});

test('running a sync profile calls the given callback', () => {
  let ran: string | null = null;
  let ranNow = false;
  const profile = syncProfile('s1', 'Nightly');
  const actions = buildCommandActions(context({
    syncProfiles: [profile],
    runSync: (p) => { ran = p.id; },
    runSyncNow: (p) => { ranNow = p.id === 's1'; },
  }));

  actions.find((a) => a.id === 'run-sync-s1')?.run();
  expect(ran).toBe('s1');

  actions.find((a) => a.id === 'run-sync-now-s1')?.run();
  expect(ranNow).toBe(true);
});

test('disconnect runs the confirming disconnect', () => {
  let disconnected = false;
  const actions = buildCommandActions(context({ disconnect: () => { disconnected = true; } }));
  actions.find((a) => a.id === 'disconnect')?.run();
  expect(disconnected).toBe(true);
});
