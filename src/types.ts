/**
 * Shared wire contracts between the React app and the Rust command layer.
 *
 * These used to live in `App.tsx`, which meant every feature component imported
 * its types from the app shell. Field names are camelCase to match the Rust
 * structs' `#[serde(rename_all = "camelCase")]` (AGENTS.md 3.4).
 */

/** Mirrors `types::AppSettings` (camelCase) in the Rust layer. */
export interface AppSettings {
  onboardingComplete: boolean;
  /** Present from 1.0.0-alpha.3 on; absent in a user's existing app_settings.json. */
  dualPaneEnabled?: boolean;
  localPanePath?: string | null;
  /** 0..1 fraction of the width given to the local pane; absent means 50/50. */
  splitRatio?: number | null;
  /** "system" | "dark" | "light"; absent or unknown resolves to system. */
  theme?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface BandwidthRule {
  enabled: boolean;
  startTime: string; // "HH:MM"
  endTime: string;
  days: number[]; // 0=Mon..6=Sun
  limitKbps: number; // 0 = unlimited
}

/**
 * Storage protocol Galeon speaks. `s3` covers every S3-compatible provider
 * (the presets in `components/connection/presets.ts` pick their quirks);
 * `webdav`, `azure`, and `gcs` are the non-S3 OpenDAL services.
 */
export type StorageProtocol = 's3' | 'sftp' | 'ftp' | 'ftps' | 'webdav' | 'azure' | 'gcs';

export interface ConnectionProfile {
  id: string;
  name: string;
  protocol?: StorageProtocol; // Protocol type, defaults to 's3'
  // S3 fields
  endpoint?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
  bucket?: string; // Now optional for SFTP/FTP
  dangerDisableSslVerification?: boolean;
  useVirtualHostStyle?: boolean;
  storageClass?: string;
  maxBandwidth?: number;
  bandwidthRules?: BandwidthRule[];
  // SFTP/FTP fields
  host?: string;
  port?: number;
  username?: string;
  keyPath?: string; // Path to SSH private key
  credentialPath?: string; // Path to the GCS service-account JSON
  passiveMode?: boolean; // FTP passive mode
  encrypt?: boolean; // FTPS encryption
  // Optional SSH bastion used to forward the configured S3/SFTP destination.
  sshTunnel?: {
    host: string;
    port: number;
    username: string;
    keyPath?: string;
    // Import/export only. Saved profiles keep this in the OS keyring, not config JSON.
    password?: string;
  };
  // Reusable tunnel identity; tunnel metadata is stored in ssh_tunnel_profiles.json.
  sshTunnelProfileId?: string;
}

export interface ProtocolCapabilities {
  supportsPresignedUrls: boolean;
  supportsMultipart: boolean;
  supportsStorageClass: boolean;
  supportsVirtualHostStyle: boolean;
  supportsBucketConcept: boolean;
  supportsBulkDelete: boolean;
}

export interface PresignHistoryEntry {
  id: string;
  fileKey: string;
  fileName: string;
  url: string;
  expiresInSeconds: number;
  createdAt: string;
  /** "download" for GET links, "upload" for PUT links. Absent on pre-1.0 entries. */
  operation?: string;
}

export interface GaleonObject {
  name: string;
  fullKey: string;
  objectType: 'folder' | 'file';
  sizeBytes: number | null;
  lastModified: string | null;
}

/**
 * Mirrors `types::DirectoryListing` (camelCase).
 *
 * The backend caps a single directory listing so one IPC message cannot carry
 * an entire flat prefix. When `truncated` is set the UI must say so — silently
 * showing a partial bucket reads as "this is everything", which is worse than
 * a long wait.
 */
export interface DirectoryListing {
  objects: GaleonObject[];
  returned: number;
  truncated: boolean;
  limit: number;
}
