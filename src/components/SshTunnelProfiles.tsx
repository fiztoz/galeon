import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Check, ChevronRight, KeyRound, Network, Pencil, Plus, Save, Trash2, X } from 'lucide-react';

import { SshConfigConnection, SshConfigImport } from './SshConfigImport';
import { SavedSshTunnelValue, TunnelProtocol } from './sshTunnel';

export interface SshTunnelProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  keyPath?: string;
  hasSavedPassword: boolean;
}

interface TunnelProfileDraft extends SshTunnelProfile {
  password: string;
  clearPassword: boolean;
}

interface SshTunnelProfilesProps {
  selectedProfileId?: string;
  onChange: (profileId?: string) => void;
  protocol: Extract<TunnelProtocol, 's3' | 'sftp'>;
  legacyTunnel?: SavedSshTunnelValue;
  onClearLegacy: () => void;
}

const FIELD =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-500 focus:border-gale-teal focus:ring-1 focus:ring-gale-teal';

const emptyDraft = (): TunnelProfileDraft => ({
  id: crypto.randomUUID(),
  name: '',
  host: '',
  port: 22,
  username: '',
  keyPath: '',
  hasSavedPassword: false,
  password: '',
  clearPassword: false,
});

const draftFromProfile = (profile: SshTunnelProfile): TunnelProfileDraft => ({
  ...profile,
  password: '',
  clearPassword: false,
});

const messageFromError = (error: unknown): string =>
  typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);

export const SshTunnelProfiles: React.FC<SshTunnelProfilesProps> = ({
  selectedProfileId,
  onChange,
  protocol,
  legacyTunnel,
  onClearLegacy,
}) => {
  const [profiles, setProfiles] = useState<SshTunnelProfile[]>([]);
  const [editor, setEditor] = useState<TunnelProfileDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  const editorOpenRef = useRef(false);
  const enabled = Boolean(selectedProfileId || legacyTunnel);
  const selected = profiles.find((profile) => profile.id === selectedProfileId);
  const editingExistingProfile = editor
    ? profiles.some((profile) => profile.id === editor.id)
    : false;

  savingRef.current = saving;
  editorOpenRef.current = editor !== null;

  const loadProfiles = async () => {
    setLoading(true);
    try {
      const loaded = await invoke<SshTunnelProfile[]>('get_ssh_tunnel_profiles');
      setProfiles(loaded);
    } catch (loadError) {
      setError(messageFromError(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProfiles();
  }, []);

  useEffect(() => {
    if (!managerOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (savingRef.current) return;
        // Dismiss one layer at a time: an open editor cancels first so a single
        // Escape can't tear down the whole dialog and silently drop a half-typed
        // profile the user is still filling in.
        if (editorOpenRef.current) {
          setEditor(null);
          setDeleteArmedId(null);
          setError('');
          return;
        }
        setManagerOpen(false);
        setDeleteArmedId(null);
        setError('');
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (
        event.shiftKey &&
        (activeElement === first || activeElement === dialogRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last || activeElement === dialogRef.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
  }, [managerOpen]);

  const openManager = () => {
    setDeleteArmedId(null);
    setError('');
    setManagerOpen(true);
    void loadProfiles();
  };

  const closeManager = () => {
    if (saving) return;
    setManagerOpen(false);
    setEditor(null);
    setDeleteArmedId(null);
    setError('');
  };

  const cancelEditor = () => {
    if (saving) return;
    setEditor(null);
    setDeleteArmedId(null);
    setError('');
  };

  const chooseDirect = () => {
    setDeleteArmedId(null);
    onChange(undefined);
    onClearLegacy();
    setError('');
  };

  const keepLegacy = () => {
    setDeleteArmedId(null);
    onChange(undefined);
    setError('');
  };

  const chooseProfile = (profileId: string) => {
    setDeleteArmedId(null);
    onChange(profileId || undefined);
    if (profileId) onClearLegacy();
    setError('');
  };

  const saveProfile = async () => {
    if (!editor) return;
    if (!editor.name.trim() || !editor.host.trim() || !editor.username.trim()) {
      setError('Enter a name, SSH server, and username.');
      return;
    }
    if (!Number.isInteger(editor.port) || editor.port < 1 || editor.port > 65535) {
      setError('SSH port must be between 1 and 65535.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const profile: SshTunnelProfile = {
        id: editor.id,
        name: editor.name.trim(),
        host: editor.host.trim(),
        port: editor.port,
        username: editor.username.trim(),
        keyPath: editor.keyPath?.trim() || undefined,
        hasSavedPassword: editor.hasSavedPassword,
      };
      await invoke('save_ssh_tunnel_profile', {
        profile,
        password: editor.password || null,
        clearPassword: editor.clearPassword,
      });
      await loadProfiles();
      onChange(profile.id);
      onClearLegacy();
      setEditor(null);
    } catch (saveError) {
      setError(messageFromError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const deleteProfile = async (profile: SshTunnelProfile) => {
    if (deleteArmedId !== profile.id) {
      setDeleteArmedId(profile.id);
      return;
    }
    setError('');
    try {
      await invoke('delete_ssh_tunnel_profile', { profileId: profile.id });
      if (selectedProfileId === profile.id) onChange(undefined);
      if (editor?.id === profile.id) setEditor(null);
      await loadProfiles();
    } catch (deleteError) {
      setError(messageFromError(deleteError));
    } finally {
      setDeleteArmedId(null);
    }
  };

  const updateEditor = (patch: Partial<TunnelProfileDraft>) => {
    setEditor((current) => (current ? { ...current, ...patch } : current));
  };

  const importSshConfigConnection = (connection: SshConfigConnection) => {
    if (!editor) return;
    updateEditor({
      name: editor.name.trim() || connection.alias,
      host: connection.host,
      port: connection.port,
      username: connection.username ?? '',
      keyPath: connection.keyPath ?? '',
      password: '',
    });
    setError('');
  };

  const connectionSummary = selected
    ? `${selected.name} · ${selected.username}@${selected.host}:${selected.port}`
    : legacyTunnel
      ? `Embedded tunnel · ${legacyTunnel.username}@${legacyTunnel.host}:${legacyTunnel.port}`
      : selectedProfileId && loading
        ? 'Loading tunnel profile…'
        : selectedProfileId
          ? 'Tunnel profile unavailable'
          : 'Direct connection · No bastion configured';

  return (
    <>
      <section className="border-t border-zinc-800 pt-4" aria-label="SSH tunnel">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800 text-gale-teal">
              <Network className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-200">SSH tunnel</p>
              <p className={`mt-0.5 truncate text-xs ${selectedProfileId && !loading && !selected ? 'text-red-300' : 'text-zinc-500'}`}>
                {connectionSummary}
              </p>
            </div>
          </div>
          <button
            ref={triggerRef}
            type="button"
            onClick={openManager}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-gale-teal transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-gale-teal"
            aria-haspopup="dialog"
          >
            {enabled ? 'Manage' : 'Set up'}
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </section>

      {managerOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-4 sm:p-6"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (editor) cancelEditor();
            else closeManager();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ssh-tunnel-dialog-title"
            aria-describedby="ssh-tunnel-dialog-description"
            tabIndex={-1}
            className="flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-2xl outline-none"
          >
            <header className="flex items-start justify-between gap-6 border-b border-zinc-800 px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <h2 id="ssh-tunnel-dialog-title" className="text-lg font-semibold text-zinc-100">
                  SSH tunnel profiles
                </h2>
                <p id="ssh-tunnel-dialog-description" className="mt-1 text-sm leading-relaxed text-zinc-400">
                  Choose or create the bastion used for this {protocol === 's3' ? 'S3 endpoint' : 'SFTP server'}.
                </p>
              </div>
              <button
                type="button"
                onClick={editor ? cancelEditor : closeManager}
                disabled={saving}
                className="shrink-0 rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-gale-teal disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={editor ? 'Back to tunnel profiles' : 'Close SSH tunnel profiles'}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="galeon-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <div className="space-y-3">
          {!editor && (
            <>
              {legacyTunnel && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <p>This connection uses an older embedded tunnel. Pick or create a reusable profile below to separate it.</p>
                </div>
              )}

              <div
                role="radiogroup"
                aria-label="SSH tunnel route"
                className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!enabled}
                  onClick={chooseDirect}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gale-teal ${!enabled ? 'bg-gale-teal/10' : 'hover:bg-zinc-800/70'}`}
                >
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${!enabled ? 'border-gale-teal bg-gale-teal text-on-accent' : 'border-zinc-600 text-transparent'}`}>
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-zinc-100">Direct connection</span>
                    <span className="mt-0.5 block text-xs text-zinc-500">Do not use an SSH tunnel</span>
                  </span>
                </button>

                {legacyTunnel && (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!selectedProfileId}
                    onClick={keepLegacy}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gale-teal ${!selectedProfileId ? 'bg-gale-teal/10' : 'hover:bg-zinc-800/70'}`}
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${!selectedProfileId ? 'border-gale-teal bg-gale-teal text-on-accent' : 'border-zinc-600 text-transparent'}`}>
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                        Embedded tunnel
                        <span className="rounded-full bg-amber-950/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Legacy</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-zinc-500">{legacyTunnel.username}@{legacyTunnel.host}:{legacyTunnel.port}</span>
                    </span>
                  </button>
                )}

                {profiles.map((profile) => {
                  const active = profile.id === selectedProfileId;
                  return (
                    <div key={profile.id} className={`flex items-stretch ${active ? 'bg-gale-teal/10' : ''}`}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => chooseProfile(profile.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gale-teal hover:bg-zinc-800/70"
                      >
                        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${active ? 'border-gale-teal bg-gale-teal text-on-accent' : 'border-zinc-600 text-transparent'}`}>
                          <Check className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-zinc-100">{profile.name}</span>
                          <span className="mt-0.5 block truncate text-xs text-zinc-400">{profile.username}@{profile.host}:{profile.port}</span>
                          <span className="mt-1 flex items-center gap-1.5 truncate text-xs text-zinc-500">
                            {profile.hasSavedPassword ? <KeyRound className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : <Network className="h-3.5 w-3.5 shrink-0" />}
                            <span className="truncate">{profile.hasSavedPassword ? 'Password in OS keyring' : profile.keyPath ? `Key: ${profile.keyPath}` : 'Uses ssh-agent'}</span>
                          </span>
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-1 pr-3">
                        <button
                          type="button"
                          onClick={() => { setDeleteArmedId(null); setError(''); setEditor(draftFromProfile(profile)); }}
                          className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-gale-teal"
                          aria-label={`Edit ${profile.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteProfile(profile)}
                          className={`rounded-lg px-2 py-2 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 ${deleteArmedId === profile.id ? 'bg-red-950/60 font-medium text-red-200' : 'text-red-400/70 hover:bg-red-950/40 hover:text-red-300'}`}
                          aria-label={deleteArmedId === profile.id ? `Confirm delete ${profile.name}` : `Delete ${profile.name}`}
                        >
                          {deleteArmedId === profile.id ? 'Confirm' : <Trash2 className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => { setDeleteArmedId(null); setError(''); setEditor(emptyDraft()); }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-gale-teal"
              >
                <Plus className="h-4 w-4" />
                New profile
              </button>

              {loading && <p className="text-xs text-zinc-500" aria-live="polite">Refreshing tunnel profiles…</p>}
              {!loading && profiles.length === 0 && (
                <p className="text-sm leading-relaxed text-zinc-500">
                  No reusable tunnel profiles yet. Create one to share a bastion across storage connections.
                </p>
              )}
            </>
          )}

          {editor && (
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100">
                    {editingExistingProfile ? 'Edit tunnel profile' : 'New tunnel profile'}
                  </h3>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Tunnel credentials are separate from the storage connection credentials.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={cancelEditor}
                  className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-gale-teal"
                  aria-label="Cancel tunnel profile editor"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {!editingExistingProfile && (
                <>
                  <SshConfigImport mode="tunnel" onSelect={importSshConfigConnection} />

                  <div className="flex items-center gap-3 py-1 text-xs text-zinc-500" aria-hidden="true">
                    <span className="h-px flex-1 bg-zinc-800" />
                    <span>or enter manually</span>
                    <span className="h-px flex-1 bg-zinc-800" />
                  </div>
                </>
              )}

              <div>
                <label htmlFor="tunnel-profile-name" className="mb-1 block text-xs text-zinc-400">Profile name</label>
                <input
                  id="tunnel-profile-name"
                  value={editor.name}
                  onChange={(event) => updateEditor({ name: event.target.value })}
                  placeholder="Production bastion"
                  className={FIELD}
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
                <div>
                  <label htmlFor="tunnel-profile-host" className="mb-1 block text-xs text-zinc-400">SSH server</label>
                  <input
                    id="tunnel-profile-host"
                    value={editor.host}
                    onChange={(event) => updateEditor({ host: event.target.value })}
                    placeholder="bastion.example.com"
                    className={FIELD}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label htmlFor="tunnel-profile-port" className="mb-1 block text-xs text-zinc-400">Port</label>
                  <input
                    id="tunnel-profile-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={editor.port}
                    onChange={(event) => updateEditor({ port: Number(event.target.value) })}
                    className={FIELD}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="tunnel-profile-username" className="mb-1 block text-xs text-zinc-400">Username</label>
                <input
                  id="tunnel-profile-username"
                  value={editor.username}
                  onChange={(event) => updateEditor({ username: event.target.value })}
                  className={FIELD}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>

              <div>
                <label htmlFor="tunnel-profile-password" className="mb-1 block text-xs text-zinc-400">
                  Password {editor.hasSavedPassword && !editor.clearPassword && <span className="text-zinc-500">(leave blank to keep saved)</span>}
                </label>
                <input
                  id="tunnel-profile-password"
                  type="password"
                  value={editor.password}
                  onChange={(event) => updateEditor({ password: event.target.value, clearPassword: false })}
                  placeholder={editor.hasSavedPassword ? 'Saved in OS keyring' : 'Optional with key or ssh-agent'}
                  className={FIELD}
                  autoComplete="new-password"
                />
                {editor.hasSavedPassword && (
                  <label className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                    <input
                      type="checkbox"
                      checked={editor.clearPassword}
                      onChange={(event) => updateEditor({ clearPassword: event.target.checked, password: '' })}
                      className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-800 text-gale-teal focus:ring-gale-teal"
                    />
                    Clear saved password
                  </label>
                )}
              </div>

              <div>
                <label htmlFor="tunnel-profile-key" className="mb-1 block text-xs text-zinc-400">Private key path</label>
                <input
                  id="tunnel-profile-key"
                  value={editor.keyPath ?? ''}
                  onChange={(event) => updateEditor({ keyPath: event.target.value })}
                  placeholder="Optional; ssh-agent is used when blank"
                  className={FIELD}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={cancelEditor}
                  disabled={saving}
                  className="rounded-lg px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-gale-teal disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveProfile()}
                  disabled={saving}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-gale-teal px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-deep-current hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Save className="h-4 w-4" />
                  {saving ? 'Saving…' : 'Save profile'}
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs leading-relaxed text-red-300" role="alert">{error}</p>
          )}
          <p className="text-xs leading-relaxed text-zinc-500">
            A tunnel profile is a reusable SSH server for one or more storage connections. Its password is saved
            separately in the OS keyring. For security, Galeon only connects to SSH servers already trusted by your
            computer; the server fingerprint (host key) must be listed in ~/.ssh/known_hosts.
          </p>
              </div>
            </div>

            {!editor && (
              <footer className="flex justify-end border-t border-zinc-800 px-5 py-4 sm:px-6">
                <button
                  type="button"
                  onClick={closeManager}
                  disabled={saving}
                  className="rounded-lg bg-gale-teal px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-deep-current hover:text-white focus:outline-none focus:ring-2 focus:ring-gale-teal focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Done
                </button>
              </footer>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
