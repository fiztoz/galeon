export interface SshTunnelFormValue {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  keyPath: string;
}

export interface SavedSshTunnelValue {
  host: string;
  port: number;
  username: string;
  keyPath?: string;
  /** Import/export only; persisted profiles keep this in the OS keyring. */
  password?: string;
}

export type TunnelProtocol = 's3' | 'sftp' | 'ftp' | 'ftps';

export const EMPTY_SSH_TUNNEL: SshTunnelFormValue = {
  enabled: false,
  host: '',
  port: 22,
  username: '',
  password: '',
  keyPath: '',
};

export const sshTunnelForProfile = (
  value: SshTunnelFormValue,
  protocol: TunnelProtocol,
): SavedSshTunnelValue | undefined => {
  if (!value.enabled || (protocol !== 's3' && protocol !== 'sftp')) return undefined;
  return {
    host: value.host.trim(),
    port: value.port,
    username: value.username.trim(),
    keyPath: value.keyPath.trim() || undefined,
  };
};

export const sshTunnelFormFromProfile = (
  tunnel?: SavedSshTunnelValue,
): SshTunnelFormValue =>
  tunnel
    ? {
        enabled: true,
        host: tunnel.host,
        port: tunnel.port || 22,
        username: tunnel.username,
        password: tunnel.password || '',
        keyPath: tunnel.keyPath || '',
      }
    : { ...EMPTY_SSH_TUNNEL };

export const validateSshTunnelDestination = (
  enabled: boolean,
  protocol: TunnelProtocol,
  endpoint: string,
  sslVerificationDisabled: boolean,
  virtualHostStyle: boolean,
): string | null => {
  if (!enabled || (protocol !== 's3' && protocol !== 'sftp')) return null;
  if (protocol === 's3' && !endpoint.trim()) {
    return 'SSH tunneling for S3 requires a custom endpoint.';
  }
  if (
    protocol === 's3' &&
    !endpoint.trim().toLowerCase().startsWith('http://') &&
    !sslVerificationDisabled
  ) {
    return 'Use HTTP inside the encrypted SSH tunnel, or explicitly enable Disable SSL Verify for this HTTPS endpoint.';
  }
  if (protocol === 's3' && virtualHostStyle) {
    return 'Turn off Virtual Host Style before using an SSH tunnel.';
  }
  return null;
};
