import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Connection } from './components/Connection';
import { Explorer } from './components/Explorer';
import type { GaleonObject, StorageProtocol } from './types';
import { TransferManager, TransferState } from './components/TransferManager';
import { CommandPalette, CommandAction } from './components/CommandPalette';
import { PropertiesInspector } from './components/PropertiesInspector';
import type { EditSessionInfo } from './components/ActiveEditors';
import { ConnectedHeader } from './components/ConnectedHeader';
import { DisconnectConfirmations } from './components/DisconnectConfirm';
import { buildCommandActions } from './commandActions';
import { SyncPanel } from './components/SyncPanel';
import type { SyncProfile } from './syncModel';
import { OnboardingWizard, OnboardingProtocol } from './components/OnboardingWizard';
import { SettingsPanel } from './components/SettingsPanel';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { detectShortcutPlatform } from './keyboardShortcuts';
import { DeleteProgressToast, DeleteProgress } from './components/DeleteProgressToast';
import { LocalPane } from './components/LocalPane';
import { SplitPane } from './components/SplitPane';
import { PresignHistoryModal } from './components/PresignHistoryModal';
import { nextThemeMode, THEME_LABELS } from './theme';
import { useLayoutPreferences } from './hooks/useLayoutPreferences';
import { disconnectNeedsConfirm } from './disconnectGuard';

import type {
  AppSettings,
  ConnectionProfile,
  PresignHistoryEntry,
  ProtocolCapabilities,
} from './types';

// Which glyphs the cheatsheet draws: ⌘ on macOS, Ctrl everywhere else.
const SHORTCUT_PLATFORM = detectShortcutPlatform(
  typeof navigator === 'undefined' ? undefined : navigator,
);

function App() {
  const [session, setSession] = useState<{
  sessionId: string;
  bucket: string;
  profileId?: string;
  protocol?: StorageProtocol;
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
  // Disconnect awaiting the same warning while external edit sessions are
  // mid-flight; true opens the confirmation modal.
  const [pendingDisconnect, setPendingDisconnect] = useState(false);

  // Phase 11 — one-way sync
  const [syncProfiles, setSyncProfiles] = useState<SyncProfile[]>([]);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [syncPrefillProfile, setSyncPrefillProfile] = useState<SyncProfile | null>(null);
  // "Run sync profile now" asks SyncPanel to compute the diff as soon as the
  // profile is loaded. Execution still only happens through the panel's diff +
  // delete-confirmation flow.
  const [syncRunNow, setSyncRunNow] = useState(false);

  // Phase 12 — scheduled sync run notifications
  const [scheduleToast, setScheduleToast] = useState<string | null>(null);

  // Background delete job progress
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null);
  const deleteJobIdRef = useRef<string | null>(null);

  // Phase 14 — onboarding & settings
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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

  // Native menu: Galeon → Settings… (⌘,), File → Upload / New Folder /
  // Disconnect, View → Toggle Local Pane / Command Palette / Sync / Shared
  // Links. One subscription for every item, and each event runs the same
  // handler the titlebar button runs.
  //
  // The subscription lives for the life of the window, so the live session is
  // mirrored into a ref rather than captured in a stale closure.
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: (() => void)[] = [];

    const handleMenuEvent = (name: string) => {
      switch (name) {
        case 'menu://preferences':
          setSettingsOpen(true);
          return;
        case 'menu://keyboard-shortcuts':
          setShortcutsOpen(true);
          return;
        case 'menu://command-palette':
          setPaletteOpen(true);
          return;
        case 'menu://toggle-local-pane':
          toggleDualPane();
          return;
        case 'menu://sync':
          if (!sessionRef.current) return;
          setSyncPrefillProfile(null);
          setSyncRunNow(false);
          setSyncPanelOpen(true);
          return;
        case 'menu://links':
          if (!sessionRef.current) return;
          loadPresignHistory();
          setShowHistory(true);
          return;
        case 'menu://upload':
          explorerCmdsRef.current?.upload();
          return;
        case 'menu://new-folder':
          explorerCmdsRef.current?.newFolder();
          return;
        case 'menu://disconnect':
          requestDisconnect();
          return;
      }
    };

    const events = [
      'menu://preferences',
      'menu://keyboard-shortcuts',
      'menu://command-palette',
      'menu://toggle-local-pane',
      'menu://sync',
      'menu://links',
      'menu://upload',
      'menu://new-folder',
      'menu://disconnect',
    ];

    Promise.all(events.map((name) => listen(name, () => handleMenuEvent(name))))
      .then((fns) => {
        // An unlisten that resolves after cleanup has to be called right away.
        if (cancelled) {
          fns.forEach((fn) => fn());
          return;
        }
        unlisteners.push(...fns);
      })
      .catch((err) => console.error('Failed to listen for menu events:', err));

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
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
      const result = await invoke<{ sessionId: string; bucket: string; profileId: string; protocol?: StorageProtocol } | null>('auto_reconnect');
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

  const handleConnected = async (sessionId: string, bucket: string, profileId?: string, protocol?: StorageProtocol) => {
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

  const handleGeneratePresignedUploadUrl = async (key: string, expiresInSeconds: number): Promise<string> => {
    if (!session) throw new Error('No active session');
    const url = await invoke<string>('generate_presigned_upload_url', {
      sessionId: session.sessionId,
      key,
      expiresInSeconds,
    });
    // History modal reads from the backend on open; refresh the badge eagerly.
    loadPresignHistory();
    return url;
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
      setPendingDisconnect(false);
      setPendingSwitchProfile(profile);
      return;
    }
    await doConnectProfile(profile);
  }, [doConnectProfile]);

  // The titlebar switcher lists saved profiles by name and subtitle only —
  // never the credentials a profile carries.
  const switcherProfiles = useMemo(
    () => profiles.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      username: p.username,
      host: p.host,
      port: p.port?.toString(),
      bucket: p.bucket,
      endpoint: p.endpoint,
    })),
    [profiles],
  );

  // Switching goes through the same connect path as the palette, so the
  // editor warning still appears before the session is replaced.
  const handleSwitchConnection = useCallback((profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    connectProfile(profile);
  }, [profiles, connectProfile]);

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
  const performDisconnect = useCallback(() => {
    editSessionsRef.current.forEach((s) => { invoke('stop_editing_file', { editorId: s.editorId }).catch(() => {}); });
    editSessionsRef.current = [];
    setEditSessions([]);
    setInspectorOpen(false);
    setPaletteOpen(false);
    setRecentPaths([]);
    setSession(null);
  }, []);

  // Gating wrapper: confirm before tearing the session down while external
  // edit sessions are mid-flight. Reads the live count from the ref to keep
  // this callback's deps minimal. Only one warning dialog is mounted at a time.
  const requestDisconnect = useCallback(() => {
    if (disconnectNeedsConfirm(editSessionsRef.current.length)) {
      setPendingSwitchProfile(null);
      setPendingDisconnect(true);
      return;
    }
    performDisconnect();
  }, [performDisconnect]);

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

  // Scheduled sync run completion toast + reload profiles (budget refusals
  // name their planned count and the limit that withheld them).
  useEffect(() => {
    const sub = listen<{
      profileId: string;
      success: boolean;
      failures: number;
      /** Set when the run withheld its planned deletions over the profile's budget. */
      deletesBlocked?: { planned: number; cap: number } | null;
      completedAtMs: number;
    }>('schedule-run-complete', (event) => {
      const { profileId, success, failures, deletesBlocked } = event.payload;
      const name = syncProfilesRef.current.find((sp) => sp.id === profileId)?.name ?? 'Sync profile';
      let message: string;
      if (!success) {
        message = `Scheduled sync "${name}" failed`;
      } else if (deletesBlocked) {
        // Say both numbers: the destination stopped mirroring on purpose, and
        // someone should get the chance to review before raising the limit.
        message = `Scheduled sync "${name}" withheld ${deletesBlocked.planned} deletion${deletesBlocked.planned === 1 ? '' : 's'} (limit ${deletesBlocked.cap})`;
      } else if (failures > 0) {
        message = `Scheduled sync "${name}" finished with ${failures} failure${failures === 1 ? '' : 's'}`;
      } else {
        message = `Scheduled sync "${name}" completed successfully`;
      }
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

  const paletteActions: CommandAction[] = buildCommandActions({
    connected: session !== null,
    themeLabel: THEME_LABELS[themeMode],
    dualPaneEnabled,
    editSessions,
    syncProfiles,
    refresh: () => explorerCmdsRef.current?.refresh(),
    newFolder: () => explorerCmdsRef.current?.newFolder(),
    upload: () => explorerCmdsRef.current?.upload(),
    toggleTheme: () => setThemeMode((prev) => nextThemeMode(prev)),
    toggleDualPane: () => toggleDualPane(),
    openInspector: () => setInspectorOpen(true),
    openLinks: () => { loadPresignHistory(); setShowHistory(true); },
    stopAllEditors: handleStopAllEditors,
    stopEditor: (editorId) => handleStopEditor(editorId),
    openSync: () => { setSyncPrefillProfile(null); setSyncRunNow(false); setSyncPanelOpen(true); },
    runSync: (sp) => { setSyncPrefillProfile(sp); setSyncRunNow(false); setSyncPanelOpen(true); },
    runSyncNow: (sp) => { setSyncPrefillProfile(sp); setSyncRunNow(true); setSyncPanelOpen(true); },
    openSettings: () => setSettingsOpen(true),
    openShortcuts: () => setShortcutsOpen(true),
    showOnboarding: handleShowOnboardingAgain,
    lockCredentials: handleLockCredentials,
    disconnect: requestDisconnect,
  });

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
        <ShortcutsDialog
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          platform={SHORTCUT_PLATFORM}
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
      <ConnectedHeader
        bucket={session.bucket}
        protocol={session.protocol}
        profileId={session.profileId}
        profiles={switcherProfiles}
        onConnect={handleSwitchConnection}
        onDisconnect={requestDisconnect}
        dualPaneEnabled={dualPaneEnabled}
        onToggleDualPane={() => setDualPaneEnabled((prev) => !prev)}
        editSessions={editSessions}
        onStopEditor={handleStopEditor}
        onStopAllEditors={handleStopAllEditors}
      />
      <main className="flex-1 min-h-0 overflow-hidden">
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
                onDownloadToLocal={(remoteKeys, targetDir) => {
                  for (const remoteKey of remoteKeys) {
                    const fileName = remoteKey.split('/').pop() || 'file';
                    const sep = targetDir.endsWith('/') ? '' : '/';
                    handleInitiateDownload(remoteKey, `${targetDir}${sep}${fileName}`);
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
                onGeneratePresignedUploadUrl={handleGeneratePresignedUploadUrl}
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
            onGeneratePresignedUploadUrl={handleGeneratePresignedUploadUrl}
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
        onClose={() => { setSyncPanelOpen(false); setSyncPrefillProfile(null); setSyncRunNow(false); }}
        sessionId={session.sessionId}
        connectionProfileId={session.profileId}
        profiles={profiles}
        syncProfiles={syncProfiles}
        currentRemotePrefix={recentPaths[0] ?? ''}
        prefillProfile={syncPrefillProfile}
        runNow={syncRunNow}
        onSaveSyncProfile={handleSaveSyncProfile}
        onDeleteSyncProfile={handleDeleteSyncProfile}
        onSyncComplete={() => explorerCmdsRef.current?.refresh()}
      />

      {/* Disconnect-and-switch confirmation (external edits mid-flight) */}
      <DisconnectConfirmations
        switchPending={pendingSwitchProfile !== null}
        disconnectPending={pendingDisconnect}
        sessions={editSessions}
        onCancelSwitch={cancelSwitchProfile}
        onConfirmSwitch={confirmSwitchProfile}
        onCancelDisconnect={() => setPendingDisconnect(false)}
        onConfirmDisconnect={() => { setPendingDisconnect(false); performDisconnect(); }}
      />

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

      <ShortcutsDialog
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        platform={SHORTCUT_PLATFORM}
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
