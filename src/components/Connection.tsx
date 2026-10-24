import { X as CloseIcon } from 'lucide-react';
import { ChevronRight } from 'lucide-react';
import { Select } from './Select';
import { DEFAULT_SFTP_PORT, DEFAULT_FTP_PORT, defaultPortFor } from './connection/defaults';
import { ProfileSidebar } from './connection/ProfileSidebar';
import { SaveProfileDialog } from './connection/SaveProfileDialog';
import { OverwriteProfileDialog } from './connection/OverwriteProfileDialog';
import { BandwidthRulesEditor, useBandwidthRuleDraft } from './connection/BandwidthRulesEditor';
import { FIELD } from './connection/field';
import { ProtocolFields } from './connection/ProtocolFields';
import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { ConnectionProfile, StorageProtocol } from '../types';
import { OnboardingProtocol } from './OnboardingWizard';
import { useConnectionForm } from './connection/useConnectionForm';
import {
  EMPTY_SSH_TUNNEL,
  sshTunnelForProfile,
  validateSshTunnelDestination,
} from './sshTunnel';
import { SshTunnelProfiles } from './SshTunnelProfiles';
import { Settings, LockKeyhole } from 'lucide-react';
import { ConnectionActions } from './connection/ConnectionActions';
import { useConnectionProfiles } from './connection/useConnectionProfiles';
import {
  formatConnectError,
  hostOfEndpoint,
  isFileProtocol,
  isHttpProtocol,
  profileEndpointLabel,
} from './connection/connect';

interface ConnectionProps {
  onConnected: (sessionId: string, bucket: string, profileId?: string, protocol?: StorageProtocol) => void;
  profiles: ConnectionProfile[];
  onSaveProfile: (
    profile: ConnectionProfile,
    password?: string | null,
    sshTunnelPassword?: string | null,
  ) => Promise<void>;
  onDeleteProfile: (profileId: string) => Promise<void>;
  onReloadProfiles?: () => Promise<void>;
  initialProtocol?: OnboardingProtocol;
  onOpenSettings?: () => void;
}

export const Connection: React.FC<ConnectionProps> = ({
  onConnected,
  profiles,
  onSaveProfile,
  onDeleteProfile,
  onReloadProfiles,
  initialProtocol,
  onOpenSettings,
}) => {
  const form = useConnectionForm();
  const {
    protocol, setProtocol,
    bucket, setBucket,
    accessKey, setAccessKey,
    secretKey, setSecretKey,
    endpoint, setEndpoint,
    region, setRegion,
    dangerDisableSsl, setDangerDisableSsl,
    useVirtualHostStyle, setUseVirtualHostStyle,
    storageClass, setStorageClass,
    maxBandwidth, setMaxBandwidth,
    bandwidthRules, setBandwidthRules,
    showAdvanced, setShowAdvanced,
    showBandwidthAdvanced, setShowBandwidthAdvanced,
    sshTunnel, setSshTunnel,
    sshTunnelProfileId, setSshTunnelProfileId,
    host, setHost,
    port, setPort,
    username, setUsername,
    keyPath, setKeyPath,
    credentialPath, setCredentialPath,
    sftpPassword, setSftpPassword,
    showSshHelper, setShowSshHelper,
    sshConfigNotice, setSshConfigNotice,
  } = form;
  const bandwidthDraft = useBandwidthRuleDraft();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // Guards the double-click connect itself: a second in-flight connect_storage opens a
  // second backend session, and only the last sessionId is kept — the first leaks.
  const connectingRef = useRef(false);

  // Profile select / connect / save / delete is its own feature: it reads the
  // keychain and the profiles list, and the screen only wires it to the JSX.
  const {
    selectedProfileId, credsLoading, showSaveModal, profileName, setProfileName,
    editingProfile, closeSaveModal, resolveSecretsForConnect, handleProfileRowClick,
    handleDoubleClickProfile, handleSaveProfile, handleEditProfile, handleSaveButton,
    handleSaveAsNewProfile, finalizeConnect, overwritePrompt, respondOverwritePrompt,
    handleDeleteProfile, resetFormToDefaults,
    handleSshConfigSelect, handleClearCredentials,
  } = useConnectionProfiles({
    form,
    profiles,
    onSaveProfile,
    onDeleteProfile,
    onConnected,
    setError,
    setLoading,
    connectingRef,
  });
  

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  useEffect(() => {
    if (!initialProtocol) return;
    setProtocol(initialProtocol);
    if (initialProtocol !== 's3' && !isHttpProtocol(initialProtocol)) {
      setPort(defaultPortFor(initialProtocol));
    }
    if (initialProtocol !== 's3' && initialProtocol !== 'sftp') {
      setSshTunnel({ ...EMPTY_SSH_TUNNEL });
      setSshTunnelProfileId(undefined);
    }
  }, [initialProtocol]);


  const handleConnect = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (connectingRef.current) return;
    connectingRef.current = true;
    setError('');
    setLoading(true);
    try {
      const resolved = await resolveSecretsForConnect();

      // Client-side checks before spinning — friends get clear “what’s missing” copy.
      if (protocol === 's3') {
        if (!bucket.trim()) {
          setError('Enter a bucket name.');
          return;
        }
        if (!resolved.accessKey.trim() || !resolved.secretKey.trim()) {
          setError('Enter Access Key ID and Secret Access Key.');
          return;
        }
      } else if (isFileProtocol(protocol)) {
        if (!host.trim()) {
          setError('Enter a host name or IP address.');
          return;
        }
        if (!username.trim()) {
          setError('Enter a username.');
          return;
        }
        // Only SFTP genuinely requires a secret. FTP/FTPS may be anonymous — the
        // backend logs in with an empty credential, and the key-path input is not
        // even rendered for those protocols, so demanding one is unsatisfiable.
        if (protocol === 'sftp' && !resolved.sftpPassword && !keyPath.trim()) {
          setError('Enter a password or an SSH private key path.');
          return;
        }
      } else if (protocol === 'webdav') {
        if (!endpoint.trim()) {
          setError('Enter the WebDAV server URL (e.g. https://cloud.example.com/remote.php/dav).');
          return;
        }
      } else if (protocol === 'azure') {
        if (!username.trim()) {
          setError('Enter the Azure storage account name.');
          return;
        }
        if (!bucket.trim()) {
          setError('Enter the Azure container name.');
          return;
        }
        if (!resolved.sftpPassword.trim()) {
          setError('Enter the Azure account key.');
          return;
        }
      } else if (protocol === 'gcs') {
        if (!bucket.trim()) {
          setError('Enter the GCS bucket name.');
          return;
        }
        // A credential file or pasted JSON — one of the two is required.
        if (!credentialPath.trim() && !resolved.sftpPassword.trim()) {
          setError('Choose a service account JSON file, or paste its contents.');
          return;
        }
      }

      const tunnelError = validateSshTunnelDestination(
        Boolean(sshTunnelProfileId || sshTunnel.enabled),
        protocol,
        endpoint,
        dangerDisableSsl,
        useVirtualHostStyle,
      );
      if (tunnelError) {
        setError(tunnelError);
        return;
      }

      // Trim paste junk (spaces/newlines) — a common cause of "invalid uri character"
      // when someone else fills the form after receiving a DMG.
      const trimmedEndpoint = endpoint.trim();
      const trimmedRegion = region.trim();
      const trimmedAccessKey = resolved.accessKey.trim();
      const trimmedSecretKey = resolved.secretKey.trim();
      const trimmedBucket = bucket.trim();
      const trimmedHost = host.trim();
      const trimmedUsername = username.trim();
      const trimmedKeyPath = keyPath.trim();

      const isFile = isFileProtocol(protocol);
      const isHttp = isHttpProtocol(protocol);
      const trimmedCredentialPath = credentialPath.trim();

      const profile = {
        id: selectedProfileId || crypto.randomUUID(),
        name: profileName || 'Quick Connect',
        protocol,
        // S3 + WebDAV/Azure/GCS share the endpoint field
        endpoint: (protocol === 's3' || isHttp) ? (trimmedEndpoint || null) : null,
        region: protocol === 's3' ? (trimmedRegion || null) : null,
        accessKey: protocol === 's3' ? (trimmedAccessKey || null) : null,
        secretKey: protocol === 's3' ? (trimmedSecretKey || null) : null,
        bucket: (protocol === 's3' || protocol === 'azure' || protocol === 'gcs') ? trimmedBucket : null,
        dangerDisableSslVerification: protocol === 's3' ? (dangerDisableSsl || null) : null,
        useVirtualHostStyle: protocol === 's3' ? (useVirtualHostStyle || null) : null,
        storageClass: protocol === 's3' ? (storageClass || null) : null,
        maxBandwidth: maxBandwidth ? maxBandwidth * 1024 : null,
        bandwidthRules: bandwidthRules.length > 0 ? bandwidthRules : null,
        // SFTP/FTP fields
        host: isFile ? trimmedHost : null,
        port: isFile ? port : null,
        username: (isFile || protocol === 'webdav' || protocol === 'azure') ? trimmedUsername : null,
        keyPath: protocol === 'sftp' ? (trimmedKeyPath || null) : null,
        credentialPath: protocol === 'gcs' ? (trimmedCredentialPath || null) : null,
        sshTunnel: sshTunnelProfileId ? null : sshTunnelForProfile(sshTunnel, protocol) ?? null,
        sshTunnelProfileId: sshTunnelProfileId ?? null,
      };

      // GCS prefers the credential file; a stored paste must not shadow it (the
      // backend enforces the same precedence).
      const secret = protocol === 's3' || (protocol === 'gcs' && trimmedCredentialPath)
        ? null
        : resolved.sftpPassword || null;

      const sessionId = await invoke<string>('connect_storage', {
        profile,
        password: secret,
        sshTunnelPassword: resolved.sshTunnelPassword || null,
      });

      const displayName = protocol === 's3'
        ? trimmedBucket
        : isFile
          ? `${trimmedUsername}@${trimmedHost}`
          : trimmedUsername
            ? `${trimmedUsername}@${hostOfEndpoint(trimmedEndpoint)}`
            : hostOfEndpoint(trimmedEndpoint);
      // An unsaved form (no profile selected) becomes a profile with a random
      // name; a selected profile that the form changed asks whether to
      // overwrite it. Both happen only after the backend accepted, so failed
      // attempts do not litter the sidebar or rewrite anything.
      const savedProfileId = await finalizeConnect(resolved);

      // The selected (or just saved) profile travels with the session so
      // the transfer queue can record which saved profile a transfer belongs to
      onConnected(sessionId, displayName, savedProfileId, protocol);
    } catch (err: unknown) {
      setError(formatConnectError(err));
    } finally {
      connectingRef.current = false;
      setLoading(false);
    }
  };




  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      <ProfileSidebar
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        appVersion={appVersion}
        profileEndpointLabel={profileEndpointLabel}
        onRowClick={handleProfileRowClick}
        onRowDoubleClick={handleDoubleClickProfile}
        onEdit={handleEditProfile}
        onDelete={handleDeleteProfile}
        onReloadProfiles={onReloadProfiles}
        onImportComplete={resetFormToDefaults}
        onNewConnection={resetFormToDefaults}
      />

      {/* Right Panel - Connection Form */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div
          data-tauri-drag-region
          className="app-titlebar justify-between gap-2 px-5 border-b border-zinc-800 bg-zinc-950"
        >
          <span data-tauri-drag-region className="text-xs text-zinc-500">Connections</span>
          {onOpenSettings && (
            <button
              type="button"
              data-no-drag
              onClick={onOpenSettings}
              className="ui-button ui-button-ghost"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>Settings</span>
            </button>
          )}
        </div>
        <div className="connection-scroll galeon-scrollbar">
        <div className="connection-content">
          <header className="connection-heading">
            <h1>{profiles.find(profile => profile.id === selectedProfileId)?.name || 'New connection'}</h1>
            <p>Connect to a bucket or remote server to browse and transfer files.</p>
          </header>
          {error && (
            <div ref={errorRef} role="alert" className="p-3 mb-4 text-sm bg-status-danger/10 border border-status-danger/30 text-status-danger rounded-lg flex items-start justify-between gap-3">
              <span className="min-w-0 break-words">{error}</span>
              <button
                type="button"
                onClick={() => setError('')}
                className="shrink-0 text-status-danger hover:text-status-danger text-lg leading-none"
                aria-label="Dismiss error"
              >
                <CloseIcon size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          <form id="connection-form" onSubmit={handleConnect} className="connection-form space-y-4" aria-label="Connection details" aria-busy={loading}>
            {/* Protocol Selector */}
            <div>
              <label htmlFor="connection-protocol" className="connection-label">
                Protocol
              </label>
              <Select
                id="connection-protocol"
                value={protocol}
                onValueChange={(value) => {
                  const newProto = value as StorageProtocol;
                  const currentPort = port;
                  setProtocol(newProto);
                  setSshConfigNotice('');
                  if (newProto !== 's3' && newProto !== 'sftp' && !isHttpProtocol(newProto)) {
                    // FTP data channels cannot use this single-port SSH forwarding path.
                    // Clear the hidden choice so it cannot leak into a saved FTP/FTPS profile.
                    setSshTunnel({ ...EMPTY_SSH_TUNNEL });
                    setSshTunnelProfileId(undefined);
                  }

                  // Apply the new protocol's default port when switching, but only
                  // override a port that still looks like some protocol's default —
                  // a hand-typed port belongs to the user. Endpoint-URL protocols
                  // (webdav/azure/gcs) show no port field at all.
                  if (newProto !== 's3' && !isHttpProtocol(newProto)) {
                    const isUntouched =
                      !currentPort ||
                      currentPort === DEFAULT_SFTP_PORT ||
                      currentPort === DEFAULT_FTP_PORT;
                    if (isUntouched) setPort(defaultPortFor(newProto));
                  }
                }}
                className={FIELD}
              >
                <option value="s3">S3 Compatible</option>
                <option value="sftp">SFTP / SSH</option>
                <option value="ftp">FTP</option>
                <option value="ftps">FTPS (FTP over TLS)</option>
                <option value="webdav">WebDAV</option>
                <option value="azure">Azure Blob</option>
                <option value="gcs">Google Cloud Storage</option>
              </Select>
            </div>
            
            <ProtocolFields
              protocol={protocol}
              s3={{ bucket, setBucket, accessKey, setAccessKey, secretKey, setSecretKey, endpoint, setEndpoint, region, setRegion, dangerDisableSsl, setDangerDisableSsl, showAdvanced, setShowAdvanced, useVirtualHostStyle, setUseVirtualHostStyle, storageClass, setStorageClass, maxBandwidth, setMaxBandwidth, bandwidthRules: <BandwidthRulesEditor bandwidthRules={bandwidthRules} setBandwidthRules={setBandwidthRules} setError={setError} draft={bandwidthDraft} /> }}
              remote={{ host, setHost, port, setPort, username, setUsername, sftpPassword, setSftpPassword }}
              ssh={{ keyPath, setKeyPath, showSshHelper, setShowSshHelper, sshConfigNotice, credsLoading, handleSshConfigSelect }}
              webdav={{ endpoint, setEndpoint, username, setUsername, sftpPassword, setSftpPassword }}
              azure={{ endpoint, setEndpoint, bucket, setBucket, username, setUsername, sftpPassword, setSftpPassword }}
              gcs={{ endpoint, setEndpoint, bucket, setBucket, credentialPath, setCredentialPath, sftpPassword, setSftpPassword }}
            />

            {(protocol === 's3' || protocol === 'sftp') && (
              <SshTunnelProfiles
                selectedProfileId={sshTunnelProfileId}
                onChange={setSshTunnelProfileId}
                protocol={protocol}
                legacyTunnel={sshTunnel.enabled ? sshTunnelForProfile(sshTunnel, protocol) : undefined}
                onClearLegacy={() => setSshTunnel({ ...EMPTY_SSH_TUNNEL })}
              />
            )}

            {(protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') && (
              <>
                <button
                  type="button"
                  onClick={() => setShowBandwidthAdvanced(!showBandwidthAdvanced)}
                  aria-expanded={showBandwidthAdvanced}
                  className="flex items-center space-x-2 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  <ChevronRight size={14} aria-hidden="true" className={`shrink-0 transition-transform ${showBandwidthAdvanced ? 'rotate-90' : ''}`} />
                  <span>Advanced Bandwidth Rules</span>
                </button>
                {showBandwidthAdvanced && (
                  <div className="p-4 bg-zinc-800/50 rounded-lg border border-zinc-700">
                    {<BandwidthRulesEditor bandwidthRules={bandwidthRules} setBandwidthRules={setBandwidthRules} setError={setError} draft={bandwidthDraft} />}
                  </div>
                )}
              </>
            )}
            
            {credsLoading && !loading && (
              <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-gale-teal animate-pulse" />
                Loading saved credentials from the keychain…
              </p>
            )}
            <p className="connection-keychain-note">
              <LockKeyhole size={13} aria-hidden="true" /> Saved credentials are stored in your OS keychain.
            </p>
          </form>
        </div>
        </div>
        <ConnectionActions
          loading={loading}
          credsLoading={credsLoading}
          hasProfile={!!selectedProfileId}
          canSave={!!(protocol === 's3' ? bucket : protocol === 'webdav' ? endpoint : protocol === 'azure' || protocol === 'gcs' ? bucket : host)}
          onSave={handleSaveButton}
          onSaveAsNew={handleSaveAsNewProfile}
          onClear={handleClearCredentials}
        />
      </div>

      {showSaveModal && (
        <SaveProfileDialog
          editingProfile={!!editingProfile}
          profileName={profileName}
          setProfileName={setProfileName}
          handleSaveProfile={handleSaveProfile}
          onCancel={closeSaveModal}
        />
      )}

      {overwritePrompt && (
        <OverwriteProfileDialog
          profileName={overwritePrompt.profileName}
          onOverwrite={() => respondOverwritePrompt(true)}
          onSkip={() => respondOverwritePrompt(false)}
        />
      )}

    </div>
  );
};
