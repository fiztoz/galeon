import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save, open } from '@tauri-apps/plugin-dialog';
import { ConnectionProfile } from '../App';
import { AlertTriangle, Download, Upload } from 'lucide-react';

interface ProfileImportResult {
  imported: number;
  skipped: number;
  renamed: number;
  overwritten: number;
  totalInFile: number;
  messages: string[];
}

interface ProfileImportPreview {
  includesSecrets: boolean;
  total: number;
  profileNames: string[];
  dangerSslBypassCount: number;
  profilesWithSecrets: number;
  contentHash: string;
}

type CollisionStrategy = 'skip' | 'overwrite' | 'rename';

/** Modal + in-flight state for export/import (avoids a boolean soup). */
type IoState =
  | { kind: 'idle' }
  | {
      kind: 'export';
      scope: 'all' | 'selected';
      includeSecrets: boolean;
      busy: boolean;
      error: string;
    }
  | {
      kind: 'import';
      phase: 'options' | 'secrets';
      strategy: CollisionStrategy;
      path?: string;
      preview?: ProfileImportPreview;
      busy: boolean;
      error: string;
    };

interface StatusBanner {
  message: string;
  details: string[];
}

export interface ProfileImportExportProps {
  profiles: ConnectionProfile[];
  selectedProfileId: string | null;
  onReloadProfiles?: () => Promise<void>;
  /** Parent clears form after import so stale fields cannot clobber imported profiles. */
  onImportComplete?: () => void;
}

const formatImportMessage = (result: ProfileImportResult): string => {
  const parts: string[] = [];
  if (result.imported > 0) parts.push(`${result.imported} new`);
  if (result.overwritten > 0) parts.push(`${result.overwritten} overwritten`);
  if (result.renamed > 0) parts.push(`${result.renamed} renamed`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  if (parts.length === 0) {
    return `No profiles applied (${result.totalInFile} in file).`;
  }
  return `Imported ${parts.join(', ')} (${result.totalInFile} in file).`;
};

export const ProfileImportExport: React.FC<ProfileImportExportProps> = ({
  profiles,
  selectedProfileId,
  onReloadProfiles,
  onImportComplete,
}) => {
  const [io, setIo] = useState<IoState>({ kind: 'idle' });
  const [banner, setBanner] = useState<StatusBanner | null>(null);

  const openExportModal = () => {
    setIo({
      kind: 'export',
      scope: selectedProfileId ? 'selected' : 'all',
      includeSecrets: false,
      busy: false,
      error: '',
    });
  };

  const openImportModal = () => {
    setBanner(null);
    setIo({
      kind: 'import',
      phase: 'options',
      strategy: 'rename',
      busy: false,
      error: '',
    });
  };

  const closeModal = () => {
    if (io.kind !== 'idle' && io.busy) return;
    setIo({ kind: 'idle' });
  };

  const handleExportProfiles = async () => {
    if (io.kind !== 'export') return;

    if (profiles.length === 0) {
      setIo({ ...io, error: 'No profiles to export.' });
      return;
    }
    if (io.scope === 'selected' && !selectedProfileId) {
      setIo({ ...io, error: 'Select a profile to export, or choose All profiles.' });
      return;
    }

    const { scope, includeSecrets } = io;
    setIo({ ...io, busy: true, error: '' });
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const defaultName =
        scope === 'selected' && selectedProfileId
          ? `galeon-profile-${stamp}.json`
          : `galeon-profiles-${stamp}.json`;
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: 'JSON', extensions: ['json'] }],
        title: 'Export connection profiles',
      });
      if (!path) {
        setIo((prev) => (prev.kind === 'export' ? { ...prev, busy: false } : prev));
        return;
      }

      await invoke('export_profiles', {
        path,
        profileIds: scope === 'selected' && selectedProfileId ? [selectedProfileId] : null,
        includeSecrets,
      });
      setIo({ kind: 'idle' });
      setBanner({
        message: includeSecrets
          ? 'Profiles exported (includes secrets — handle the file carefully).'
          : 'Profiles exported (metadata only; secrets not included).',
        details: [],
      });
    } catch (err: unknown) {
      setIo((prev) =>
        prev.kind === 'export' ? { ...prev, busy: false, error: String(err) } : prev
      );
    }
  };

  const applyImportResult = async (result: ProfileImportResult) => {
    if (onReloadProfiles) {
      await onReloadProfiles();
    }
    onImportComplete?.();

    setBanner({
      message: formatImportMessage(result),
      details: (result.messages || []).slice(0, 8),
    });
    setIo({ kind: 'idle' });
  };

  const runImport = async (
    path: string,
    strategy: CollisionStrategy,
    confirmSecrets: boolean,
    contentHash?: string | null,
  ) => {
    try {
      const result = await invoke<ProfileImportResult>('import_profiles', {
        path,
        collisionStrategy: strategy,
        confirmSecrets,
        expectedContentHash: contentHash ?? null,
      });
      await applyImportResult(result);
    } catch (err: unknown) {
      // Config may still have been mutated in rare partial-failure paths; reload list.
      if (onReloadProfiles) {
        try {
          await onReloadProfiles();
        } catch {
          /* ignore reload errors */
        }
      }
      onImportComplete?.();
      throw err;
    }
  };

  const handleImportProfiles = async () => {
    if (io.kind !== 'import') return;

    const { strategy, path: pendingPath, preview } = io;
    setIo({ ...io, busy: true, error: '' });
    try {
      // If user already confirmed secrets for a pending file, finish that import.
      if (pendingPath && preview && io.phase === 'secrets') {
        await runImport(pendingPath, strategy, true, preview.contentHash);
        return;
      }

      const selected = await open({
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
        title: 'Import connection profiles',
      });
      if (!selected || Array.isArray(selected)) {
        setIo((prev) => (prev.kind === 'import' ? { ...prev, busy: false } : prev));
        return;
      }

      const nextPreview = await invoke<ProfileImportPreview>('preview_profile_import', {
        path: selected,
      });

      if (nextPreview.includesSecrets) {
        setIo({
          kind: 'import',
          phase: 'secrets',
          strategy,
          path: selected,
          preview: nextPreview,
          busy: false,
          error: '',
        });
        return;
      }

      await runImport(selected, strategy, false, nextPreview.contentHash);
    } catch (err: unknown) {
      setIo((prev) =>
        prev.kind === 'import' ? { ...prev, busy: false, error: String(err) } : prev
      );
    }
  };

  const exportBusy = io.kind === 'export' && io.busy;
  const importBusy = io.kind === 'import' && io.busy;
  const secretsPhase = io.kind === 'import' && io.phase === 'secrets';

  return (
    <>
      <div className="space-y-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={openExportModal}
            disabled={profiles.length === 0}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Export profiles to JSON"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          <button
            type="button"
            onClick={openImportModal}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
            title="Import profiles from JSON"
          >
            <Upload className="w-3.5 h-3.5" />
            Import
          </button>
        </div>
        {banner && (
          <div className="space-y-1">
            <p className="text-[11px] text-emerald-400/90 leading-snug">{banner.message}</p>
            {banner.details.length > 0 && (
              <ul className="text-[10px] text-zinc-500 space-y-0.5 max-h-20 overflow-y-auto">
                {banner.details.map((msg, i) => (
                  <li key={`${i}-${msg.slice(0, 24)}`} className="truncate" title={msg}>
                    {msg}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Export Profiles Modal */}
      {io.kind === 'export' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-[26rem] max-w-[95vw] shadow-2xl">
            <h3 className="text-lg font-semibold mb-1">Export profiles</h3>
            <p className="text-xs text-zinc-500 mb-4">
              Share connection settings across machines. Secrets are omitted by default.
            </p>

            {io.error && (
              <div className="p-3 mb-4 text-sm bg-red-950/50 border border-red-800 text-red-200 rounded-lg">
                {io.error}
              </div>
            )}

            <div className="space-y-3 mb-4">
              <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                Scope
              </label>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                  <input
                    type="radio"
                    name="exportScope"
                    checked={io.scope === 'all'}
                    onChange={() => setIo({ ...io, scope: 'all' })}
                    className="text-gale-teal bg-zinc-800 border-zinc-600 focus:ring-gale-teal"
                  />
                  All profiles ({profiles.length})
                </label>
                <label
                  className={`flex items-center gap-2 text-sm cursor-pointer ${
                    selectedProfileId ? 'text-zinc-300' : 'text-zinc-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="exportScope"
                    checked={io.scope === 'selected'}
                    onChange={() => setIo({ ...io, scope: 'selected' })}
                    disabled={!selectedProfileId}
                    className="text-gale-teal bg-zinc-800 border-zinc-600 focus:ring-gale-teal"
                  />
                  Selected only
                  {selectedProfileId
                    ? ` (${profiles.find((p) => p.id === selectedProfileId)?.name ?? 'profile'})`
                    : ' (select a profile first)'}
                </label>
              </div>

              <label className="flex items-start gap-2 text-sm text-zinc-300 cursor-pointer pt-2">
                <input
                  type="checkbox"
                  checked={io.includeSecrets}
                  onChange={(e) => setIo({ ...io, includeSecrets: e.target.checked })}
                  className="mt-0.5 w-4 h-4 text-gale-teal bg-zinc-800 border-zinc-600 rounded focus:ring-gale-teal"
                />
                <span>
                  Include secrets (access keys / passwords)
                  <span className="block text-xs text-amber-400/90 mt-1">
                    Warning: the file will contain plaintext credentials. Only share it over a
                    trusted channel and delete it when done.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={exportBusy}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExportProfiles}
                disabled={exportBusy || profiles.length === 0}
                className="px-4 py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {exportBusy ? 'Exporting…' : 'Choose file…'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Profiles Modal */}
      {io.kind === 'import' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-[26rem] max-w-[95vw] shadow-2xl">
            <h3 className="text-lg font-semibold mb-1">
              {secretsPhase ? 'Confirm secret import' : 'Import profiles'}
            </h3>
            <p className="text-xs text-zinc-500 mb-4">
              {secretsPhase
                ? 'This file contains credentials. Confirm to store them in the system keyring.'
                : 'Load a Galeon profile export JSON. Secrets (if present) require a second confirmation.'}
            </p>

            {io.error && (
              <div className="p-3 mb-4 text-sm bg-red-950/50 border border-red-800 text-red-200 rounded-lg">
                {io.error}
              </div>
            )}

            {secretsPhase && io.preview ? (
              <div className="mb-4 space-y-3">
                <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                    <div className="text-xs text-amber-200/90 space-y-1">
                      <p className="font-medium text-amber-200">
                        {io.preview.profilesWithSecrets} of {io.preview.total} profile
                        {io.preview.total === 1 ? '' : 's'} include secrets
                      </p>
                      <p>Only import files from people and machines you trust.</p>
                      {io.preview.dangerSslBypassCount > 0 && (
                        <p>
                          {io.preview.dangerSslBypassCount} profile
                          {io.preview.dangerSslBypassCount === 1 ? '' : 's'} had SSL verify
                          disabled; bypass will be cleared on import.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                    Profiles
                  </p>
                  <ul className="text-sm text-zinc-300 max-h-32 overflow-y-auto space-y-0.5">
                    {io.preview.profileNames.slice(0, 20).map((name, i) => (
                      <li key={`${i}-${name}`} className="truncate">
                        • {name}
                      </li>
                    ))}
                    {io.preview.profileNames.length > 20 && (
                      <li className="text-zinc-500 text-xs">
                        …and {io.preview.profileNames.length - 20} more
                      </li>
                    )}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="mb-4 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                    On name conflict
                  </label>
                  <select
                    value={io.strategy}
                    onChange={(e) =>
                      setIo({ ...io, strategy: e.target.value as CollisionStrategy })
                    }
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal"
                  >
                    <option value="rename">Rename imported (recommended)</option>
                    <option value="skip">Skip existing names</option>
                    <option value="overwrite">Overwrite existing</option>
                  </select>
                </div>
                {io.strategy === 'overwrite' && (
                  <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg text-xs text-amber-200/90">
                    Overwrite keeps the existing profile id. If the file has no secrets and the
                    connection target (host/endpoint/bucket/protocol) changes, saved credentials
                    for that profile are cleared so they are not reused against a new target.
                    Secrets in the file replace keyring entries.
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={importBusy}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              {secretsPhase ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setIo({
                        kind: 'import',
                        phase: 'options',
                        strategy: io.strategy,
                        busy: false,
                        error: '',
                      })
                    }
                    disabled={importBusy}
                    className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleImportProfiles}
                    disabled={importBusy}
                    className="px-4 py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {importBusy ? 'Importing…' : 'Import with secrets'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleImportProfiles}
                  disabled={importBusy}
                  className="px-4 py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {importBusy ? 'Importing…' : 'Choose file…'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
