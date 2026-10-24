/**
 * Pure helpers the connect screen and its profile actions share.
 *
 * Protocol classes decide which fields a profile carries; the error and
 * endpoint formatters turn backend text into something a person can act on.
 * Nothing here touches React or Tauri.
 */
import type { ConnectionProfile, StorageProtocol } from '../../types';

/** Friend-readable connect errors (strip noisy Rust/Tauri wrappers when present). */
export const formatConnectError = (err: unknown): string => {
  let msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  msg = msg.replace(/^Error:\s*/i, '').trim();
  if (msg.length > 280) msg = msg.slice(0, 277) + '…';
  return msg || 'Connection failed. Check host, credentials, and network.';
};

/** Word pools for auto-saved profiles: short, friendly, ~250 combinations. */
const NAME_ADJECTIVES = [
  'Cobalt', 'Amber', 'Quiet', 'Rapid', 'Velvet', 'Copper', 'Lunar', 'Drift',
  'Zesty', 'Mellow', 'Nimble', 'Stellar', 'Sunny', 'Brisk', 'Northern', 'Ember',
];
const NAME_NOUNS = [
  'Otter', 'Heron', 'Ferret', 'Comet', 'Harbor', 'Meridian', 'Lantern', 'Juniper',
  'Falcon', 'Peregrine', 'Willow', 'Bay', 'Sable', 'Cove', 'Marlin', 'Zephyr',
];

/** A fresh random profile name (adjective + noun). */
export const randomProfileName = (): string =>
  `${NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)]} ` +
  NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];

/**
 * `base` unless an existing profile took it, then "base 2", "base 3", … —
 * case-insensitive on the existing names, mirroring the save dialog's duplicate check.
 */
export const uniqueProfileName = (base: string, existingNames: string[]): string => {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const candidate = base.trim();
  // A fresh random draw still gets its own availability check; only a taken
  // stem moves to the numbered suffixes.
  const stem = candidate || randomProfileName();
  if (!taken.has(stem.toLowerCase())) return stem;
  let n = 2;
  while (taken.has(`${stem} ${n}`.toLowerCase())) n += 1;
  return `${stem} ${n}`;
};

/** Compare any two profile-ish values (strings/numbers/booleans/arrays/objects). */
const sameProfileValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameProfileValue(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  // Missing keys count as absent: the stored profile may drop `undefined`-valued
  // fields entirely while the form keeps them as present-but-empty.
  const aKeys = Object.keys(aObj).filter((k) => aObj[k] != null);
  const bKeys = Object.keys(bObj).filter((k) => bObj[k] != null);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => sameProfileValue(aObj[k], bObj[k]));
};

/**
 * The fields a Connect can change on the selected profile — everything except
 * the in-band secrets (accessKey/secretKey): a stored profile never carries
 * those (keyring only), so comparing them would always report a change.
 */
const COMPARED_PROFILE_FIELDS = [
  'protocol', 'endpoint', 'region', 'bucket',
  'dangerDisableSslVerification', 'useVirtualHostStyle', 'storageClass',
  'maxBandwidth', 'bandwidthRules', 'passiveMode', 'encrypt',
  'host', 'port', 'username', 'keyPath', 'credentialPath',
  'sshTunnel', 'sshTunnelProfileId',
] as const;

/**
 * Whether a successful Connect leaves the selected profile different from what
 * is saved — the trigger for the overwrite prompt.
 *
 * Form and stored values normalize defaults differently (absent vs `''`/`false`
 * vs `'STANDARD'`; bytes vs KiB for maxBandwidth), so blank both sides first.
 */
export const selectedProfileChanged = (
  selected: ConnectionProfile,
  candidate: ConnectionProfile,
): boolean => {
  const sameField = (field: (typeof COMPARED_PROFILE_FIELDS)[number]) => {
    const norm = (v: unknown): unknown => {
      if (v == null) return undefined;
      if (field === 'storageClass' && v === 'STANDARD') return undefined;
      return v === '' || v === false ? undefined : v;
    };
    return sameProfileValue(norm(selected[field]), norm(candidate[field]));
  };
  return COMPARED_PROFILE_FIELDS.some((field) => !sameField(field));
};

/** Hostname for session subtitles (invalid endpoints fall back to the raw string). */
export const hostOfEndpoint = (endpoint: string) => {
  try {
    return new URL(endpoint).hostname || endpoint;
  } catch {
    return endpoint.replace(/^https?:\/\//, '');
  }
};

/** Safe hostname display for sidebar subtitles (invalid endpoints must not crash render). */
export const profileEndpointLabel = (endpoint?: string, bucket?: string) => {
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

/** Host/port/password protocols (native Rust transports, no bucket concept). */
export const isFileProtocol = (protocol: StorageProtocol) =>
  protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps';

/** Endpoint-URL protocols on OpenDAL (WebDAV, Azure Blob, GCS). */
export const isHttpProtocol = (protocol: StorageProtocol) =>
  protocol === 'webdav' || protocol === 'azure' || protocol === 'gcs';
