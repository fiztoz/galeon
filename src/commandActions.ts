import type { CommandAction } from './components/CommandPalette';
import type { EditSessionInfo } from './components/ActiveEditors';
import type { SyncProfile } from './components/SyncPanel';

/**
 * The command palette's action list.
 *
 * Pure on purpose: the list is a decision table — what the user can do right
 * now — and it is easier to read (and to test) when it is not tangled up
 * with the component that renders it.
 */
export type CommandActionContext = {
  /** Whether a storage session is open. */
  connected: boolean;
  /** The current theme, already labelled for the menu row. */
  themeLabel: string;
  dualPaneEnabled: boolean;
  editSessions: EditSessionInfo[];
  syncProfiles: SyncProfile[];

  refresh: () => void;
  newFolder: () => void;
  upload: () => void;
  toggleTheme: () => void;
  toggleDualPane: () => void;
  openInspector: () => void;
  openLinks: () => void;
  stopAllEditors: () => void;
  stopEditor: (editorId: string) => void;
  openSync: () => void;
  runSync: (profile: SyncProfile) => void;
  runSyncNow: (profile: SyncProfile) => void;
  openSettings: () => void;
  showOnboarding: () => void;
  lockCredentials: () => void;
  disconnect: () => void;
};

export function buildCommandActions(ctx: CommandActionContext): CommandAction[] {
  if (!ctx.connected) {
    return [
      { id: 'settings', label: 'Open Settings', keywords: 'preferences config about privacy', run: ctx.openSettings },
      { id: 'onboarding', label: 'Show Onboarding', keywords: 'welcome tutorial intro', run: ctx.showOnboarding },
      { id: 'lock-credentials', label: 'Lock Credentials Now', keywords: 'keychain password secure lock', run: ctx.lockCredentials },
    ];
  }

  return [
    { id: 'refresh', label: 'Refresh', hint: 'Reload current folder', keywords: 'reload', run: ctx.refresh },
    { id: 'new-folder', label: 'New Folder', keywords: 'create directory mkdir', run: ctx.newFolder },
    { id: 'upload', label: 'Upload Files', keywords: 'put send', run: ctx.upload },
    { id: 'cycle-theme', label: `Theme: ${ctx.themeLabel}`, hint: 'System → Light → Dark', keywords: 'appearance dark light theme mode colours colors', run: ctx.toggleTheme },
    { id: 'toggle-dual-pane', label: ctx.dualPaneEnabled ? 'Hide Local Pane' : 'Show Local Pane', hint: '⌥⌘L', keywords: 'local filesystem split side by side dual pane', run: ctx.toggleDualPane },
    { id: 'inspector', label: 'Open Properties Inspector', keywords: 'metadata details info', run: ctx.openInspector },
    { id: 'links', label: 'Shared Links History', keywords: 'presign url share', run: ctx.openLinks },
    ...(ctx.editSessions.length > 0
      ? [{ id: 'stop-all-editors', label: 'Stop All External Editors', hint: `${ctx.editSessions.length} active`, keywords: 'editor external edit close stop watch', run: ctx.stopAllEditors }]
      : []),
    ...ctx.editSessions.map((s) => ({
      id: `stop-edit-${s.editorId}`,
      label: `Stop editing ${s.filename}`,
      hint: s.saveCount > 0 ? `saved ${s.saveCount}×` : 'unsaved',
      keywords: 'editor external edit close stop watch',
      run: () => ctx.stopEditor(s.editorId),
    })),
    { id: 'sync-open', label: 'Open Sync', keywords: 'sync mirror upload download diff', run: ctx.openSync },
    ...ctx.syncProfiles.map((sp) => ({
      id: `run-sync-${sp.id}`,
      label: `Run sync: ${sp.name}`,
      hint: sp.direction === 'localToRemote' ? '→ remote' : '← local',
      keywords: 'sync mirror profile run',
      run: () => ctx.runSync(sp),
    })),
    // "Run now" deliberately loads the profile into the panel instead of
    // executing anything directly: internal profile execution runs the
    // profile's delete_extraneous deletions with no diff preview and no
    // confirmation, and no plaintext path for it may remain (DIRECTION.md:
    // destructive actions always confirmed). The quick re-run affordance
    // is kept by loading the profile and auto-computing the diff
    // in SyncPanel — one keystroke still lands on the reviewed plan, and
    // Apply reuses the existing delete-confirmation block, so the count the
    // user approves is the count that runs. Errors surface in the panel.
    ...ctx.syncProfiles.map((sp) => ({
      id: `run-sync-now-${sp.id}`,
      label: `Run sync profile now: ${sp.name}`,
      hint: sp.direction === 'localToRemote' ? '→ remote · previews diff' : '← local · previews diff',
      keywords: 'sync mirror profile run now immediate',
      run: () => ctx.runSyncNow(sp),
    })),
    { id: 'settings', label: 'Open Settings', keywords: 'preferences config about privacy', run: ctx.openSettings },
    { id: 'onboarding', label: 'Show Onboarding', keywords: 'welcome tutorial intro', run: ctx.showOnboarding },
    { id: 'lock-credentials', label: 'Lock Credentials Now', keywords: 'keychain password secure lock', run: ctx.lockCredentials },
    { id: 'disconnect', label: 'Disconnect', keywords: 'logout exit close', run: ctx.disconnect },
  ];
}
