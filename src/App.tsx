import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Connection } from './components/Connection';
import { Explorer, GaleonObject } from './components/Explorer';
import { TransferManager, TransferState } from './components/TransferManager';
import { CommandPalette, CommandAction } from './components/CommandPalette';
import { PropertiesInspector } from './components/PropertiesInspector';
import { ActiveEditors, EditSessionInfo } from './components/ActiveEditors';
import { Link, Command, RefreshCw, Settings, Columns } from 'lucide-react';
import { SyncPanel, SyncProfile } from './components/SyncPanel';
import { OnboardingWizard, OnboardingProtocol } from './components/OnboardingWizard';
import { SettingsPanel } from './components/SettingsPanel';
import { DeleteProgressToast, DeleteProgress } from './components/DeleteProgressToast';
import { LocalPane } from './components/LocalPane';
import { SplitPane } from './components/SplitPane';
import { PresignHistoryModal } from './components/PresignHistoryModal';
import { nextThemeMode, THEME_LABELS } from './theme';
import { useLayoutPreferences } from './hooks/useLayoutPreferences';

import type {
  AppSettings,
  ConnectionProfile,
  PresignHistoryEntry,
  ProtocolCapabilities,
} from './types';

function App() {
  const [session, setSession] = useState<{
  sessionId: string;
  bucket: string;
  profileId?: string;
  protocol?: 's3' | 'sftp' | 'ftp' | 'ftps';
  capabilities?: ProtocolCapabilities;
} | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [presignHistory, setPresignHistory] = useState<PresignHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Phase 9 — Power UX state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navRequest, setNavRequest] = useState<{ path: string; nonce: number } | null>(null);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorObject, setInspectorObject] = useState<GaleonObject | null>(null);
  const [inspectorMode, setInspectorMode] = useState<'properties' | 'preview'>('properties');
  const explorerCmdsRef = useRef<{ refresh: () => void; newFolder: () => void; upload: () => void } | null>(null);
  // Phase 10 — active external-editor sessions (reactive for the header UI),
  // mirrored in a ref so disconnect cleanup can read them outside render.
  const [editSessions, setEditSessions] = useState<EditSessionInfo[]>([]);
  const editSessionsRef = useRef<EditSessionInfo[]>([]);
  const syncProfilesRef = useRef<SyncProfile[]>([]);
  // Phase 10 — profile awaiting a disconnect-and-switch confirmation while
  // external edit sessions are mid-flight; non-null opens the warning modal.
  const [pendingSwitchProfile, setPendingSwitchProfile] = useState<ConnectionProfile | null>(null);

  // Phase 11 — one-way sync
  const [syncProfiles, setSyncProfiles] = useState<SyncProfile[]>([]);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [syncPrefillProfile, setSyncPrefillProfile] = useState<SyncProfile | null>(null);

  // Phase 12 — scheduled sync run notifications
  const [scheduleToast, setScheduleToast] = useState<string | null>(null);

  // Background delete job progress
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null);
  const deleteJobIdRef = useRef<string | null>(null);

  // Phase 14 — onboarding & settings
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingProtocol, setOnboardingProtocol] = useState<OnboardingProtocol | null>(null);

  // Layout preferences (dual pane, its path, split ratio, theme) live in one
  // hook: they are a cohesive cluster that only talks to app_settings.json, and
  // putting them here kept growing the shell. See hooks/useLayoutPreferences.
  const {
    dualPaneEnabled,
    setDualPaneEnabled,
    toggleDualPane,
    localPanePath,
    setLocalPanePath,
    splitRatio,
    setSplitRatio,
    themeMode,
    setThemeMode,
    applyLoadedSettings,
  } = useLayoutPreferences();
  const localPaneCmdsRef = useRef<{ refresh: () => void; newFolder: () => void } | null>(null);

  useEffect(() => {
    loadProfiles();
    loadPresignHistory();
    attemptAutoReconnect();
    loadAppSettings();
  }, []);

  // Global keyboard shortcut: ⌥⌘L → toggle dual pane
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.metaKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        toggleDualPane();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Native menu: Galeon → Settings… (⌘,)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('menu://preferences', () => {
      setSettingsOpen(true);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => console.error('Failed to listen for preferences menu:', err));
    return () => {
      unlisten?.();
    };
  }, []);

  const loadAppSettings = async () => {
    try {
      const settings = await invoke<AppSettings>('get_app_settings');
      setShowOnboarding(!settings.onboardingComplete);
      // One fetch feeds both concerns; the hook seeds itself and paints the theme.
      applyLoadedSettings(settings);
    } catch (err) {
      console.error('Failed to load app settings:', err);
    }
  };

  const completeOnboarding = async (selectedProtocol?: OnboardingProtocol) => {
    try {
      const settings = await invoke<AppSettings>('get_app_settings');
      await invoke('save_app_settings', {
        settings: {
          ...settings,
          onboardingComplete: true,
          updatedAtMs: Date.now(),
        },
      });
    } catch (err) {
      console.error('Failed to save onboarding state:', err);
    }
    setShowOnboarding(false);
    if (selectedProtocol) {
      setOnboardingProtocol(selectedProtocol);
    }
  };

  const handleShowOnboardingAgain = () => {
    setShowOnboarding(true);
  };

  const handleLockCredentials = async () => {
    try {
      await invoke('lock_credentials_now');
    } catch (err) {
      console.error('Failed to lock credentials:', err);
    }
  };

  const attemptAutoReconnect = async () => {
    try {
      const result = await invoke<{ sessionId: string; bucket: string; profileId: string; protocol?: 's3' | 'sftp' | 'ftp' | 'ftps' } | null>('auto_reconnect');
      if (result) {
        console.log('[App] Auto-reconnected to profile:', result.profileId);
        // Fetch capabilities for the protocol
        let caps: ProtocolCapabilities | undefined;
        try {
          caps = await invoke<ProtocolCapabilities>('get_protocol_capabilities', { protocol: result.protocol || 's3' });
        } catch { /* ignore */ }
        setSession({ sessionId: result.sessionId, bucket: result.bucket, profileId: result.profileId, protocol: result.protocol, capabilities: caps });
        loadSyncProfiles();
      }
    } catch (err) {
      console.error('[App] Auto-reconnect failed:', err);
    }
  };

  const loadProfiles = async () => {
    try {
      const loadedProfiles = await invoke<ConnectionProfile[]>('get_profiles');
      setProfiles(loadedProfiles);
    } catch (err) {
      console.error('Failed to load profiles:', err);
    }
  };

  const loadPresignHistory = async () => {
    try {
      const history = await invoke<PresignHistoryEntry[]>('get_presign_history');
      setPresignHistory(history);
    } catch (err) {
      console.error('Failed to load presign history:', err);
    }
  };

  const clearPresignHistory = async () => {
    try {
      await invoke('clear_presign_history');
      setPresignHistory([]);
    } catch (err) {
      console.error('Failed to clear presign history:', err);
    }
  };

  const deletePresignHistoryEntry = async (entryId: string) => {
    try {
      await invoke('delete_presign_history_entry', { entryId });
      setPresignHistory(prev => prev.filter(e => e.id !== entryId));
    } catch (err) {
      console.error('Failed to delete presign history entry:', err);
    }
  };

  const handleSaveProfile = async (
    profile: ConnectionProfile,
    password?: string | null,
    sshTunnelPassword?: string | null,
  ) => {
    await invoke('save_profile', {
      profile,
      password: password ?? null,
      sshTunnelPassword: sshTunnelPassword ?? null,
    });
    await loadProfiles();
  };

  const handleDeleteProfile = async (profileId: string) => {
    await invoke('delete_profile', { profileId });
    await loadProfiles();
  };

  // Phase 11 — sync profile management
  const loadSyncProfiles = async () => {
    try {
      const loaded = await invoke<SyncProfile[]>('get_sync_profiles');
      setSyncProfiles(loaded);
    } catch (err) {
      console.error('Failed to load sync profiles:', err);
    }
  };

  const handleSaveSyncProfile = async (profile: SyncProfile) => {
    await invoke('save_sync_profile', { profile });
    await loadSyncProfiles();
  };

  const handleDeleteSyncProfile = async (profileId: string) => {
    await invoke('delete_sync_profile', { profileId });
    await loadSyncProfiles();
  };

  const handleConnected = async (sessionId: string, bucket: string, profileId?: string, protocol?: 's3' | 'sftp' | 'ftp' | 'ftps') => {
    // Fetch protocol capabilities
    let capabilities: ProtocolCapabilities | undefined;
    try {
      capabilities = await invoke<ProtocolCapabilities>('get_protocol_capabilities', { protocol: protocol || 's3' });
    } catch (err) {
      console.error('Failed to get protocol capabilities:', err);
    }
    setSession({ sessionId, bucket, profileId, protocol, capabilities });
    // Phase 11: load sync profiles on every connect
    loadSyncProfiles();
  };

  const handleInitiateDownload = async (remoteKey: string, localPath: string) => {
    if (!session) return;
    try {
      await invoke('initiate_download', {
        sessionId: session.sessionId,
        remoteKey,
        localPath,
        profileId: session.profileId ?? null,
      });
    } catch (err) {
      console.error('Download failed to start:', err);
      // Surface start failures (session gone, bad path) without a silent no-op
      window.alert(typeof err === 'string' ? err : 'Download failed to start.');
    }
  };

  const handleInitiateUpload = async (localPath: string, remoteKey: string) => {
    if (!session) return;
    try {
      await invoke('initiate_upload', {
        sessionId: session.sessionId,
        localPath,
        remoteKey,
        profileId: session.profileId ?? null,
      });
    } catch (err) {
      console.error('Upload failed to start:', err);
      window.alert(typeof err === 'string' ? err : 'Upload failed to start.');
    }
  };

  // Retry must respect direction: re-downloading a failed upload would
  // overwrite the local source file with the (stale) remote object.
  const handleRetryTransfer = async (transfer: TransferState) => {
    if (!transfer.localPath) return;
    if (transfer.direction === 'upload') {
      await handleInitiateUpload(transfer.localPath, transfer.remoteKey);
    } else {
      await handleInitiateDownload(transfer.remoteKey, transfer.localPath);
    }
  };

  const handleCreateFolder = async (prefix: string, folderName: string) => {
    if (!session) return;
    await invoke('create_folder', {
      sessionId: session.sessionId,
      prefix,
      folderName,
    });
  };

  const handleDeleteObjects = async (items: { key: string; isFolder: boolean }[]) => {
    if (!session || items.length === 0) return;
    const { jobId } = await invoke<{ jobId: string }>('delete_objects', {
      sessionId: session.sessionId,
      items,
    });
    deleteJobIdRef.current = jobId;
    setDeleteProgress({
      jobId,
      done: 0,
      total: items.length,
      currentKey: items[0].key,
      complete: false,
      cancelled: false,
      failures: [],
    });
  };

  const handleCancelDelete = () => {
    const jobId = deleteJobIdRef.current;
    if (jobId) invoke('cancel_delete_job', { jobId }).catch(() => {});
  };

  const handleDismissDeleteProgress = () => {
    deleteJobIdRef.current = null;
    setDeleteProgress(null);
  };

  const handleRenameObject = async (oldKey: string, newKey: string, isFolder: boolean) => {
    if (!session) return;
    await invoke('rename_object', {
      sessionId: session.sessionId,
      oldKey,
      newKey,
      isFolder,
    });
  };

  const handleGeneratePresignedUrl = async (key: string, expiresInSeconds: number): Promise<string> => {
    if (!session) throw new Error('No active session');
    return await invoke<string>('generate_presigned_url', {
      sessionId: session.sessionId,
      key,
      expiresInSeconds,
    });
  };

  // Phase 9 — Power UX handlers

  // Track visited folders for the Command Palette "Recent Paths" section.
  const handlePrefixChange = useCallback((prefix: string) => {
    setRecentPaths((prev) => [prefix, ...prev.filter((p) => p !== prefix)].slice(0, 12));
  }, []);

  const handleNavigatePath = useCallback((path: string) => {
    setNavRequest({ path, nonce: Date.now() });
  }, []);

  const handleRegisterCommands = useCallback(
    (cmds: { refresh: () => void; newFolder: () => void; upload: () => void }) => {
      explorerCmdsRef.current = cmds;
    },
    [],
  );

  // Refetch the active edit-session list (scoped to the current session) so the
  // Active Editors header control and Command Palette stay in sync with the
  // backend registry.
  const refreshEditSessions = useCallback(async () => {
    if (!session) { setEditSessions([]); return; }
    try {
      const list = await invoke<EditSessionInfo[]>('list_edit_sessions', { sessionId: session.sessionId });
      setEditSessions(list);
    } catch (err) {
      console.error('Failed to list edit sessions:', err);
    }
  }, [session]);

  const handleEditRemoteFile = useCallback(async (remoteKey: string) => {
    if (!session) return;
    try {
      await invoke<string>('edit_remote_file', {
        sessionId: session.sessionId,
        remoteKey,
        profileId: session.profileId ?? null,
      });
      await refreshEditSessions();
    } catch (err) {
      console.error('Edit in external editor failed:', err);
    }
  }, [session, refreshEditSessions]);

  const handleStopEditor = useCallback(async (editorId: string) => {
    try {
      await invoke('stop_editing_file', { editorId });
    } catch (err) {
      console.error('Failed to stop editor:', err);
    }
    await refreshEditSessions();
  }, [refreshEditSessions]);

  const handleStopAllEditors = useCallback(async () => {
    const ids = editSessionsRef.current.map((s) => s.editorId);
    await Promise.all(ids.map((id) => invoke('stop_editing_file', { editorId: id }).catch(() => {})));
    await refreshEditSessions();
  }, [refreshEditSessions]);

  const handleShowProperties = useCallback((obj: GaleonObject) => {
    setInspectorObject(obj);
    setInspectorMode('properties');
    setInspectorOpen(true);
  }, []);

  const handleShowPreview = useCallback((obj: GaleonObject) => {
    setInspectorObject(obj);
    setInspectorMode('preview');
    setInspectorOpen(true);
  }, []);

  // Actual connect flow for a saved profile, mirroring the unified connect
  // used by the Connection screen (credentials come from the OS keyring, not
  // the stored profile).
  const doConnectProfile = useCallback(async (profile: ConnectionProfile) => {
    try {
      const proto = profile.protocol || 's3';
      let password: string | null = null;
      let sshTunnelPassword: string | null = profile.sshTunnel?.password ?? null;
      let fullProfile: ConnectionProfile = { ...profile };
      if (proto === 's3') {
        try {
          const creds = await invoke<[string | null, string | null]>('get_profile_credentials', { profileId: profile.id });
          fullProfile = { ...fullProfile, accessKey: creds[0] ?? profile.accessKey, secretKey: creds[1] ?? profile.secretKey };
        } catch { /* fall back to whatever the profile carries */ }
      } else {
        try {
          const creds = await invoke<[string | null, string | null]>('get_profile_credentials', { profileId: profile.id });
          password = creds[1] ?? null;
        } catch { /* no stored password */ }
      }
      if (profile.sshTunnel) {
        try {
          sshTunnelPassword = await invoke<string | null>('get_profile_ssh_tunnel_password', {
            profileId: profile.id,
          });
        } catch { /* key / agent authentication may still work */ }
      }
      const sessionId = await invoke<string>('connect_storage', {
        profile: fullProfile,
        password,
        sshTunnelPassword,
      });
      const displayName = proto === 's3' ? (profile.bucket || 'S3') : `${profile.username}@${profile.host}`;
      await handleConnected(sessionId, displayName, profile.id, proto);
    } catch (err) {
      console.error('Command Palette connect failed:', err);
    }
  }, []);

  // Gating wrapper: if external edit sessions are mid-flight, defer the switch
  // and open a confirmation modal instead of silently orphaning the watchers.
  // Reads the live count from the ref to keep this callback's deps minimal.
  const connectProfile = useCallback(async (profile: ConnectionProfile) => {
    if (editSessionsRef.current.length > 0) {
      setPendingSwitchProfile(profile);
      return;
    }
    await doConnectProfile(profile);
  }, [doConnectProfile]);

  // "Switch anyway": stop every watcher, then perform the deferred connect.
  const confirmSwitchProfile = useCallback(async () => {
    const profile = pendingSwitchProfile;
    if (!profile) return;
    setPaletteOpen(false);
    await handleStopAllEditors();
    await doConnectProfile(profile);
    setPendingSwitchProfile(null);
  }, [pendingSwitchProfile, handleStopAllEditors, doConnectProfile]);

  // "Cancel": drop the deferred profile and keep the current session/watchers.
  const cancelSwitchProfile = useCallback(() => {
    setPendingSwitchProfile(null);
  }, []);

  // Stop any active external-editor watchers and tear down the session.
  const handleDisconnect = useCallback(() => {
    editSessionsRef.current.forEach((s) => { invoke('stop_editing_file', { editorId: s.editorId }).catch(() => {}); });
    editSessionsRef.current = [];
    setEditSessions([]);
    setInspectorOpen(false);
    setPaletteOpen(false);
    setRecentPaths([]);
    setSession(null);
  }, []);

  // Mirror edit sessions into a ref so disconnect can read them without a stale
  // closure, and refresh the list on backend lifecycle events while connected.
  useEffect(() => { editSessionsRef.current = editSessions; }, [editSessions]);
  useEffect(() => {
    if (!session) { setEditSessions([]); return; }
    refreshEditSessions();
    const subs = [
      listen('editor-saved', () => { refreshEditSessions(); }),
      listen('editor-closed', () => { refreshEditSessions(); }),
    ];
    return () => { subs.forEach((p) => p.then((un) => un()).catch(() => {})); };
  }, [session, refreshEditSessions]);

  // Phase 11 — clear sync UI on disconnect
  useEffect(() => {
    if (!session) {
      setSyncPanelOpen(false);
      setSyncPrefillProfile(null);
    }
  }, [session]);

  useEffect(() => { syncProfilesRef.current = syncProfiles; }, [syncProfiles]);

  // Phase 12 — scheduled sync run completion toast + reload profiles
  useEffect(() => {
    const sub = listen<{
      profileId: string;
      success: boolean;
      failures: number;
      completedAtMs: number;
    }>('schedule-run-complete', (event) => {
      const { profileId, success, failures } = event.payload;
      const name = syncProfilesRef.current.find((sp) => sp.id === profileId)?.name ?? 'Sync profile';
      const message = success
        ? failures > 0
          ? `Scheduled sync "${name}" finished with ${failures} failure${failures === 1 ? '' : 's'}`
          : `Scheduled sync "${name}" completed successfully`
        : `Scheduled sync "${name}" failed`;
      setScheduleToast(message);
      loadSyncProfiles();
    });
    return () => { sub.then((un) => un()).catch(() => {}); };
  }, []);

  useEffect(() => {
    if (!scheduleToast) return;
    const timer = setTimeout(() => setScheduleToast(null), 5000);
    return () => clearTimeout(timer);
  }, [scheduleToast]);

  useEffect(() => {
    const unsub = listen<DeleteProgress>('delete-progress', (ev) => {
      const payload = ev.payload;
      if (deleteJobIdRef.current && payload.jobId !== deleteJobIdRef.current) return;
      setDeleteProgress(payload);
      if (payload.complete) {
        explorerCmdsRef.current?.refresh();
      }
    });
    return () => { unsub.then((fn) => fn()).catch(() => {}); };
  }, []);

  useEffect(() => {
    if (!deleteProgress?.complete) return;
    if (deleteProgress.cancelled || deleteProgress.failures.length > 0 || deleteProgress.error) return;
    const timer = setTimeout(handleDismissDeleteProgress, 4000);
    return () => clearTimeout(timer);
  }, [deleteProgress]);

  const paletteActions: CommandAction[] = session
    ? [
        { id: 'refresh', label: 'Refresh', hint: 'Reload current folder', keywords: 'reload', run: () => explorerCmdsRef.current?.refresh() },
        { id: 'new-folder', label: 'New Folder', keywords: 'create directory mkdir', run: () => explorerCmdsRef.current?.newFolder() },
        { id: 'upload', label: 'Upload Files', keywords: 'put send', run: () => explorerCmdsRef.current?.upload() },
        { id: 'cycle-theme', label: `Theme: ${THEME_LABELS[themeMode]}`, hint: 'System → Light → Dark', keywords: 'appearance dark light theme mode colours colors', run: () => setThemeMode((prev) => nextThemeMode(prev)) },
        { id: 'toggle-dual-pane', label: dualPaneEnabled ? 'Hide Local Pane' : 'Show Local Pane', hint: '⌥⌘L', keywords: 'local filesystem split side by side dual pane', run: () => toggleDualPane() },
        { id: 'inspector', label: 'Open Properties Inspector', keywords: 'metadata details info', run: () => setInspectorOpen(true) },
        { id: 'links', label: 'Shared Links History', keywords: 'presign url share', run: () => { loadPresignHistory(); setShowHistory(true); } },
        ...(editSessions.length > 0
          ? [{ id: 'stop-all-editors', label: 'Stop All External Editors', hint: `${editSessions.length} active`, keywords: 'editor external edit close stop watch', run: handleStopAllEditors }]
          : []),
        ...editSessions.map((s) => ({
          id: `stop-edit-${s.editorId}`,
          label: `Stop editing ${s.filename}`,
          hint: s.saveCount > 0 ? `saved ${s.saveCount}×` : 'unsaved',
          keywords: 'editor external edit close stop watch',
          run: () => handleStopEditor(s.editorId),
        })),
        { id: 'sync-open', label: 'Open Sync', keywords: 'sync mirror upload download diff', run: () => { setSyncPrefillProfile(null); setSyncPanelOpen(true); } },
        ...syncProfiles.map((sp) => ({
          id: `run-sync-${sp.id}`,
          label: `Run sync: ${sp.name}`,
          hint: sp.direction === 'localToRemote' ? '→ remote' : '← local',
          keywords: 'sync mirror profile run',
          run: () => { setSyncPrefillProfile(sp); setSyncPanelOpen(true); },
        })),
        ...syncProfiles.map((sp) => ({
          id: `run-sync-now-${sp.id}`,
          label: `Run sync profile now: ${sp.name}`,
          hint: sp.direction === 'localToRemote' ? '→ remote' : '← local',
          keywords: 'sync mirror profile run now schedule immediate',
          run: () => { invoke('run_sync_profile_now', { profileId: sp.id }).catch((err) => console.error('Run sync profile now failed:', err)); },
        })),
        { id: 'settings', label: 'Open Settings', keywords: 'preferences config about privacy', run: () => setSettingsOpen(true) },
        { id: 'onboarding', label: 'Show Onboarding', keywords: 'welcome tutorial intro', run: handleShowOnboardingAgain },
        { id: 'lock-credentials', label: 'Lock Credentials Now', keywords: 'keychain password secure lock', run: handleLockCredentials },
        { id: 'disconnect', label: 'Disconnect', keywords: 'logout exit close', run: handleDisconnect },
      ]
    : [
        { id: 'settings', label: 'Open Settings', keywords: 'preferences config about privacy', run: () => setSettingsOpen(true) },
        { id: 'onboarding', label: 'Show Onboarding', keywords: 'welcome tutorial intro', run: handleShowOnboardingAgain },
        { id: 'lock-credentials', label: 'Lock Credentials Now', keywords: 'keychain password secure lock', run: handleLockCredentials },
      ];

  if (!session) {
    return (
      <>
        {showOnboarding && (
          <OnboardingWizard
            onComplete={completeOnboarding}
            onSkip={() => completeOnboarding()}
          />
        )}
        <Connection
          onConnected={handleConnected}
          profiles={profiles}
          onSaveProfile={handleSaveProfile}
          onDeleteProfile={handleDeleteProfile}
          onReloadProfiles={loadProfiles}
          initialProtocol={onboardingProtocol ?? undefined}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onShowOnboarding={handleShowOnboardingAgain}
          themeMode={themeMode}
          onThemeModeChange={setThemeMode}
        />
      </>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-950">
      {/*
        Native macOS chrome: Overlay titlebar + hiddenTitle keep system traffic
        lights; this header is the draggable toolbar that content lives under.
      */}
      <header
        data-tauri-drag-region
        className="app-titlebar app-titlebar-traffic justify-between gap-3 pr-3 bg-zinc-900 border-b border-zinc-800"
      >
        <div data-tauri-drag-region className="flex items-center gap-2 min-w-0">
          <h1
            data-tauri-drag-region
            className="text-[13px] font-semibold tracking-tight text-zinc-100 shrink-0"
          >
            Galeon
          </h1>
          <span data-tauri-drag-region className="text-zinc-700 shrink-0" aria-hidden>
            ·
          </span>
          <span
            data-tauri-drag-region
            className="text-[13px] text-zinc-400 truncate"
            title={session.protocol === 'sftp' || session.protocol === 'ftp' || session.protocol === 'ftps'
              ? (session.protocol ?? '').toUpperCase()
              : session.bucket}
          >
            {session.protocol === 'sftp' || session.protocol === 'ftp' || session.protocol === 'ftps'
              ? (session.protocol ?? '').toUpperCase()
              : session.bucket}
          </span>
        </div>
        <div data-no-drag className="flex items-center gap-1 shrink-0">
          {session && (
            <button
              onClick={() => setDualPaneEnabled((prev) => !prev)}
              title="Toggle Dual Pane (⌥⌘L)"
              className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition-colors ${
                dualPaneEnabled
                  ? 'text-gale-teal bg-gale-teal/10'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <Columns className="w-3 h-3" />
              <span>Local</span>
            </button>
          )}
          <button
            onClick={() => setPaletteOpen(true)}
            title="Command Palette (⌘K)"
            className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 px-2 py-1 rounded-md transition-colors"
          >
            <Command className="w-3 h-3" />
            <span className="metric-text">K</span>
          </button>
          <ActiveEditors
            sessions={editSessions}
            onStop={handleStopEditor}
            onStopAll={handleStopAllEditors}
          />
          <button
            onClick={() => { setSyncPrefillProfile(null); setSyncPanelOpen(true); }}
            title="Sync"
            className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 px-2 py-1 rounded-md transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Sync</span>
          </button>
          <button
            onClick={() => { loadPresignHistory(); setShowHistory(true); }}
            title="Shared links"
            className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 px-2 py-1 rounded-md transition-colors"
          >
            <Link className="w-3 h-3" />
            <span className="metric-text">{presignHistory.length}</span>
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings (⌘,)"
            className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 px-2 py-1 rounded-md transition-colors"
          >
            <Settings className="w-3 h-3" />
          </button>
          <button
            onClick={handleDisconnect}
            className="inline-flex items-center text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 px-2 py-1 rounded-md transition-colors ml-0.5"
          >
            Disconnect
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-hidden">
        {dualPaneEnabled ? (
          <SplitPane
              label="Local and remote pane divider"
              ratio={splitRatio}
              onRatioChange={setSplitRatio}
              left={
              <div className="h-full overflow-hidden">
              <LocalPane
                initialPath={localPanePath || undefined}
                remotePrefix={recentPaths[0] ?? ''}
                onUploadToRemote={(paths, targetPrefix) => {
                  for (const localPath of paths) {
                    const fileName = localPath.split(/[/\\]/).pop() || 'file';
                    const remoteKey = targetPrefix ? `${targetPrefix}${fileName}` : fileName;
                    handleInitiateUpload(localPath, remoteKey);
                  }
                }}
                onRegisterCommands={(cmds) => { localPaneCmdsRef.current = cmds; }}
                onPathChange={setLocalPanePath}
              />
              </div>
              }
              right={
              <div className="h-full overflow-hidden">
              <Explorer
                key={session.sessionId}
                sessionId={session.sessionId}
                bucket={session.bucket}
                protocol={session.protocol}
                capabilities={session.capabilities}
                onInitiateDownload={handleInitiateDownload}
                onInitiateUpload={handleInitiateUpload}
                onCreateFolder={handleCreateFolder}
                onDeleteObjects={handleDeleteObjects}
                onRenameObject={handleRenameObject}
                onGeneratePresignedUrl={handleGeneratePresignedUrl}
                onEditRemoteFile={handleEditRemoteFile}
                onShowProperties={handleShowProperties}
                onShowPreview={handleShowPreview}
                navRequest={navRequest}
                onPrefixChange={handlePrefixChange}
                onRegisterCommands={handleRegisterCommands}
                downloadDestination={localPanePath || undefined}
              />
              </div>
              }
            />
        ) : (
          <Explorer
            key={session.sessionId}
            sessionId={session.sessionId}
            bucket={session.bucket}
            protocol={session.protocol}
            capabilities={session.capabilities}
            onInitiateDownload={handleInitiateDownload}
            onInitiateUpload={handleInitiateUpload}
            onCreateFolder={handleCreateFolder}
            onDeleteObjects={handleDeleteObjects}
            onRenameObject={handleRenameObject}
            onGeneratePresignedUrl={handleGeneratePresignedUrl}
            onEditRemoteFile={handleEditRemoteFile}
            onShowProperties={handleShowProperties}
            onShowPreview={handleShowPreview}
            navRequest={navRequest}
            onPrefixChange={handlePrefixChange}
            onRegisterCommands={handleRegisterCommands}
          />
        )}
      </main>
      <TransferManager onRetry={handleRetryTransfer} />

      {deleteProgress && (
        <DeleteProgressToast
          progress={deleteProgress}
          onCancel={handleCancelDelete}
          onDismiss={handleDismissDeleteProgress}
        />
      )}

      {scheduleToast && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm px-4 py-3 rounded-lg border border-zinc-700 bg-zinc-900 text-sm text-zinc-200 shadow-xl">
          {scheduleToast}
        </div>
      )}

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        profiles={profiles}
        recentPaths={recentPaths}
        onConnectProfile={connectProfile}
        onNavigatePath={handleNavigatePath}
        actions={paletteActions}
      />

      <PropertiesInspector
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        sessionId={session.sessionId}
        object={inspectorObject}
        protocol={session.protocol}
        capabilities={session.capabilities}
        mode={inspectorMode}
      />

      {/* Phase 11 — Sync Panel */}
      <SyncPanel
        open={syncPanelOpen}
        onClose={() => { setSyncPanelOpen(false); setSyncPrefillProfile(null); }}
        sessionId={session.sessionId}
        connectionProfileId={session.profileId}
        profiles={profiles}
        syncProfiles={syncProfiles}
        currentRemotePrefix={recentPaths[0] ?? ''}
        prefillProfile={syncPrefillProfile}
        onSaveSyncProfile={handleSaveSyncProfile}
        onDeleteSyncProfile={handleDeleteSyncProfile}
        onSyncComplete={() => explorerCmdsRef.current?.refresh()}
      />

      {/* Disconnect-and-switch confirmation (external edits mid-flight) */}
      {pendingSwitchProfile && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-[480px] max-h-[80vh] shadow-2xl flex flex-col">
            <h3 className="text-lg font-semibold mb-2">Switch connection?</h3>
            <p className="text-sm text-zinc-400">
              You have {editSessions.length} file{editSessions.length === 1 ? '' : 's'} open in an external editor.
              Switching will stop watching them — unsaved changes in your editor won't be re-uploaded.
            </p>
            {editSessions.length > 0 && (
              <ul className="mt-3 max-h-40 overflow-y-auto space-y-1 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
                {editSessions.map((s) => (
                  <li key={s.editorId} className="text-sm text-zinc-300 truncate">
                    {s.filename}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-6 flex justify-end space-x-2">
              <button
                onClick={cancelSwitchProfile}
                className="px-4 py-2 text-sm rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={confirmSwitchProfile}
                className="px-4 py-2 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-500"
              >
                Switch anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {showOnboarding && (
        <OnboardingWizard
          onComplete={completeOnboarding}
          onSkip={() => completeOnboarding()}
        />
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onShowOnboarding={handleShowOnboardingAgain}
        themeMode={themeMode}
        onThemeModeChange={setThemeMode}
      />

      {/* Presign History Modal */}
      {showHistory && (
        <PresignHistoryModal
          entries={presignHistory}
          onClearAll={clearPresignHistory}
          onDelete={deletePresignHistoryEntry}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}

export default App;
