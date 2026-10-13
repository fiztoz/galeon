import React, { useMemo, useState } from 'react';
import { Server, Database, Pencil, Trash2, Plus, Search } from 'lucide-react';
import type { ConnectionProfile } from '../../types';
import { ProfileImportExport } from '../ProfileImportExport';
import { defaultPortFor } from './defaults';

interface ProfileSidebarProps {
  profiles: ConnectionProfile[];
  selectedProfileId: string | null;
  appVersion: string | null;
  profileEndpointLabel: (endpoint?: string, bucket?: string) => string;
  onRowClick: (profile: ConnectionProfile) => (e: React.MouseEvent) => void;
  onRowDoubleClick: (profile: ConnectionProfile) => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profileId: string) => void;
  onReloadProfiles?: () => Promise<void>;
  onImportComplete: () => void;
  onNewConnection: () => void;
}

/**
 * Saved-profiles sidebar extracted from Connection.tsx (AGENTS.md §3.2).
 *
 * Owns listing, text filtering, and selection chrome. The parent keeps the
 * connect / credential flow; this component only reports which row was
 * clicked, double-clicked, edited, or deleted.
 */
export const ProfileSidebar: React.FC<ProfileSidebarProps> = ({
  profiles,
  selectedProfileId,
  appVersion,
  profileEndpointLabel,
  onRowClick,
  onRowDoubleClick,
  onEdit,
  onDelete,
  onReloadProfiles,
  onImportComplete,
  onNewConnection,
}) => {
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => {
      const hay = [p.name, p.bucket, p.endpoint, p.host, p.username]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [profiles, filter]);

  const subtitleFor = (profile: ConnectionProfile) => {
    if (profile.protocol === 'sftp' || profile.protocol === 'ftp' || profile.protocol === 'ftps') {
      const via = profile.sshTunnelProfileId
        ? ' • via saved tunnel'
        : profile.sshTunnel
          ? ` • via ${profile.sshTunnel.host}`
          : '';
      return `${profile.username}@${profile.host}:${profile.port || defaultPortFor(profile.protocol)}${via}`;
    }
    const via = profile.sshTunnelProfileId
      ? ' • via saved tunnel'
      : profile.sshTunnel
        ? ` • via ${profile.sshTunnel.host}`
        : '';
    return `${profileEndpointLabel(profile.endpoint, profile.bucket)}${via}`;
  };

  return (
    <aside aria-label="Saved connections" className="profile-sidebar bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0">
      <div
        data-tauri-drag-region
        className="app-titlebar app-titlebar-traffic border-b border-zinc-800 pr-3"
      >
        <h2
          data-tauri-drag-region
          className="text-[13px] font-semibold tracking-tight text-zinc-100 truncate"
        >
          Galeon
        </h2>
      </div>
      <div className="px-3 pt-4 pb-3">
        <button type="button" onClick={onNewConnection} className="ui-button ui-button-secondary w-full justify-start">
          <Plus size={15} aria-hidden="true" /> New connection
        </button>
      </div>
      <div className="flex items-center justify-between px-4 pb-2">
        <h2 className="text-xs font-medium text-zinc-400">Saved profiles</h2>
        <span className="text-xs text-zinc-500 metric-text">{profiles.length}</span>
      </div>

      {profiles.length > 4 && (
        <div className="profile-search mx-3 mb-2">
          <Search size={14} aria-hidden="true" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter saved profiles"
            placeholder="Filter profiles…"
            className="connection-field w-full text-xs text-zinc-100 placeholder:text-zinc-500"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2 pt-1 galeon-scrollbar">
        {profiles.length === 0 ? (
          <div className="px-2 py-5 text-zinc-500 text-xs leading-relaxed">
            <p className="font-medium text-zinc-400">Your connections, kept here.</p>
            <p className="mt-1">Save a profile to reuse its settings next time.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-zinc-500 text-sm">
            <p>No matching profiles</p>
            <button
              type="button"
              onClick={() => setFilter('')}
              className="text-xs text-gale-teal hover:text-deep-current mt-1"
            >
              Clear filter
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((profile) => (
              <div
                key={profile.id}
                className={`profile-row flex items-center rounded-md border relative group ${
                  selectedProfileId === profile.id
                    ? 'bg-gale-teal/10 border-gale-teal/30'
                    : 'hover:bg-zinc-800/60 border-transparent'
                }`}
              >
                <button
                  type="button"
                  onClick={onRowClick(profile)}
                  onDoubleClick={() => onRowDoubleClick(profile)}
                  aria-pressed={selectedProfileId === profile.id}
                  className="min-w-0 flex-1 px-2.5 py-2.5 text-left rounded-md"
                  title={`Load ${profile.name}`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {profile.protocol === 'sftp' || profile.protocol === 'ftp' || profile.protocol === 'ftps' ? (
                      <Server className="w-4 h-4 text-zinc-400 shrink-0" />
                    ) : (
                      <Database className="w-4 h-4 text-zinc-400 shrink-0" />
                    )}
                    <span className="text-[13px] font-medium truncate">{profile.name}</span>
                  </span>
                  <span className="block mt-1 text-xs text-zinc-500 truncate" title={subtitleFor(profile)}>
                    {subtitleFor(profile)}
                  </span>
                </button>
                <div className="profile-actions flex shrink-0 items-center pr-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <button
                    type="button"
                    aria-label={`Edit ${profile.name}`}
                    title="Edit profile"
                    onClick={() => onEdit(profile)}
                    className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${profile.name}`}
                    title="Delete profile"
                    onClick={() => onDelete(profile.id)}
                    className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-status-danger"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-3 border-t border-zinc-800 space-y-3">
        {profiles.length > 0 && <p className="text-[11px] text-zinc-500 leading-relaxed">Select to edit · double-click to connect</p>}
        <ProfileImportExport
          profiles={profiles}
          selectedProfileId={selectedProfileId}
          onReloadProfiles={onReloadProfiles}
          onImportComplete={onImportComplete}
        />
        {appVersion && (
          <div className="text-[11px] text-zinc-500 metric-text pt-1">
            Galeon v{appVersion}
          </div>
        )}
      </div>
    </aside>
  );
};
