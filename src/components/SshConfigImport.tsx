import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileKey2, Loader2, RefreshCw, X } from 'lucide-react';

export interface SshConfigConnection {
  alias: string;
  host: string;
  port: number;
  username?: string;
  keyPath?: string;
  proxyJump?: string;
}

interface SshConfigImportProps {
  onSelect: (connection: SshConfigConnection) => void;
  mode?: 'sftp' | 'tunnel';
}

const formatError = (error: unknown): string => {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/i, '').trim() || 'Could not read ~/.ssh/config.';
};

/** Compact picker that copies supported fields from named OpenSSH hosts. */
export const SshConfigImport = ({ onSelect, mode = 'sftp' }: SshConfigImportProps) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connections, setConnections] = useState<SshConfigConnection[] | null>(null);
  const [error, setError] = useState('');
  const tunnelImport = mode === 'tunnel';

  const loadConnections = async () => {
    setLoading(true);
    setError('');
    try {
      const command = tunnelImport
        ? 'list_ssh_tunnel_config_connections'
        : 'list_ssh_config_connections';
      const result = await invoke<SshConfigConnection[]>(command);
      setConnections(result);
    } catch (loadError) {
      setConnections(null);
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  };

  const showPicker = () => {
    setOpen(true);
    if (connections === null && !loading) void loadConnections();
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={showPicker}
        className="flex items-center gap-1.5 text-xs text-gale-teal hover:text-deep-current transition-colors"
      >
        <FileKey2 className="w-3.5 h-3.5" />
        <span>{tunnelImport ? 'Import from ~/.ssh/config' : 'Use a host from ~/.ssh/config'}</span>
      </button>
    );
  }

  return (
    <div className="p-3 bg-zinc-800/50 border border-zinc-700 rounded-lg space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-zinc-200">
            {tunnelImport ? 'Importable OpenSSH hosts' : 'OpenSSH hosts'}
          </p>
          <p className="text-[11px] text-zinc-500">
            {tunnelImport
              ? 'Only entries with HostName, User, and IdentityFile are shown.'
              : 'Choose a named Host entry to fill this form.'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void loadConnections()}
            disabled={loading}
            className="p-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
            title="Reload ~/.ssh/config"
            aria-label="Reload SSH config"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1 text-zinc-400 hover:text-zinc-200"
            aria-label="Close SSH config picker"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {loading && (
        <p className="flex items-center gap-1.5 text-xs text-zinc-400" aria-live="polite">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Reading SSH config…
        </p>
      )}
      {!loading && error && <p className="text-xs text-red-300" role="alert">{error}</p>}
      {!loading && connections?.length === 0 && (
        <p className="text-xs text-zinc-400">
          {tunnelImport
            ? 'No importable hosts found. Add a named Host with HostName, User, and IdentityFile; entries using ProxyJump are not shown.'
            : 'No named Host entries found in ~/.ssh/config. Wildcard-only entries are not selectable.'}
        </p>
      )}
      {!loading && connections && connections.length > 0 && (
        <select
          defaultValue=""
          onChange={(event) => {
            const connection = connections.find((item) => item.alias === event.target.value);
            if (!connection) return;
            onSelect(connection);
            setOpen(false);
          }}
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal"
          aria-label={tunnelImport ? 'SSH config tunnel host' : 'SSH config host'}
        >
          <option value="" disabled>Select a host…</option>
          {connections.map((connection) => (
            <option key={connection.alias} value={connection.alias}>
              {connection.alias} — {connection.username ? `${connection.username}@` : ''}{connection.host}:{connection.port}
            </option>
          ))}
        </select>
      )}
    </div>
  );
};
