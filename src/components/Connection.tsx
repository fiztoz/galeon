import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { ConnectionProfile, BandwidthRule } from '../types';
import { OnboardingProtocol } from './OnboardingWizard';
import { SshKeyHelper } from './SshKeyHelper';
import { ProfileImportExport } from './ProfileImportExport';
import {
  EMPTY_SSH_TUNNEL,
  sshTunnelFormFromProfile,
  sshTunnelForProfile,
  SshTunnelFormValue,
  validateSshTunnelDestination,
} from './sshTunnel';
import { SshTunnelProfiles } from './SshTunnelProfiles';
import { SshConfigConnection, SshConfigImport } from './SshConfigImport';
import { Server, Trash2, Pencil, Plus, Save, Database, Key, AlertTriangle, Settings, Eraser } from 'lucide-react';

// Neutral defaults for friend installs (no org-specific endpoints baked in).
const DEFAULT_S3_ENDPOINT = '';
const DEFAULT_S3_REGION = '';
const DEFAULT_SFTP_PORT = 22;
const DEFAULT_FTP_PORT = 21;
// FTPS here is *explicit* FTPS (AUTH TLS): `ftp_native::FtpSession::connect` opens a
// plaintext control channel and upgrades it with `into_secure`, which is the port-21
// flow. Implicit FTPS on 990 expects a TLS handshake immediately and never sends a
// plaintext banner, so defaulting to it fails before login.
const DEFAULT_FTPS_PORT = DEFAULT_FTP_PORT;

/**
 * Default port per protocol. Must stay in sync with the backend fallback in
 * `connect_storage` (src-tauri/src/lib.rs), otherwise the form shows one port
 * while an unset profile actually connects on another.
 */
const defaultPortFor = (proto: string): number => {
  if (proto === 'sftp') return DEFAULT_SFTP_PORT;
  if (proto === 'ftps') return DEFAULT_FTPS_PORT;
  return DEFAULT_FTP_PORT;
};

const FIELD =
  'w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all placeholder:text-zinc-500';

/** Friend-readable connect errors (strip noisy Rust/Tauri wrappers when present). */
const formatConnectError = (err: unknown): string => {
  let msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  msg = msg.replace(/^Error:\s*/i, '').trim();
  if (msg.length > 280) msg = msg.slice(0, 277) + '…';
  return msg || 'Connection failed. Check host, credentials, and network.';
};

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Safe hostname display for sidebar subtitles (invalid endpoints must not crash render). */
const profileEndpointLabel = (endpoint?: string, bucket?: string) => {
  let host = 'AWS S3';
  if (endpoint) {
    try {
      host = new URL(endpoint).hostname || endpoint;
    } catch {
      host = endpoint;
    }
  }
  return `${bucket || '—'} • ${host}`;
};

const formatRuleDays = (days: number[]) => {
  if (days.length === 0) return 'No days';
  if (days.length === 7) return 'Every day';
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.map((d) => DAY_LABELS[d] ?? '?').join(', ');
};

const formatRuleLimit = (limitKbps: number) =>
  limitKbps === 0 ? 'Unlimited' : `${limitKbps} KB/s`;

interface ConnectionProps {
  onConnected: (sessionId: string, bucket: string, profileId?: string, protocol?: 's3' | 'sftp' | 'ftp' | 'ftps') => void;
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
  const [protocol, setProtocol] = useState<'s3' | 'sftp' | 'ftp' | 'ftps'>('s3');
  const [bucket, setBucket] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [endpoint, setEndpoint] = useState(DEFAULT_S3_ENDPOINT);
  const [region, setRegion] = useState(DEFAULT_S3_REGION);
  const [dangerDisableSsl, setDangerDisableSsl] = useState(false);
  const [useVirtualHostStyle, setUseVirtualHostStyle] = useState(false);
  const [storageClass, setStorageClass] = useState('STANDARD');
  const [maxBandwidth, setMaxBandwidth] = useState<number | ''>('');
  const [bandwidthRules, setBandwidthRules] = useState<BandwidthRule[]>([]);
  const [newRuleDays, setNewRuleDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [newRuleStartTime, setNewRuleStartTime] = useState('22:00');
  const [newRuleEndTime, setNewRuleEndTime] = useState('06:00');
  const [newRuleLimitKbps, setNewRuleLimitKbps] = useState<number | ''>(512);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showBandwidthAdvanced, setShowBandwidthAdvanced] = useState(false);
  const [sshTunnel, setSshTunnel] = useState<SshTunnelFormValue>({ ...EMPTY_SSH_TUNNEL });
  const [sshTunnelProfileId, setSshTunnelProfileId] = useState<string | undefined>();
  const [host, setHost] = useState('');
  const [port, setPort] = useState<number>(DEFAULT_SFTP_PORT);
  const [username, setUsername] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [sftpPassword, setSftpPassword] = useState('');
  const [showSshHelper, setShowSshHelper] = useState(false);
  const [sshConfigNotice, setSshConfigNotice] = useState('');
  const [loading, setLoading] = useState(false);
  // A profile's secrets arrive from the keychain after the rest of its fields; the form
  // has to say so, otherwise it looks ready while the password box is still empty.
  const [credsLoading, setCredsLoading] = useState(false);
  const [error, setError] = useState('');
  
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [editingProfile, setEditingProfile] = useState<ConnectionProfile | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // A double-click fires onClick twice before onDoubleClick, so up to three profile
  // handlers read the keychain concurrently. Only the last one started may write the
  // form; earlier continuations would otherwise land on top of it.
  const profileActionNonceRef = useRef(0);
  // Guards the double-click connect itself: a second in-flight connect_storage opens a
  // second backend session, and only the last sessionId is kept — the first leaks.
  const connectingRef = useRef(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  useEffect(() => {
    if (!initialProtocol) return;
    setProtocol(initialProtocol);
    if (initialProtocol !== 's3') {
      setPort(defaultPortFor(initialProtocol));
    }
    if (initialProtocol !== 's3' && initialProtocol !== 'sftp') {
      setSshTunnel({ ...EMPTY_SSH_TUNNEL });
      setSshTunnelProfileId(undefined);
    }
  }, [initialProtocol]);

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
      } else {
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

      const profile = {
        id: selectedProfileId || crypto.randomUUID(),
        name: profileName || 'Quick Connect',
        protocol,
        // S3 fields
        endpoint: protocol === 's3' ? (trimmedEndpoint || null) : null,
        region: protocol === 's3' ? (trimmedRegion || null) : null,
        accessKey: protocol === 's3' ? (trimmedAccessKey || null) : null,
        secretKey: protocol === 's3' ? (trimmedSecretKey || null) : null,
        bucket: protocol === 's3' ? trimmedBucket : null,
        dangerDisableSslVerification: protocol === 's3' ? (dangerDisableSsl || null) : null,
        useVirtualHostStyle: protocol === 's3' ? (useVirtualHostStyle || null) : null,
        storageClass: protocol === 's3' ? (storageClass || null) : null,
        maxBandwidth: maxBandwidth ? maxBandwidth * 1024 : null,
        bandwidthRules: bandwidthRules.length > 0 ? bandwidthRules : null,
        // SFTP/FTP fields
        host: (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? trimmedHost : null,
        port: (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? port : null,
        username: (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? trimmedUsername : null,
        keyPath: protocol === 'sftp' ? (trimmedKeyPath || null) : null,
        sshTunnel: sshTunnelProfileId ? null : sshTunnelForProfile(sshTunnel, protocol) ?? null,
        sshTunnelProfileId: sshTunnelProfileId ?? null,
      };
      
      const secret = (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? resolved.sftpPassword || null : null;
      
      const sessionId = await invoke<string>('connect_storage', {
        profile,
        password: secret,
        sshTunnelPassword: resolved.sshTunnelPassword || null,
      });
      
      const displayName = protocol === 's3' ? trimmedBucket : `${trimmedUsername}@${trimmedHost}`;
      // The selected profile (if any) travels with the session so the
      // transfer queue can record which saved profile a transfer belongs to
      onConnected(sessionId, displayName, selectedProfileId ?? undefined, protocol);
    } catch (err: unknown) {
      setError(formatConnectError(err));
    } finally {
      connectingRef.current = false;
      setLoading(false);
    }
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

      const connectProfile = {
        id: profile.id,
        name: profile.name,
        protocol: proto,
        endpoint: proto === 's3' ? (profile.endpoint || null) : null,
        region: proto === 's3' ? (profile.region || null) : null,
        accessKey: proto === 's3' ? access : null,
        secretKey: proto === 's3' ? secretKeyVal : null,
        bucket: proto === 's3' ? (profile.bucket || null) : null,
        dangerDisableSslVerification: proto === 's3' ? (profile.dangerDisableSslVerification || null) : null,
        useVirtualHostStyle: proto === 's3' ? (profile.useVirtualHostStyle || null) : null,
        storageClass: proto === 's3' ? (profile.storageClass || null) : null,
        maxBandwidth: profile.maxBandwidth ?? null,
        bandwidthRules: profile.bandwidthRules ?? null,
        host: proto !== 's3' ? (profile.host || null) : null,
        port: proto !== 's3' ? (profile.port ?? null) : null,
        username: proto !== 's3' ? (profile.username || null) : null,
        keyPath: proto === 'sftp' ? (profile.keyPath || null) : null,
        sshTunnel: profile.sshTunnel ?? null,
        sshTunnelProfileId: profile.sshTunnelProfileId ?? null,
      };

      const sessionId = await invoke<string>('connect_storage', {
        profile: connectProfile,
        password: proto !== 's3' ? password : null,
        sshTunnelPassword: tunnelPassword,
      });
      const displayName =
        proto === 's3'
          ? (profile.bucket || profile.name)
          : `${profile.username || ''}@${profile.host || ''}`;
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

    const profile: ConnectionProfile = {
      id: editingProfile?.id || crypto.randomUUID(),
      name: profileName.trim(),
      protocol,
      // S3 fields
      bucket: protocol === 's3' ? bucket : undefined,
      accessKey: protocol === 's3' ? (accessKey || undefined) : undefined,
      secretKey: protocol === 's3' ? (secretKey || undefined) : undefined,
      endpoint: protocol === 's3' ? (endpoint || undefined) : undefined,
      region: protocol === 's3' ? (region || undefined) : undefined,
      dangerDisableSslVerification: protocol === 's3' ? (dangerDisableSsl || undefined) : undefined,
      useVirtualHostStyle: protocol === 's3' ? (useVirtualHostStyle || undefined) : undefined,
      storageClass: protocol === 's3' ? (storageClass || undefined) : undefined,
      maxBandwidth: protocol === 's3' ? (maxBandwidth ? maxBandwidth * 1024 : undefined) : undefined,
      bandwidthRules: bandwidthRules.length > 0 ? bandwidthRules : undefined,
      // SFTP/FTP fields
      host: (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? host : undefined,
      port: (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? port : undefined,
      username: (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? username : undefined,
      keyPath: protocol === 'sftp' ? (keyPath || undefined) : undefined,
      sshTunnel: sshTunnelProfileId ? undefined : sshTunnelForProfile(sshTunnel, protocol),
      sshTunnelProfileId,
    };
    
    const secret = (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps')
      ? (sftpPassword || null)
      : null;
    await onSaveProfile(profile, secret, sshTunnel.password || null);
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

    const profile: ConnectionProfile = {
      ...selected,
      protocol,
      bucket: protocol === 's3' ? bucket : undefined,
      accessKey: protocol === 's3' ? (accessKey || undefined) : undefined,
      secretKey: protocol === 's3' ? (secretKey || undefined) : undefined,
      endpoint: protocol === 's3' ? (endpoint || undefined) : undefined,
      region: protocol === 's3' ? (region || undefined) : undefined,
      dangerDisableSslVerification: protocol === 's3' ? (dangerDisableSsl || undefined) : undefined,
      useVirtualHostStyle: protocol === 's3' ? (useVirtualHostStyle || undefined) : undefined,
      storageClass: protocol === 's3' ? (storageClass || undefined) : undefined,
      maxBandwidth: protocol === 's3' ? (maxBandwidth ? maxBandwidth * 1024 : undefined) : undefined,
      bandwidthRules: bandwidthRules.length > 0 ? bandwidthRules : undefined,
      host: (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? host : undefined,
      port: (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? port : undefined,
      username: (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') ? username : undefined,
      keyPath: protocol === 'sftp' ? (keyPath || undefined) : undefined,
      sshTunnel: sshTunnelProfileId ? undefined : sshTunnelForProfile(sshTunnel, protocol),
      sshTunnelProfileId,
    };
    const secret = (protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps')
      ? (sftpPassword || null)
      : null;
    await onSaveProfile(profile, secret, sshTunnel.password || null);
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
    setSelectedProfileId(null);
    setProfileName('');
    setEditingProfile(null);
    setProtocol('s3');
    setBucket('');
    setAccessKey('');
    setSecretKey('');
    setEndpoint(DEFAULT_S3_ENDPOINT);
    setRegion(DEFAULT_S3_REGION);
    setDangerDisableSsl(false);
    setUseVirtualHostStyle(false);
    setStorageClass('STANDARD');
    setMaxBandwidth('');
    setBandwidthRules([]);
    setHost('');
    setPort(DEFAULT_SFTP_PORT);
    setUsername('');
    setKeyPath('');
    setSftpPassword('');
    setSshTunnel({ ...EMPTY_SSH_TUNNEL });
    setSshTunnelProfileId(undefined);
    setShowAdvanced(false);
    setShowBandwidthAdvanced(false);
    setShowSshHelper(false);
    setSshConfigNotice('');
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

  const toggleNewRuleDay = (day: number) => {
    setNewRuleDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)
    );
  };

  const handleAddBandwidthRule = () => {
    if (newRuleDays.length === 0) {
      setError('Select at least one day for the bandwidth rule.');
      return;
    }
    const limitKbps = newRuleLimitKbps === '' ? 0 : Number(newRuleLimitKbps);
    setBandwidthRules((prev) => [
      ...prev,
      {
        enabled: true,
        startTime: newRuleStartTime,
        endTime: newRuleEndTime,
        days: [...newRuleDays],
        limitKbps,
      },
    ]);
    setError('');
  };

  const handleDeleteBandwidthRule = (index: number) => {
    setBandwidthRules((prev) => prev.filter((_, i) => i !== index));
  };

  const renderBandwidthRulesSection = () => (
    <div className="pt-3 border-t border-zinc-700 space-y-3">
      <div>
        <label className="block text-sm font-medium text-zinc-200">Bandwidth rules</label>
        <p className="mt-1 text-xs text-zinc-500">
          Matching rule overrides static limit. 0 KB/s = unlimited in that window.
        </p>
      </div>

      {bandwidthRules.length > 0 ? (
        <div className="space-y-2">
          {bandwidthRules.map((rule, index) => (
            <div
              key={`${rule.startTime}-${rule.endTime}-${index}`}
              className="flex items-start justify-between gap-2 p-2 rounded-lg bg-zinc-900/60 border border-zinc-700"
            >
              <div className="min-w-0 text-xs text-zinc-300">
                <div className="font-medium text-zinc-200">
                  {rule.startTime} – {rule.endTime}
                </div>
                <div className="text-zinc-500">{formatRuleDays(rule.days)}</div>
                <div className="text-zinc-400">{formatRuleLimit(rule.limitKbps)}</div>
              </div>
              <button
                type="button"
                onClick={() => handleDeleteBandwidthRule(index)}
                className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-red-400 flex-shrink-0"
                title="Delete rule"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-zinc-500">No bandwidth rules configured.</p>
      )}

      <div className="space-y-3 p-3 rounded-lg bg-zinc-900/40 border border-zinc-700/80">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Add rule</p>
        <div className="flex flex-wrap gap-2">
          {DAY_LABELS.map((label, day) => (
            <label key={label} className="flex items-center space-x-1 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={newRuleDays.includes(day)}
                onChange={() => toggleNewRuleDay(day)}
                className="w-3.5 h-3.5 text-gale-teal bg-zinc-800 border-zinc-600 rounded focus:ring-gale-teal"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Start</label>
            <input
              type="time"
              value={newRuleStartTime}
              onChange={(e) => setNewRuleStartTime(e.target.value)}
              className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">End</label>
            <input
              type="time"
              value={newRuleEndTime}
              onChange={(e) => setNewRuleEndTime(e.target.value)}
              className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-zinc-500 mb-1">Limit (KB/s)</label>
          <input
            type="number"
            min="0"
            placeholder="0 = unlimited"
            value={newRuleLimitKbps}
            onChange={(e) => setNewRuleLimitKbps(e.target.value ? Number(e.target.value) : '')}
            className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal placeholder:text-zinc-500"
          />
        </div>
        <button
          type="button"
          onClick={handleAddBandwidthRule}
          className="flex items-center space-x-1 text-xs text-gale-teal hover:text-deep-current transition-colors"
        >
          <Plus className="w-3 h-3" />
          <span>Add bandwidth rule</span>
        </button>
      </div>
    </div>
  );

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

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Left Sidebar — single-line titlebar clears traffic lights; hint lives below */}
      <div className="w-72 bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0">
        <div
          data-tauri-drag-region
          className="app-titlebar app-titlebar-traffic border-b border-zinc-800 pr-3"
        >
          <h2
            data-tauri-drag-region
            className="text-[13px] font-semibold tracking-tight text-zinc-100 truncate"
          >
            Saved Profiles
          </h2>
        </div>
        <p className="px-3 pt-2 pb-1 text-[11px] text-zinc-500 leading-snug">
          Click to load · double-click to connect
        </p>

        <div className="flex-1 overflow-y-auto p-2 pt-1 galeon-scrollbar">
          {profiles.length === 0 ? (
            <div className="text-center py-8 text-zinc-500 text-sm">
              <Server className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No saved profiles</p>
              <p className="text-xs mt-1">Save a connection to quickly access it later</p>
            </div>
          ) : (
            <div className="space-y-1">
              {profiles.map((profile) => (
                <div
                  key={profile.id}
                  onClick={handleProfileRowClick(profile)}
                  onDoubleClick={() => handleDoubleClickProfile(profile)}
                  className={`p-3 rounded-lg cursor-pointer transition-all duration-150 relative group ${
                    selectedProfileId === profile.id
                      ? 'bg-abyss/40 border border-gale-teal/30 pl-4'
                      : 'hover:bg-zinc-800/60 border border-transparent pl-3'
                  }`}
                >
                  {selectedProfileId === profile.id && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 rounded bg-gale-teal h-8" />
                  )}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2 min-w-0">
                      {profile.protocol === 'sftp' || profile.protocol === 'ftp' || profile.protocol === 'ftps' ? (
                        <Server className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                      ) : (
                        <Database className="w-4 h-4 text-gale-teal flex-shrink-0" />
                      )}
                      <span className="text-sm font-medium truncate">{profile.name}</span>
                    </div>
                    <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEditProfile(profile); }}
                        className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteProfile(profile.id); }}
                        className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-red-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500 truncate">
                    {profile.protocol === 'sftp' || profile.protocol === 'ftp' || profile.protocol === 'ftps'
                      ? `${profile.username}@${profile.host}:${profile.port || defaultPortFor(profile.protocol)}${profile.sshTunnelProfileId ? ' • via saved tunnel' : profile.sshTunnel ? ` • via ${profile.sshTunnel.host}` : ''}`
                      : `${profileEndpointLabel(profile.endpoint, profile.bucket)}${profile.sshTunnelProfileId ? ' • via saved tunnel' : profile.sshTunnel ? ` • via ${profile.sshTunnel.host}` : ''}`
                    }
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-zinc-800 space-y-2">
          <ProfileImportExport
            profiles={profiles}
            selectedProfileId={selectedProfileId}
            onReloadProfiles={onReloadProfiles}
            onImportComplete={resetFormToDefaults}
          />
          {appVersion && (
            <div className="text-xs text-zinc-500 metric-text pt-1">
              Galeon v{appVersion}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel - Connection Form */}
      <div className="flex-1 flex flex-col min-w-0">
        <div
          data-tauri-drag-region
          className="app-titlebar justify-end gap-2 pr-4 pl-4 border-b border-zinc-800/60 bg-zinc-950"
        >
          {onOpenSettings && (
            <button
              type="button"
              data-no-drag
              onClick={onOpenSettings}
              className="flex items-center gap-1.5 text-xs bg-zinc-800/80 hover:bg-zinc-700 px-2.5 py-1 rounded-md font-medium transition-colors text-zinc-300"
            >
              <Settings className="w-3.5 h-3.5" />
              <span>Settings</span>
            </button>
          )}
        </div>
        <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto galeon-scrollbar">
        <div className="w-full max-w-md p-8 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl backdrop-blur-md">
          <h2 className="text-3xl font-display font-medium mb-6 tracking-[0.06em] text-zinc-100">
            Connect Storage
          </h2>
          {error && (
            <div className="p-3 mb-4 text-sm bg-red-950/50 border border-red-800 text-red-200 rounded-lg flex items-start justify-between gap-3">
              <span className="min-w-0 break-words">{error}</span>
              <button
                type="button"
                onClick={() => setError('')}
                className="shrink-0 text-red-400/80 hover:text-red-200 text-lg leading-none"
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}
          <form onSubmit={handleConnect} className="space-y-4">
            {/* Protocol Selector */}
            <div>
              <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                Protocol
              </label>
              <select
                value={protocol}
                onChange={(e) => {
                  const newProto = e.target.value as 's3' | 'sftp' | 'ftp' | 'ftps';
                  const currentPort = port;
                  setProtocol(newProto);
                  setSshConfigNotice('');
                  if (newProto !== 's3' && newProto !== 'sftp') {
                    // FTP data channels cannot use this single-port SSH forwarding path.
                    // Clear the hidden choice so it cannot leak into a saved FTP/FTPS profile.
                    setSshTunnel({ ...EMPTY_SSH_TUNNEL });
                    setSshTunnelProfileId(undefined);
                  }

                  // Apply the new protocol's default port when switching, but only
                  // override a port that still looks like some protocol's default —
                  // a hand-typed port belongs to the user.
                  if (newProto !== 's3') {
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
              </select>
            </div>
            
            {/* S3 Fields */}
            {protocol === 's3' && (
              <>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Bucket Name</label>
                  <input type="text" value={bucket} onChange={(e) => setBucket(e.target.value)} required placeholder="e.g. my-bucket" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                  <p className="mt-1 text-xs text-zinc-500">Bucket name (not the full URL)</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Access Key ID</label>
                  <input type="text" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Secret Access Key</label>
                  <input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Custom Endpoint</label>
                  <input type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="Leave empty for AWS, or https://minio.example.com:9000" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                  <p className="mt-1 text-xs text-zinc-500">MinIO / R2 / Wasabi: paste the API endpoint URL</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Region</label>
                    <input type="text" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1 (optional for MinIO)" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                  </div>
                  <div className="flex items-end pb-2">
                    <div className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        id="disable-ssl"
                        checked={dangerDisableSsl}
                        onChange={(e) => setDangerDisableSsl(e.target.checked)}
                        className="w-4 h-4 text-yellow-500 bg-zinc-800 border-zinc-600 rounded focus:ring-yellow-500"
                      />
                      <label htmlFor="disable-ssl" className="text-xs text-zinc-400">
                        Disable SSL Verify
                        {dangerDisableSsl && (
                          <span className="ml-1 text-yellow-500">(self-signed OK)</span>
                        )}
                      </label>
                    </div>
                  </div>
                </div>
                
                {/* Advanced Settings Toggle */}
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center space-x-2 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  <span>{showAdvanced ? '▼' : '▶'}</span>
                  <span>Advanced S3 Options</span>
                </button>
                
                {/* Advanced Settings Panel */}
                {showAdvanced && (
                  <div className="p-4 bg-zinc-800/50 rounded-lg border border-zinc-700 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm font-medium text-zinc-200">Virtual Host Style</label>
                        <p className="text-xs text-zinc-500">Use bucket.endpoint.com style URLs</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setUseVirtualHostStyle(!useVirtualHostStyle)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          useVirtualHostStyle ? 'bg-gale-teal' : 'bg-zinc-700'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          useVirtualHostStyle ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-zinc-200 mb-1">Storage Class</label>
                      <select
                        value={storageClass}
                        onChange={(e) => setStorageClass(e.target.value)}
                        className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all"
                      >
                        <option value="STANDARD">Standard</option>
                        <option value="REDUCED_REDUNDANCY">Reduced Redundancy</option>
                        <option value="STANDARD_IA">Standard-IA</option>
                        <option value="ONEZONE_IA">One Zone-IA</option>
                        <option value="INTELLIGENT_TIERING">Intelligent-Tiering</option>
                        <option value="GLACIER">Glacier</option>
                        <option value="GLACIER_DEEP_ARCHIVE">Glacier Deep Archive</option>
                      </select>
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-zinc-200 mb-1">Bandwidth Limit (KB/s)</label>
                      <input
                        type="number"
                        min="0"
                        placeholder="Unlimited"
                        value={maxBandwidth}
                        onChange={(e) => setMaxBandwidth(e.target.value ? Number(e.target.value) : '')}
                        className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all placeholder:text-zinc-500"
                      />
                      <p className="mt-1 text-xs text-zinc-500">Leave blank for unlimited speed</p>
                    </div>

                    {renderBandwidthRulesSection()}
                  </div>
                )}
              </>
            )}
            
            {/* SFTP Fields */}
            {(protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps') && (
              <>
                {protocol === 'sftp' && (
                  <>
                    <SshConfigImport onSelect={handleSshConfigSelect} />
                    {sshConfigNotice && (
                      <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg text-xs text-amber-200">
                        {sshConfigNotice}
                      </div>
                    )}
                  </>
                )}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                    Host
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    required
                    placeholder="e.g., sftp.example.com"
                    className={FIELD}
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                      Port
                    </label>
                    <input
                      type="number"
                      value={port}
                      onChange={(e) => setPort(Number(e.target.value))}
                      className={FIELD}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                      Username
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                      className={FIELD}
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="mb-3">
                  <label htmlFor="storage-password" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                    Password
                  </label>
                  <div className="space-y-2">
                    <div>
                      <p className="mb-1 text-xs text-zinc-500">
                        {protocol === 'sftp'
                          ? 'Default authentication. A password entered here takes precedence over an SSH key.'
                          : 'Stored securely in your OS keyring when you save this profile.'}
                      </p>
                      <input
                        id="storage-password"
                        type="password"
                        value={sftpPassword}
                        onChange={(e) => setSftpPassword(e.target.value)}
                        placeholder="Enter password"
                        className={FIELD}
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="current-password"
                        spellCheck={false}
                      />
                    </div>
                    {protocol === 'sftp' && (
                    <>
                    <div className="flex items-center gap-3 text-xs text-zinc-500" aria-hidden="true">
                      <span className="h-px flex-1 bg-zinc-700" />
                      <span>or use an SSH key</span>
                      <span className="h-px flex-1 bg-zinc-700" />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500">SSH Private Key Path</label>
                      <input
                        type="text"
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                        placeholder="/Users/you/.ssh/id_ed25519"
                        className={FIELD}
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    {/* SSH Key Helper */}
                    <button
                      type="button"
                      onClick={() => setShowSshHelper(!showSshHelper)}
                      className="flex items-center space-x-1 text-xs text-gale-teal hover:text-deep-current transition-colors"
                    >
                      <Key className="w-3 h-3" />
                      <span>{showSshHelper ? 'Hide Key Helper' : 'Need an SSH key? Generate one'}</span>
                    </button>
                    {showSshHelper && (
                      <SshKeyHelper
                        onKeyGenerated={(path) => {
                          setKeyPath(path);
                          setShowSshHelper(false);
                        }}
                        onClose={() => setShowSshHelper(false)}
                      />
                    )}
                    </>
                    )}
                  </div>
                </div>
                {protocol === 'sftp' && !keyPath && !sftpPassword && !credsLoading && (
                    <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg">
                        <div className="flex items-start space-x-2">
                            <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5" />
                            <div>
                                <p className="text-xs text-amber-200 font-medium">Authentication Required</p>
                                <p className="text-xs text-amber-400/80 mt-1">
                                    Enter a password, or choose an SSH key if this server does not allow password login.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
              </>
            )}

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
                  className="flex items-center space-x-2 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  <span>{showBandwidthAdvanced ? '▼' : '▶'}</span>
                  <span>Advanced Bandwidth Rules</span>
                </button>
                {showBandwidthAdvanced && (
                  <div className="p-4 bg-zinc-800/50 rounded-lg border border-zinc-700">
                    {renderBandwidthRulesSection()}
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
            <div className="flex space-x-2">
              <button type="submit" disabled={loading} className="flex-1 py-3 bg-gale-teal text-on-accent font-semibold hover:bg-deep-current hover:text-white rounded-lg text-sm transition-all duration-150 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? 'Connecting...' : protocol === 'sftp' ? 'Connect SFTP' : protocol === 'ftp' ? 'Connect FTP' : protocol === 'ftps' ? 'Connect FTPS' : 'Connect S3'}
              </button>
              {selectedProfileId && (
                <button
                  type="button"
                  onClick={handleSaveButton}
                  disabled={protocol === 's3' ? !bucket : !host}
                  className="px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                  title="Save changes to profile"
                >
                  <Save className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={handleSaveAsNewProfile}
                disabled={protocol === 's3' ? !bucket : !host}
                className="px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
                title="Save as new profile"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleClearCredentials}
                className="px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition-colors"
                title={
                  protocol === 's3'
                    ? 'Clear bucket and access keys'
                    : 'Clear host, username, and password'
                }
              >
                <Eraser className="w-4 h-4" />
              </button>
            </div>
          </form>
        </div>
        </div>
      </div>

      {/* Save Profile Modal */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-96 shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">
              {editingProfile ? 'Edit Profile' : 'Save Profile'}
            </h3>
            <input
              type="text"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveProfile()}
              placeholder="Profile name"
              className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all mb-4"
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex justify-end space-x-2">
              <button
                onClick={() => { setShowSaveModal(false); setProfileName(''); setEditingProfile(null); }}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveProfile}
                disabled={!profileName.trim()}
                className="px-4 py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingProfile ? 'Update' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
