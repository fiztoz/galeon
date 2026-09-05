import React, { type Dispatch, type SetStateAction } from 'react';
import { FIELD } from './field';
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

export function S3Fields({ bucket, setBucket, accessKey, setAccessKey, secretKey, setSecretKey, endpoint, setEndpoint, region, setRegion, dangerDisableSsl, setDangerDisableSsl, showAdvanced, setShowAdvanced, useVirtualHostStyle, setUseVirtualHostStyle, storageClass, setStorageClass, maxBandwidth, setMaxBandwidth, bandwidthRules }: S3FieldsProps) {
  return (
<>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Bucket Name</label>
                  <input type="text" value={bucket} onChange={(e) => setBucket(e.target.value)} required placeholder="e.g. my-bucket" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                  <p className="mt-1 text-xs text-zinc-500">Bucket name (not the full URL)</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Access Key ID</label>
                  <input type="text" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Secret Access Key</label>
                  <input type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Custom Endpoint</label>
                  <input type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="Leave empty for AWS, or https://minio.example.com:9000" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
                  <p className="mt-1 text-xs text-zinc-500">MinIO / R2 / Wasabi: paste the API endpoint URL</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">Region</label>
                    <input type="text" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1 (optional for MinIO)" className={FIELD} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
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
                      <label className="block text-sm font-medium text-zinc-200 mb-1">Storage Class</label>
                      <select
                        value={storageClass}
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
                      <label className="block text-sm font-medium text-zinc-200 mb-1">Bandwidth Limit (KB/s)</label>
                      <input
                        type="number"
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
