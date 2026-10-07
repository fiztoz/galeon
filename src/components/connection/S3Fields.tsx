import { ChevronRight } from 'lucide-react';
import { Autocomplete } from '../Autocomplete';
import { Select } from '../Select';
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
      <section className="connection-section" aria-labelledby="s3-destination-heading">
        <h2 id="s3-destination-heading" className="connection-section-title">Destination</h2>
        <div className="connection-grid">
          <div>
            <label htmlFor="s3-provider" className="connection-label">Provider</label>
            <Select id="s3-provider" value={provider} onValueChange={(value) => pickProvider(value as S3ProviderId)} className={FIELD}>
              {S3_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="s3-region" className="connection-label">Region</label>
            <Autocomplete id="s3-region" type="text" value={region} onValueChange={onPresetRegion} options={active.regionOptions ?? []} placeholder={active.regionPlaceholder} className={FIELD} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
          {active.needsAccountId && (
            <div className="connection-grid-full">
              <label htmlFor="s3-account" className="connection-label">Account ID</label>
              <input id="s3-account" type="text" value={accountId} onChange={(e) => onAccountId(e.target.value)} placeholder="R2 account ID" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
            </div>
          )}
          <div>
            <label htmlFor="s3-bucket" className="connection-label">Bucket name</label>
            <input id="s3-bucket" type="text" value={bucket} onChange={(e) => setBucket(e.target.value)} required placeholder="my-bucket" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label htmlFor="s3-endpoint" className="connection-label">Endpoint {provider === 'aws' && <span>optional</span>}</label>
            <input id="s3-endpoint" type="text" value={endpoint} onChange={(e) => updateEndpoint(e.target.value, provider, selectionForEndpoint(e.target.value).accountId)} placeholder={active.endpointPlaceholder} className={FIELD} aria-describedby="s3-provider-help" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
          </div>
        </div>
        <p id="s3-provider-help" className="connection-help">{active.help}</p>
      </section>

      <section className="connection-section" aria-labelledby="s3-credentials-heading">
        <h2 id="s3-credentials-heading" className="connection-section-title">Credentials</h2>
        <div className="connection-grid">
          <div>
            <label htmlFor="s3-access-key" className="connection-label">Access key ID</label>
            <input id="s3-access-key" type="text" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label htmlFor="s3-secret-key" className="connection-label">Secret access key</label>
            <input id="s3-secret-key" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
          </div>
        </div>
      </section>

      <div className="connection-section">
        <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} aria-expanded={showAdvanced} aria-controls="s3-advanced" className="connection-disclosure">
          <ChevronRight size={14} aria-hidden="true" className={`shrink-0 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
          <span>Advanced options</span>
          <span className="connection-disclosure-hint">TLS, storage & bandwidth</span>
        </button>
        {dangerDisableSsl && <p role="status" className="mt-2 text-xs text-status-warning">TLS certificate verification is disabled for this connection.</p>}
        {showAdvanced && (
          <div id="s3-advanced" className="connection-advanced space-y-4">
            <div>
              <label htmlFor="disable-ssl" className="flex items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" id="disable-ssl" checked={dangerDisableSsl} onChange={(e) => setDangerDisableSsl(e.target.checked)} aria-describedby="disable-ssl-help" />
                Disable TLS certificate verification
              </label>
              <p id="disable-ssl-help" className="connection-help">Only for trusted servers with self-signed certificates.</p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <span className="text-xs font-medium text-zinc-200">Virtual host style</span>
                <p className="connection-help">Use bucket.endpoint.com URLs</p>
              </div>
              <button type="button" onClick={() => setUseVirtualHostStyle(!useVirtualHostStyle)} role="switch" aria-label="Virtual host style" aria-checked={useVirtualHostStyle} className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${useVirtualHostStyle ? 'bg-gale-teal' : 'bg-zinc-700'}`}>
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${useVirtualHostStyle ? 'translate-x-4.5' : 'translate-x-1'}`} />
              </button>
            </div>
            <div className="connection-grid">
              <div>
                <label htmlFor="s3-storage-class" className="connection-label">Storage class</label>
                <Select id="s3-storage-class" value={storageClass} onValueChange={setStorageClass} className={FIELD}>
                  <option value="STANDARD">Standard</option>
                  <option value="REDUCED_REDUNDANCY">Reduced Redundancy</option>
                  <option value="STANDARD_IA">Standard-IA</option>
                  <option value="ONEZONE_IA">One Zone-IA</option>
                  <option value="INTELLIGENT_TIERING">Intelligent-Tiering</option>
                  <option value="GLACIER">Glacier</option>
                  <option value="GLACIER_DEEP_ARCHIVE">Glacier Deep Archive</option>
                </Select>
              </div>
              <div>
                <label htmlFor="s3-bandwidth" className="connection-label">Bandwidth limit <span>KB/s</span></label>
                <input id="s3-bandwidth" type="number" min="0" placeholder="Unlimited" value={maxBandwidth} onChange={(e) => setMaxBandwidth(e.target.value ? Number(e.target.value) : '')} className={FIELD} />
              </div>
            </div>
            {bandwidthRules}
          </div>
        )}
      </div>
    </>
  );
}
