import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Lock, Shield, Info, RotateCcw, Key, Sun, Moon, Monitor } from 'lucide-react';
import { THEME_LABELS, THEME_MODES, type ThemeMode } from '../theme';

export interface AppSettings {
  onboardingComplete: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AppMetadata {
  productName: string;
  version: string;
  identifier: string;
  platform: string;
}

export interface CredentialUnlockStatus {
  cachedSecretCount: number;
  unlockedForSession: boolean;
}

export interface CredentialMigrationResult {
  migratedProfileCount: number;
  skippedProfileCount: number;
  missingProfileCount: number;
}

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onShowOnboarding: () => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}

export function SettingsPanel({ open, onClose, onShowOnboarding, themeMode, onThemeModeChange }: SettingsPanelProps) {
  const [metadata, setMetadata] = useState<AppMetadata | null>(null);
  const [credentialStatus, setCredentialStatus] = useState<CredentialUnlockStatus | null>(null);
  const [locking, setLocking] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [migratingCredentials, setMigratingCredentials] = useState(false);
  const [migrationResult, setMigrationResult] = useState<CredentialMigrationResult | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  const refreshStatus = async () => {
    try {
      const [meta, status] = await Promise.all([
        invoke<AppMetadata>('get_app_metadata'),
        invoke<CredentialUnlockStatus>('get_credential_unlock_status'),
      ]);
      setMetadata(meta);
      setCredentialStatus(status);
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  };

  useEffect(() => {
    if (open) refreshStatus();
  }, [open]);

  const handleLockCredentials = async () => {
    setLocking(true);
    try {
      await invoke('lock_credentials_now');
      await refreshStatus();
    } catch (err) {
      console.error('Failed to lock credentials:', err);
    } finally {
      setLocking(false);
    }
  };

  const handleShowOnboarding = async () => {
    setResetting(true);
    try {
      await invoke('reset_onboarding');
      onClose();
      onShowOnboarding();
    } catch (err) {
      console.error('Failed to reset onboarding:', err);
    } finally {
      setResetting(false);
    }
  };

  const handleMigrateCredentials = async () => {
    setMigratingCredentials(true);
    setMigrationResult(null);
    setMigrationError(null);
    try {
      const result = await invoke<CredentialMigrationResult>('migrate_legacy_credentials_to_vault');
      setMigrationResult(result);
      await refreshStatus();
    } catch (err) {
      setMigrationError(String(err));
    } finally {
      setMigratingCredentials(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg max-h-[85vh] shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-100">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto galeon-scrollbar px-6 py-5 space-y-6">
          {/* About */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Info className="w-4 h-4 text-gale-teal" />
              <h3 className="text-sm font-semibold text-zinc-200">About Galeon</h3>
            </div>
            {metadata ? (
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">Product</dt>
                  <dd className="text-zinc-300">{metadata.productName}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">Version</dt>
                  <dd className="text-zinc-300 metric-text">{metadata.version}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">Bundle ID</dt>
                  <dd className="text-zinc-300 tech-text text-xs">{metadata.identifier}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-zinc-500">Platform</dt>
                  <dd className="text-zinc-300 capitalize">{metadata.platform}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-zinc-500">Loading…</p>
            )}
          </section>

          {/* Privacy */}
          <section className="p-4 rounded-lg bg-zinc-950/50 border border-zinc-800">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="w-4 h-4 text-doubloon" />
              <h3 className="text-sm font-semibold text-zinc-200">Privacy</h3>
            </div>
            <p className="text-sm text-zinc-400 leading-relaxed">
              No tracking. No telemetry. No crash reports sent. Galeon connects only to storage
              locations you configure.
            </p>
          </section>

          {/* Credentials */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Lock className="w-4 h-4 text-gale-teal" />
              <h3 className="text-sm font-semibold text-zinc-200">Credentials</h3>
            </div>
            <p className="text-sm text-zinc-400 mb-3 leading-relaxed">
              Saved credentials are protected by your Mac&apos;s secure password system.
            </p>
            <div className="flex items-center justify-between p-3 rounded-lg bg-zinc-950/50 border border-zinc-800">
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wider">Session status</div>
                <div className="text-sm text-zinc-200 mt-0.5">
                  {credentialStatus?.unlockedForSession
                    ? 'Unlocked for this session'
                    : 'Locked'}
                </div>
                {credentialStatus && credentialStatus.cachedSecretCount > 0 && (
                  <div className="text-xs text-zinc-500 mt-0.5">
                    {credentialStatus.cachedSecretCount} profile
                    {credentialStatus.cachedSecretCount === 1 ? '' : 's'} cached in memory
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={handleLockCredentials}
                disabled={locking || !credentialStatus?.unlockedForSession}
                className="px-3 py-1.5 text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                {locking ? 'Locking…' : 'Lock credentials now'}
              </button>
            </div>
            <div className="mt-3 p-3 rounded-lg bg-zinc-950/50 border border-zinc-800">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm text-zinc-200">Legacy Keychain migration</div>
                  <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                    Copy old per-profile credentials into the current vault. macOS may ask for the
                    old items during this one-time migration.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleMigrateCredentials}
                  disabled={migratingCredentials}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none transition-colors whitespace-nowrap"
                >
                  <Key className="w-3.5 h-3.5" />
                  {migratingCredentials ? 'Migrating…' : 'Migrate'}
                </button>
              </div>
              {migrationResult && (
                <div className="mt-3 text-xs text-zinc-500 leading-relaxed">
                  {migrationResult.migratedProfileCount > 0
                    ? `${migrationResult.migratedProfileCount} profile${migrationResult.migratedProfileCount === 1 ? '' : 's'} migrated.`
                    : 'No legacy credentials migrated.'}
                  {migrationResult.skippedProfileCount > 0 && (
                    <span> {migrationResult.skippedProfileCount} already in the vault.</span>
                  )}
                  {migrationResult.missingProfileCount > 0 && (
                    <span> {migrationResult.missingProfileCount} had no old Keychain item.</span>
                  )}
                </div>
              )}
              {migrationError && (
                <div className="mt-3 text-xs text-red-300 leading-relaxed">{migrationError}</div>
              )}
            </div>
          </section>

          {/* Appearance */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <Sun className="w-4 h-4 text-zinc-400" />
              <h3 className="text-sm font-semibold text-zinc-200">Appearance</h3>
            </div>
            <div
              role="radiogroup"
              aria-label="Theme"
              className="inline-flex rounded-lg border border-zinc-700 bg-zinc-950/50 p-1"
            >
              {THEME_MODES.map((mode) => {
                const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
                const selected = mode === themeMode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onThemeModeChange(mode)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors ${
                      selected
                        ? 'bg-gale-teal/15 text-gale-teal'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {THEME_LABELS[mode]}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              System follows your macOS appearance and updates while Galeon is open.
            </p>
          </section>

          {/* Onboarding */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <RotateCcw className="w-4 h-4 text-zinc-400" />
              <h3 className="text-sm font-semibold text-zinc-200">Onboarding</h3>
            </div>
            <button
              type="button"
              onClick={handleShowOnboarding}
              disabled={resetting}
              className="px-4 py-2 text-sm rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 transition-colors"
            >
              {resetting ? 'Resetting…' : 'Show onboarding again'}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
