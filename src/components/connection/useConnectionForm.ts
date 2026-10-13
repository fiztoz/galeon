import { useState } from 'react';
import type { BandwidthRule, StorageProtocol } from '../../types';
import { EMPTY_SSH_TUNNEL, type SshTunnelFormValue } from '../sshTunnel';
import { DEFAULT_S3_ENDPOINT, DEFAULT_S3_REGION, DEFAULT_SFTP_PORT } from './defaults';

/**
 * Field state for the connection form.
 *
 * Extracted from `Connection.tsx` because the form grew past the ~1000 line
 * bar in AGENTS.md 3.2 with ~30 `useState` calls in one component body. This
 * hook is deliberately dumb: it holds values, their setters, and the one
 * operation that touches all of them (`reset`). Everything else — validation,
 * keychain reads, connect — stays in the component, where the flows are
 * readable in one place.
 *
 * Setters keep their original names so existing call sites are unaffected.
 */
export function useConnectionForm() {
  const [protocol, setProtocol] = useState<StorageProtocol>('s3');
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showBandwidthAdvanced, setShowBandwidthAdvanced] = useState(false);
  const [sshTunnel, setSshTunnel] = useState<SshTunnelFormValue>({ ...EMPTY_SSH_TUNNEL });
  const [sshTunnelProfileId, setSshTunnelProfileId] = useState<string | undefined>();
  const [host, setHost] = useState('');
  const [port, setPort] = useState<number>(DEFAULT_SFTP_PORT);
  const [username, setUsername] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [credentialPath, setCredentialPath] = useState('');
  const [sftpPassword, setSftpPassword] = useState('');
  const [showSshHelper, setShowSshHelper] = useState(false);
  const [sshConfigNotice, setSshConfigNotice] = useState('');

  /**
   * Clear every field back to its default.
   *
   * The caller bumps its own nonce first: Connect/Save must not fire against
   * stale fields after a profile import.
   */
  const resetFields = () => {
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
    setCredentialPath('');
    setSftpPassword('');
    setSshTunnel({ ...EMPTY_SSH_TUNNEL });
    setSshTunnelProfileId(undefined);
    setShowAdvanced(false);
    setShowBandwidthAdvanced(false);
    setShowSshHelper(false);
    setSshConfigNotice('');
  };

  return {
    // S3
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
    // SSH tunnel
    sshTunnel, setSshTunnel,
    sshTunnelProfileId, setSshTunnelProfileId,
    // SFTP / FTP
    host, setHost,
    port, setPort,
    username, setUsername,
    keyPath, setKeyPath,
    credentialPath, setCredentialPath,
    sftpPassword, setSftpPassword,
    showSshHelper, setShowSshHelper,
    sshConfigNotice, setSshConfigNotice,
    // Operations
    resetFields,
  };
}