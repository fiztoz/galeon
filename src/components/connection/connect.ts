/**
 * Pure helpers the connect screen and its profile actions share.
 *
 * Protocol classes decide which fields a profile carries; the error and
 * endpoint formatters turn backend text into something a person can act on.
 * Nothing here touches React or Tauri.
 */
import type { StorageProtocol } from '../../types';

/** Friend-readable connect errors (strip noisy Rust/Tauri wrappers when present). */
export const formatConnectError = (err: unknown): string => {
  let msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  msg = msg.replace(/^Error:\s*/i, '').trim();
  if (msg.length > 280) msg = msg.slice(0, 277) + '…';
  return msg || 'Connection failed. Check host, credentials, and network.';
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
