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

export interface ConnectionProfile {
  id: string;
  name: string;
  protocol?: 's3' | 'sftp' | 'ftp' | 'ftps'; // Protocol type, defaults to 's3'
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
}
