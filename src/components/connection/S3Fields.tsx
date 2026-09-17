import React, { useState, type Dispatch, type SetStateAction } from 'react';
import { FIELD } from './field';
import { S3_PRESETS, endpointForPreset, guessPreset, type S3ProviderId } from './presets';
export interface S3FieldsProps {
  bucket: string;
  setBucket: Dispatch<SetStateAction<string>>;
  accessKey: string;
  setAccessKey: Dispatch<SetStateAction<string>>;
  secretKey: string;
  setSecretKey: Dispatch<SetStateAction<string>>;
  endpoint: string;
  setEndpoint: Dispatch<SetStateAction<string>>;
  region: string;
  setRegion: Dispatch<SetStateAction<string>>;
  dangerDisableSsl: boolean;
  setDangerDisableSsl: Dispatch<SetStateAction<boolean>>;
  showAdvanced: boolean;
  setShowAdvanced: Dispatch<SetStateAction<boolean>>;
  useVirtualHostStyle: boolean;
  setUseVirtualHostStyle: Dispatch<SetStateAction<boolean>>;
  storageClass: string;
  setStorageClass: Dispatch<SetStateAction<string>>;
  maxBandwidth: number | '';
  setMaxBandwidth: Dispatch<SetStateAction<number | ''>>;
  bandwidthRules: React.ReactNode;
}

function selectionForEndpoint(endpoint: string) {
  const provider = guessPreset(endpoint);
  let accountId = '';
  if (provider === 'r2') {
    try {
      accountId = new URL(endpoint).hostname.match(/^([^.]+)\.r2\.cloudflarestorage\.com$/)?.[1] ?? '';
    } catch {
      // Incomplete manually entered endpoints have no account ID yet.
    }
  }
  return { endpoint, provider, accountId };
}

export function S3Fields({ bucket, setBucket, accessKey, setAccessKey, secretKey, setSecretKey, endpoint, setEndpoint, region, setRegion, dangerDisableSsl, setDangerDisableSsl, showAdvanced, setShowAdvanced, useVirtualHostStyle, setUseVirtualHostStyle, storageClass, setStorageClass, maxBandwidth, setMaxBandwidth, bandwidthRules }: S3FieldsProps) {
  const [selection, setSelection] = useState(() => selectionForEndpoint(endpoint));
  // A profile load changes the parent-owned endpoint. Infer its presentation
  // without applying defaults over the profile's region or URL-style settings.
  const current = selection.endpoint === endpoint ? selection : selectionForEndpoint(endpoint);
  if (current !== selection) setSelection(current);
  const { provider, accountId } = current;
  const active = S3_PRESETS.find((p) => p.id === provider) ?? S3_PRESETS[0];

  const updateEndpoint = (value: string, nextProvider = provider, nextAccountId = accountId) => {
    // Remember our own edits so they do not look like a profile load on render.
    setSelection({ endpoint: value, provider: nextProvider, accountId: nextAccountId });
    setEndpoint(value);
  };

  const pickProvider = (id: S3ProviderId) => {
    const preset = S3_PRESETS.find((p) => p.id === id) ?? S3_PRESETS[0];
    // Custom never clobbers what the user typed; every other preset applies
    // its conventions (endpoint template, region, URL style) in one move.
    if (preset.id === 'custom') {
      setSelection({ ...current, provider: id });
      return;
    }
    setRegion(preset.defaultRegion);
    setUseVirtualHostStyle(preset.useVirtualHostStyle);
    if (preset.id === 'r2') {
      updateEndpoint(endpointForPreset(preset, { accountId }), id);
    } else {
      const built = endpointForPreset(preset, { region: preset.defaultRegion });
      // AWS uses an empty endpoint (SDK default); others prefill the template.
      updateEndpoint(built, id);
    }
  };

  const onAccountId = (value: string) => {
    if (active.id === 'r2') {
      updateEndpoint(endpointForPreset(active, { accountId: value }), provider, value);
    }
  };

  const onPresetRegion = (value: string) => {
    setRegion(value);
    // Keep derived endpoints in sync when the region drives the hostname.
    if (active.id === 'b2' || active.id === 'wasabi' || active.id === 'spaces') {
      updateEndpoint(endpointForPreset(active, { region: value }));
    }
  };

  return (
<>
                <div>
                  <label htmlFor="s3-provider" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Provider</label>
                  <select id="s3-provider" value={provider} onChange={(e) => pickProvider(e.target.value as S3ProviderId)} className={FIELD}>
                    {S3_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-zinc-500">{active.help}</p>
                </div>
                {active.needsAccountId && (
                  <div>
                    <label htmlFor="s3-account" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Account ID</label>
                    <input id="s3-account" type="text" value={accountId} onChange={(e) => onAccountId(e.target.value)} placeholder="R2 account ID" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                  </div>
                )}
                <div>
                  <label htmlFor="s3-bucket" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Bucket Name</label>
                  <input id="s3-bucket" type="text" value={bucket} onChange={(e) => setBucket(e.target.value)} required placeholder="e.g. my-bucket" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                  <p className="mt-1 text-xs text-zinc-500">Bucket name (not the full URL)</p>
                </div>
                <div>
                  <label htmlFor="s3-access-key" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Access Key ID</label>
                  <input id="s3-access-key" type="text" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                </div>
                <div>
                  <label htmlFor="s3-secret-key" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Secret Access Key</label>
                  <input id="s3-secret-key" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                </div>
                <div>
                  <label htmlFor="s3-endpoint" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Custom Endpoint</label>
                  <input id="s3-endpoint" type="text" value={endpoint} onChange={(e) => updateEndpoint(e.target.value, provider, selectionForEndpoint(e.target.value).accountId)} placeholder={active.endpointPlaceholder} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                  <p className="mt-1 text-xs text-zinc-500">MinIO / R2 / Wasabi: paste the API endpoint URL</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="s3-region" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Region</label>
                    <input id="s3-region" type="text" value={region} onChange={(e) => onPresetRegion(e.target.value)} list={active.regionOptions ? 's3-region-options' : undefined} placeholder={active.regionPlaceholder} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                    {active.regionOptions && (
                      <datalist id="s3-region-options">
                        {active.regionOptions.map((r) => (
                          <option key={r} value={r} />
                        ))}
                      </datalist>
                    )}
                  </div>
                  <div className="flex items-end pb-2">
                    <div className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        id="disable-ssl"
                        checked={dangerDisableSsl}
                        onChange={(e) => setDangerDisableSsl(e.target.checked)}
                        className="w-4 h-4 text-yellow-500 bg-zinc-800 border-zinc-600 rounded focus:ring-yellow-500"
                      />
                      <label htmlFor="disable-ssl" className="text-xs text-zinc-400">
                        Disable SSL Verify
                        {dangerDisableSsl && (
                          <span className="ml-1 text-yellow-500">(self-signed OK)</span>
                        )}
                      </label>
                    </div>
                  </div>
                </div>

                {/* Advanced Settings Toggle */}
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  aria-expanded={showAdvanced}
                  className="flex items-center space-x-2 text-xs text-zinc-400 hover:text-zinc-200"
                >
                  <span>{showAdvanced ? '▼' : '▶'}</span>
                  <span>Advanced S3 Options</span>
                </button>

                {/* Advanced Settings Panel */}
                {showAdvanced && (
                  <div className="p-4 bg-zinc-800/50 rounded-lg border border-zinc-700 space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-sm font-medium text-zinc-200">Virtual Host Style</label>
                        <p className="text-xs text-zinc-500">Use bucket.endpoint.com style URLs</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setUseVirtualHostStyle(!useVirtualHostStyle)}
                        role="switch"
                        aria-label="Virtual host style"
                        aria-checked={useVirtualHostStyle}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          useVirtualHostStyle ? 'bg-gale-teal' : 'bg-zinc-700'
                        }`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          useVirtualHostStyle ? 'translate-x-6' : 'translate-x-1'
                        }`} />
                      </button>
                    </div>

                    <div>
                      <label htmlFor="s3-storage-class" className="block text-sm font-medium text-zinc-200 mb-1">Storage Class</label>
                      <select
 id="s3-storage-class"                        value={storageClass}
                        onChange={(e) => setStorageClass(e.target.value)}
                        className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all"
                      >
                        <option value="STANDARD">Standard</option>
                        <option value="REDUCED_REDUNDANCY">Reduced Redundancy</option>
                        <option value="STANDARD_IA">Standard-IA</option>
                        <option value="ONEZONE_IA">One Zone-IA</option>
                        <option value="INTELLIGENT_TIERING">Intelligent-Tiering</option>
                        <option value="GLACIER">Glacier</option>
                        <option value="GLACIER_DEEP_ARCHIVE">Glacier Deep Archive</option>
                      </select>
                    </div>

                    <div>
                      <label htmlFor="s3-bandwidth" className="block text-sm font-medium text-zinc-200 mb-1">Bandwidth Limit (KB/s)</label>
                      <input
 id="s3-bandwidth"                        type="number"
                        min="0"
                        placeholder="Unlimited"
                        value={maxBandwidth}
                        onChange={(e) => setMaxBandwidth(e.target.value ? Number(e.target.value) : '')}
                        className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all placeholder:text-zinc-500"
                      />
                      <p className="mt-1 text-xs text-zinc-500">Leave blank for unlimited speed</p>
                    </div>

                    {bandwidthRules}
                  </div>
                )}
              </>
  );
}
