/**
 * Profile lifecycle for the connect screen.
 *
 * Selecting a saved profile, connecting it with the vault's secrets, and saving
 * the form back over it are one feature: they share the stale-action nonce, the
 * keychain slots, and the "this profile's protocol" rules. The form fields come
 * in as one object (`useConnectionForm`), so this hook owns profile state and the
 * screen keeps the fields, the connect path, and the JSX.
 */

import { useRef, useState, type MutableRefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ConnectionProfile, StorageProtocol } from '../../types';
import { DEFAULT_S3_ENDPOINT, DEFAULT_S3_REGION, defaultPortFor } from './defaults';
import { formatConnectError, hostOfEndpoint, isFileProtocol, isHttpProtocol } from './connect';
import { EMPTY_SSH_TUNNEL, sshTunnelFormFromProfile, sshTunnelForProfile } from '../sshTunnel';
import type { SshConfigConnection } from '../SshConfigImport';
import type { useConnectionForm } from './useConnectionForm';

/** What the screen reports to the shell once a session is open. */
export type ConnectHandler = (
  sessionId: string,
  bucket: string,
  profileId?: string,
  protocol?: StorageProtocol,
) => void;

export type ConnectionProfilesOptions = {
  /** The live form, owned by the screen and shared with its Connect button. */
  form: ReturnType<typeof useConnectionForm>;
  profiles: ConnectionProfile[];
  onSaveProfile: (
    profile: ConnectionProfile,
    password?: string | null,
    sshTunnelPassword?: string | null,
  ) => Promise<void>;
  onDeleteProfile: (profileId: string) => Promise<void>;
  onConnected: ConnectHandler;
  setError: (message: string) => void;
  setLoading: (loading: boolean) => void;
  /**
   * Shared with the form's Connect: a second in-flight connect opens a second
   * backend session and the first one leaks.
   */
  connectingRef: MutableRefObject<boolean>;
};

export function useConnectionProfiles({
  form,
  profiles,
  onSaveProfile,
  onDeleteProfile,
  onConnected,
  setError,
  setLoading,
  connectingRef,
}: ConnectionProfilesOptions) {
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
    sshTunnel, setSshTunnel,
    sshTunnelProfileId, setSshTunnelProfileId,
    host, setHost,
    port, setPort,
    username, setUsername,
    keyPath, setKeyPath,
    credentialPath, setCredentialPath,
    sftpPassword, setSftpPassword,
    setSshConfigNotice,
    resetFields,
  } = form;

  // A profile's secrets arrive from the keychain after the rest of its fields; the form
  // has to say so, otherwise it looks ready while the password box is still empty.
  const [credsLoading, setCredsLoading] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [editingProfile, setEditingProfile] = useState<ConnectionProfile | null>(null);
  // A double-click fires onClick twice before onDoubleClick, so up to three profile
  // handlers read the keychain concurrently. Only the last one started may write the
  // form; earlier continuations would otherwise land on top of it.
  const profileActionNonceRef = useRef(0);

  /**
   * Secrets for the pressed Connect, filling empty fields from the vault.
   *
   * Selecting a profile loads its secrets asynchronously, and the first keychain read
   * of a session can block for seconds behind a macOS approval prompt. Everything else
   * (host, port, username) lands instantly, so the form looks ready while the password
   * is still in flight — pressing Connect then sent an empty secret and failed with
   * "SFTP requires either an SSH key path or password". Re-read here so the press waits
   * for the vault instead of racing it.
   */
  const resolveSecretsForConnect = async (): Promise<{
    accessKey: string;
    secretKey: string;
    sftpPassword: string;
    sshTunnelPassword: string;
  }> => {
    const current = {
      accessKey,
      secretKey,
      sftpPassword,
      sshTunnelPassword: sshTunnel.password,
    };
    if (!selectedProfileId) return current;

    // The vault returns the same two slots for every protocol, so a profile's secret
    // only means what its *own* protocol says it means. Switching the dropdown does not
    // clear the selection, so without this guard an S3 profile's secret access key would
    // be read out of slot 1 and sent to an arbitrary host as an SFTP/FTP password.
    const selectedProfile = profiles.find((p) => p.id === selectedProfileId);
    if (!selectedProfile || (selectedProfile.protocol || 's3') !== protocol) return current;

    // Only fill genuinely empty fields: anything typed wins. A saved password remains
    // authoritative even when an older SFTP profile still carries a key path.
    const needsS3Keys = protocol === 's3' && (!accessKey.trim() || !secretKey.trim());
    const needsPassword = protocol !== 's3' && !sftpPassword;
    const needsTunnelPassword = sshTunnel.enabled && !sshTunnelProfileId && !sshTunnel.password;
    if (!needsS3Keys && !needsPassword && !needsTunnelPassword) return current;

    const nonce = ++profileActionNonceRef.current;
    setCredsLoading(true);
    try {
      const creds = needsS3Keys || needsPassword
        ? await invoke<[string | null, string | null]>('get_profile_credentials', {
            profileId: selectedProfileId,
          })
        : [null, null] as [null, null];
      const tunnelPassword = needsTunnelPassword
        ? await invoke<string | null>('get_profile_ssh_tunnel_password', {
            profileId: selectedProfileId,
          })
        : null;
      if (needsS3Keys) {
        if (!current.accessKey.trim() && creds[0]) {
          current.accessKey = creds[0];
          setAccessKey(creds[0]);
        }
        if (!current.secretKey.trim() && creds[1]) {
          current.secretKey = creds[1];
          setSecretKey(creds[1]);
        }
      } else if (creds[1]) {
        current.sftpPassword = creds[1];
        setSftpPassword(creds[1]);
      }
      if (tunnelPassword) {
        current.sshTunnelPassword = tunnelPassword;
        setSshTunnel((value) => ({ ...value, password: tunnelPassword }));
      }
    } catch (err) {
      // Keychain locked or denied — fall back to whatever the profile carries inline
      // (imported profiles may) before the validation below reports what is missing.
      console.error('Failed to load saved credentials for connect:', err);
      if (needsS3Keys) {
        if (!current.accessKey.trim() && selectedProfile.accessKey) {
          current.accessKey = selectedProfile.accessKey;
          setAccessKey(selectedProfile.accessKey);
        }
        if (!current.secretKey.trim() && selectedProfile.secretKey) {
          current.secretKey = selectedProfile.secretKey;
          setSecretKey(selectedProfile.secretKey);
        }
      }
    } finally {
      // A profile click started after this read owns the flag and is still waiting on
      // its own keychain call; clearing it here would flash a "missing auth" form.
      if (nonce === profileActionNonceRef.current) setCredsLoading(false);
    }
    return current;
  };

  const applyProfileTunnel = (profile: ConnectionProfile) => {
    const profileProtocol = profile.protocol || 's3';
    if (profileProtocol !== 's3' && profileProtocol !== 'sftp') {
      setSshTunnelProfileId(undefined);
      setSshTunnel({ ...EMPTY_SSH_TUNNEL });
      return;
    }
    setSshTunnelProfileId(profile.sshTunnelProfileId);
    setSshTunnel(sshTunnelFormFromProfile(profile.sshTunnel));
  };

  const handleSelectProfile = async (profile: ConnectionProfile) => {
    const nonce = ++profileActionNonceRef.current;
    const proto = profile.protocol || 's3';
    setSelectedProfileId(profile.id);
    setProfileName(profile.name);
    setProtocol(proto);
    setSshConfigNotice('');
    applyProfileTunnel(profile);

    // Everything the config carries fills in immediately…
    if (proto === 'sftp' || proto === 'ftp' || proto === 'ftps') {
      setHost(profile.host || '');
      setPort(profile.port || defaultPortFor(proto));
      setUsername(profile.username || '');
      setKeyPath(profile.keyPath || '');
      setSftpPassword('');
    } else if (isHttpProtocol(proto)) {
      // WebDAV / Azure / GCS: endpoint-first fields (Azure's container and
      // GCS's bucket ride the shared bucket state; Azure's account name the
      // shared username state).
      setEndpoint(profile.endpoint || '');
      setBucket(profile.bucket || '');
      setUsername(profile.username || '');
      setCredentialPath(profile.credentialPath || '');
      setSftpPassword('');
    } else if (proto === 's3') {
      setBucket(profile.bucket || '');
      setAccessKey('');
      setSecretKey('');
      setEndpoint(profile.endpoint || DEFAULT_S3_ENDPOINT);
      setRegion(profile.region || DEFAULT_S3_REGION);
      setDangerDisableSsl(profile.dangerDisableSslVerification || false);
      setUseVirtualHostStyle(profile.useVirtualHostStyle || false);
      setStorageClass(profile.storageClass || 'STANDARD');
      setMaxBandwidth(profile.maxBandwidth ? Math.round(profile.maxBandwidth / 1024) : '');
    }
    setBandwidthRules(profile.bandwidthRules ? [...profile.bandwidthRules] : []);

    // …but secrets live in the keychain, so they land later — the first read of a
    // session can sit behind a macOS approval prompt. Say so while it is in flight.
    setCredsLoading(true);
    let creds: [string | null, string | null] = [null, null];
    let tunnelPassword: string | null = null;
    let credsError: unknown = null;
    try {
      [creds, tunnelPassword] = await Promise.all([
        invoke<[string | null, string | null]>('get_profile_credentials', {
          profileId: profile.id,
        }),
        profile.sshTunnel && !profile.sshTunnelProfileId
          ? invoke<string | null>('get_profile_ssh_tunnel_password', { profileId: profile.id })
          : Promise.resolve(null),
      ]);
    } catch (err) {
      credsError = err;
      console.error('Failed to load profile credentials:', err);
    }

    // A newer selection (or a double-click connect) owns the form now; it also owns
    // the loading flag, so leave that to it.
    if (nonce !== profileActionNonceRef.current) return;
    setCredsLoading(false);

    if (credsError) {
      // Mirror the success path's inline fallback: an imported profile can carry its
      // own keys, and blanking the form over a locked keychain would break a connect
      // that used to work.
      const inlineAccess = proto === 's3' ? profile.accessKey ?? '' : '';
      const inlineSecret = proto === 's3' ? profile.secretKey ?? '' : '';
      if (proto === 's3') {
        setAccessKey(inlineAccess);
        setSecretKey(inlineSecret);
      }
      if (!inlineAccess || !inlineSecret) {
        setError('Could not read this profile’s saved credentials from the keychain. Enter them manually to connect.');
      }
      return;
    }

    if (proto === 's3') {
      setAccessKey(creds[0] ?? profile.accessKey ?? '');
      setSecretKey(creds[1] ?? profile.secretKey ?? '');
    } else if (creds[1]) {
      setSftpPassword(creds[1]);
    }
    if (tunnelPassword) {
      setSshTunnel((value) => ({ ...value, password: tunnelPassword }));
    }
  };

  /**
   * Row click. `detail > 1` is the second click of a double-click — the double-click
   * handler owns that one, so skip a redundant keychain read and form rewrite.
   */
  const handleProfileRowClick = (profile: ConnectionProfile) => (e: React.MouseEvent) => {
    if (e.detail > 1) return;
    handleSelectProfile(profile);
  };

  /** Double-click connect: fill the form, then connect with the vault secrets read in-flight. */
  const handleDoubleClickProfile = async (profile: ConnectionProfile) => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    const nonce = ++profileActionNonceRef.current;
    setError('');
    setSshConfigNotice('');
    setLoading(true);
    try {
      const proto = profile.protocol || 's3';
      // Fall back to whatever the profile carries, mirroring doConnectProfile in App.tsx.
      let access: string | null = proto === 's3' ? profile.accessKey ?? null : null;
      let secretKeyVal: string | null = proto === 's3' ? profile.secretKey ?? null : null;
      let password: string | null = null;
      let tunnelPassword: string | null = profile.sshTunnel?.password ?? null;
      let vaultError: unknown = null;
      try {
        const [creds, savedTunnelPassword] = await Promise.all([
          invoke<[string | null, string | null]>('get_profile_credentials', {
            profileId: profile.id,
          }),
          profile.sshTunnel && !profile.sshTunnelProfileId
            ? invoke<string | null>('get_profile_ssh_tunnel_password', { profileId: profile.id })
            : Promise.resolve(null),
        ]);
        if (proto === 's3') {
          access = creds[0] ?? access;
          secretKeyVal = creds[1] ?? secretKeyVal;
        } else {
          password = creds[1];
        }
        tunnelPassword = savedTunnelPassword ?? tunnelPassword;
      } catch (err) {
        // Keychain locked or access denied — reported below rather than swallowed.
        vaultError = err;
        console.error('Failed to load profile credentials:', err);
      }

      // Populate the form for visibility / edit-on-failure (state not used for this invoke),
      // unless a newer selection has taken the form over in the meantime.
      if (nonce === profileActionNonceRef.current) {
        setSelectedProfileId(profile.id);
        setProfileName(profile.name);
        setProtocol(proto);
        applyProfileTunnel(profile);
        if (tunnelPassword) {
          setSshTunnel((value) => ({ ...value, password: tunnelPassword ?? '' }));
        }
        if (proto === 's3') {
          setBucket(profile.bucket || '');
          setAccessKey(access || '');
          setSecretKey(secretKeyVal || '');
          setEndpoint(profile.endpoint || DEFAULT_S3_ENDPOINT);
          setRegion(profile.region || DEFAULT_S3_REGION);
          setDangerDisableSsl(profile.dangerDisableSslVerification || false);
          setUseVirtualHostStyle(profile.useVirtualHostStyle || false);
          setStorageClass(profile.storageClass || 'STANDARD');
          setMaxBandwidth(profile.maxBandwidth ? Math.round(profile.maxBandwidth / 1024) : '');
        } else if (isHttpProtocol(proto)) {
          setEndpoint(profile.endpoint || '');
          setBucket(profile.bucket || '');
          setUsername(profile.username || '');
          setCredentialPath(profile.credentialPath || '');
          setSftpPassword(password || '');
        } else {
          setHost(profile.host || '');
          setPort(profile.port || defaultPortFor(proto));
          setUsername(profile.username || '');
          setKeyPath(profile.keyPath || '');
          setSftpPassword(password || '');
        }
        setBandwidthRules(profile.bandwidthRules ? [...profile.bandwidthRules] : []);
      }

      // A vault miss resolves as [null, null] rather than throwing, so missing keys have
      // to be checked explicitly — otherwise connect_storage fails with a raw backend
      // message instead of the same guidance handleConnect gives.
      if (proto === 's3' && (!access || !secretKeyVal)) {
        setError(
          vaultError
            ? 'Could not read this profile’s saved credentials. Enter Access Key ID and Secret Access Key, then press Connect.'
            : 'No saved credentials for this profile. Enter Access Key ID and Secret Access Key, then press Connect.'
        );
        return;
      }
      // FTP/FTPS omitted: anonymous login is valid there (see handleConnect).
      if (proto === 'sftp' && !password && !profile.keyPath) {
        setError(
          vaultError
            ? 'Could not read this profile’s saved password. Enter it below, then press Connect.'
            : 'No saved password for this profile. Enter a password or an SSH key path, then press Connect.'
        );
        return;
      }
      // Azure requires the account key; GCS needs the JSON file or a paste.
      if (proto === 'azure' && !password) {
        setError('No saved account key for this profile. Enter the Azure account key, then press Connect.');
        return;
      }
      if (proto === 'gcs' && !profile.credentialPath && !password) {
        setError('This GCS profile has no service account JSON. Choose a file or paste its contents, then press Connect.');
        return;
      }

      const isFile = isFileProtocol(proto);
      const isHttp = isHttpProtocol(proto);

      const connectProfile = {
        id: profile.id,
        name: profile.name,
        protocol: proto,
        endpoint: (proto === 's3' || isHttp) ? (profile.endpoint || null) : null,
        region: proto === 's3' ? (profile.region || null) : null,
        accessKey: proto === 's3' ? access : null,
        secretKey: proto === 's3' ? secretKeyVal : null,
        bucket: (proto === 's3' || proto === 'azure' || proto === 'gcs') ? (profile.bucket || null) : null,
        dangerDisableSslVerification: proto === 's3' ? (profile.dangerDisableSslVerification || null) : null,
        useVirtualHostStyle: proto === 's3' ? (profile.useVirtualHostStyle || null) : null,
        storageClass: proto === 's3' ? (profile.storageClass || null) : null,
        maxBandwidth: profile.maxBandwidth ?? null,
        bandwidthRules: profile.bandwidthRules ?? null,
        host: isFile ? (profile.host || null) : null,
        port: isFile ? (profile.port ?? null) : null,
        username: (isFile || proto === 'webdav' || proto === 'azure') ? (profile.username || null) : null,
        keyPath: proto === 'sftp' ? (profile.keyPath || null) : null,
        credentialPath: proto === 'gcs' ? (profile.credentialPath || null) : null,
        sshTunnel: profile.sshTunnel ?? null,
        sshTunnelProfileId: profile.sshTunnelProfileId ?? null,
      };

      // GCS with a credential path ignores the keyring slot (file wins).
      const connectPassword = proto === 's3' || (proto === 'gcs' && profile.credentialPath)
        ? null
        : password;

      const sessionId = await invoke<string>('connect_storage', {
        profile: connectProfile,
        password: connectPassword,
        sshTunnelPassword: tunnelPassword,
      });
      const displayName =
        proto === 's3'
          ? (profile.bucket || profile.name)
          : isFile
            ? `${profile.username || ''}@${profile.host || ''}`
            : profile.username
              ? `${profile.username}@${hostOfEndpoint(profile.endpoint || '')}`
              : hostOfEndpoint(profile.endpoint || '') || profile.name;
      onConnected(sessionId, displayName, profile.id, proto);
    } catch (err: unknown) {
      setError(formatConnectError(err));
    } finally {
      connectingRef.current = false;
      setLoading(false);
      // This handler may have superseded an in-flight selection that owned the flag —
      // but only while it is still the latest action. A profile clicked after this
      // connect started owns the flag itself and is still waiting on its own read.
      if (nonce === profileActionNonceRef.current) setCredsLoading(false);
    }
  };

  /**
   * One profile builder for both save paths (dialog + disk icon). `base` is the
   * existing profile being saved over (the disk-icon path keeps unknown fields);
   * a fresh dialog save builds every field from the form.
   */
  const buildProfileFromForm = (base?: ConnectionProfile): ConnectionProfile => {
    const isFile = isFileProtocol(protocol);
    const isHttp = isHttpProtocol(protocol);
    return {
      ...base,
      id: base?.id ?? (editingProfile?.id || crypto.randomUUID()),
      name: base?.name ?? profileName.trim(),
      protocol,
      // S3 + WebDAV/Azure/GCS share the endpoint field. Azure's container and
      // GCS's bucket ride `bucket`; Azure's account name rides `username`; GCS's
      // service-account JSON path is the one field only it uses.
      endpoint: (protocol === 's3' || isHttp) ? (endpoint || undefined) : undefined,
      region: protocol === 's3' ? (region || undefined) : undefined,
      accessKey: protocol === 's3' ? (accessKey || undefined) : undefined,
      secretKey: protocol === 's3' ? (secretKey || undefined) : undefined,
      bucket: (protocol === 's3' || protocol === 'azure' || protocol === 'gcs') ? bucket : undefined,
      dangerDisableSslVerification: protocol === 's3' ? (dangerDisableSsl || undefined) : undefined,
      useVirtualHostStyle: protocol === 's3' ? (useVirtualHostStyle || undefined) : undefined,
      storageClass: protocol === 's3' ? (storageClass || undefined) : undefined,
      maxBandwidth: protocol === 's3' ? (maxBandwidth ? maxBandwidth * 1024 : undefined) : undefined,
      bandwidthRules: bandwidthRules.length > 0 ? bandwidthRules : undefined,
      // SFTP/FTP fields
      host: isFile ? host : undefined,
      port: isFile ? port : undefined,
      username: (isFile || protocol === 'webdav' || protocol === 'azure') ? username : undefined,
      keyPath: protocol === 'sftp' ? (keyPath || undefined) : undefined,
      credentialPath: protocol === 'gcs' ? (credentialPath || undefined) : undefined,
      sshTunnel: sshTunnelProfileId ? undefined : sshTunnelForProfile(sshTunnel, protocol),
      sshTunnelProfileId,
    };
  };

  /** The secret handed to the keyring for the active protocol (S3 sends keys in-band). */
  const formSecret = (): string | null => {
    if (protocol === 's3') return null;
    // A GCS credential file on disk wins over a pasted JSON (backend agrees).
    if (protocol === 'gcs' && credentialPath.trim()) return null;
    return sftpPassword || null;
  };

  const handleSaveProfile = async () => {
    if (!profileName.trim()) return;

    // Reject duplicate profile names (case-insensitive, exclude self on update)
    const name = profileName.trim().toLowerCase();
    const clash = profiles.some(
      (p) => p.name.toLowerCase() === name && p.id !== (editingProfile?.id ?? selectedProfileId)
    );
    if (clash) {
      setError('A profile with that name already exists.');
      return;
    }

    const profile = buildProfileFromForm();
    await onSaveProfile(profile, formSecret(), sshTunnel.password || null);
    setShowSaveModal(false);
    setProfileName('');
    setEditingProfile(null);
    setSelectedProfileId(profile.id);
  };

  const handleEditProfile = (profile: ConnectionProfile) => {
    setEditingProfile(profile);
    setProfileName(profile.name);
    setShowSaveModal(true);
  };

  // Save current field values directly back to the selected profile (disk icon).
  // This is the "save content" action for an existing (or just-named) profile.
  // Does not prompt for name (use sidebar + for creating a new named profile).
  const handleSaveButton = async () => {
    if (!selectedProfileId) return;
    const selected = profiles.find((p) => p.id === selectedProfileId);
    if (!selected) return;

    const profile = buildProfileFromForm(selected);
    await onSaveProfile(profile, formSecret(), sshTunnel.password || null);
  };

  const handleSaveAsNewProfile = () => {
    setEditingProfile(null);
    setProfileName('');
    setShowSaveModal(true);
  };

  const handleDeleteProfile = async (profileId: string) => {
    await onDeleteProfile(profileId);
    if (selectedProfileId === profileId) {
      setSelectedProfileId(null);
    }
  };

  /** Full reset to defaults so Connect/Save cannot clobber imports with stale fields. */
  const resetFormToDefaults = () => {
    ++profileActionNonceRef.current;
    setCredsLoading(false);
    setError('');
    setSelectedProfileId(null);
    setProfileName('');
    setEditingProfile(null);
    resetFields();
  };

  const handleSshConfigSelect = (connection: SshConfigConnection) => {
    ++profileActionNonceRef.current;
    setSelectedProfileId(null);
    setEditingProfile(null);
    setProfileName(connection.alias);
    setProtocol('sftp');
    setHost(connection.host);
    setPort(connection.port);
    setUsername(connection.username || '');
    setKeyPath(connection.keyPath || '');
    setSftpPassword('');
    setBandwidthRules([]);
    setSshTunnel({ ...EMPTY_SSH_TUNNEL });
    setSshTunnelProfileId(undefined);
    setCredsLoading(false);
    setError('');

    if (connection.proxyJump) {
      setSshConfigNotice(
        `Imported ${connection.alias}, but ProxyJump ${connection.proxyJump} is not automatic. Use Set up under SSH tunnel before connecting.`
      );
    } else if (!connection.keyPath) {
      setSshConfigNotice(
        `Imported ${connection.alias}. This entry has no usable IdentityFile, so enter a password or SSH key path.`
      );
    } else {
      setSshConfigNotice(`Imported ${connection.alias} from ~/.ssh/config.`);
    }
  };

  const handleClearCredentials = () => {
    setSshConfigNotice('');
    if (protocol === 's3') {
      setBucket('');
      setAccessKey('');
      setSecretKey('');
    } else {
      setHost('');
      setUsername('');
      setSftpPassword('');
    }
  };

  /** Close the save dialog without saving: the form keeps what the user typed. */
  const closeSaveModal = () => {
    setShowSaveModal(false);
    setProfileName('');
    setEditingProfile(null);
  };

  return {
    selectedProfileId,
    credsLoading,
    showSaveModal,
    profileName,
    setProfileName,
    editingProfile,
    closeSaveModal,
    resolveSecretsForConnect,
    handleProfileRowClick,
    handleDoubleClickProfile,
    handleSaveProfile,
    handleEditProfile,
    handleSaveButton,
    handleSaveAsNewProfile,
    handleDeleteProfile,
    resetFormToDefaults,
    handleSshConfigSelect,
    handleClearCredentials,
  };
}
