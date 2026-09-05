// Neutral defaults for friend installs (no org-specific endpoints baked in).
export const DEFAULT_S3_ENDPOINT = '';
export const DEFAULT_S3_REGION = '';
export const DEFAULT_SFTP_PORT = 22;
export const DEFAULT_FTP_PORT = 21;
// FTPS here is *explicit* FTPS (AUTH TLS): `ftp_native::FtpSession::connect` opens a
// plaintext control channel and upgrades it with `into_secure`, which is the port-21
// flow. Implicit FTPS on 990 expects a TLS handshake immediately and never sends a
// plaintext banner, so defaulting to it fails before login.
const DEFAULT_FTPS_PORT = DEFAULT_FTP_PORT;

/**
 * Default port per protocol. Must stay in sync with the backend fallback in
 * `connect_storage` (src-tauri/src/commands/connect.rs), otherwise the form shows one port
 * while an unset profile actually connects on another.
 */
export const defaultPortFor = (proto: string): number => {
  if (proto === 'sftp') return DEFAULT_SFTP_PORT;
  if (proto === 'ftps') return DEFAULT_FTPS_PORT;
  return DEFAULT_FTP_PORT;
};

