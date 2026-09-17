import React, { useMemo, useState } from 'react';
import { Server, Database, Pencil, Trash2 } from 'lucide-react';
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
    <div className="profile-sidebar w-72 bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0">
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

      {profiles.length > 4 && (
        <div className="px-2 pb-1">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter saved profiles"
            placeholder="Filter profiles…"
            className="w-full px-2.5 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-gale-teal"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2 pt-1 galeon-scrollbar">
        {profiles.length === 0 ? (
          <div className="text-center py-8 text-zinc-500 text-sm">
            <Server className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No saved profiles</p>
            <p className="text-xs mt-1">Save a connection to quickly access it later</p>
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
                className={`flex items-center rounded-lg border relative group ${
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
                  className="min-w-0 flex-1 p-3 text-left rounded-lg"
                  title={`Load ${profile.name}`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {profile.protocol === 'sftp' || profile.protocol === 'ftp' || profile.protocol === 'ftps' ? (
                      <Server className="w-4 h-4 text-gale-teal shrink-0" />
                    ) : (
                      <Database className="w-4 h-4 text-gale-teal shrink-0" />
                    )}
                    <span className="text-sm font-medium truncate">{profile.name}</span>
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
                    className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-red-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
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
          onImportComplete={onImportComplete}
        />
        {appVersion && (
          <div className="text-xs text-zinc-500 metric-text pt-1">
            Galeon v{appVersion}
          </div>
        )}
      </div>
    </div>
  );
};
