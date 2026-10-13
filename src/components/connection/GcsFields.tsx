import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import type { Dispatch, SetStateAction } from 'react';
import { FIELD } from './field';

export interface GcsFieldsProps {
  endpoint: string;
  setEndpoint: Dispatch<SetStateAction<string>>;
  bucket: string;
  setBucket: Dispatch<SetStateAction<string>>;
  /** Path to the service-account JSON file. Preferred over pasting the JSON. */
  credentialPath: string;
  setCredentialPath: Dispatch<SetStateAction<string>>;
  /** Reuses the shared password state for pasted JSON contents (optional). */
  sftpPassword: string;
  setSftpPassword: Dispatch<SetStateAction<string>>;
}

/**
 * GCS fields. The service-account JSON path stays on disk (no new secret in
 * the keyring); pasting the JSON instead falls back to the shared password
 * state, which the keyring stores like any other protocol secret. Endpoint is
 * optional — blank uses the default storage.googleapis.com.
 */
export function GcsFields({ endpoint, setEndpoint, bucket, setBucket, credentialPath, setCredentialPath, sftpPassword, setSftpPassword }: GcsFieldsProps) {
  const browseForCredential = async () => {
    try {
      const selected = await openFileDialog({ multiple: false, directory: false });
      if (typeof selected === 'string') setCredentialPath(selected);
    } catch {
      // Dialog dismissed or unavailable — the typed path remains usable.
    }
  };

  return (
    <>
      <div>
        <label htmlFor="gcs-bucket" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Bucket
        </label>
        <input
          id="gcs-bucket"
          type="text"
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="my-bucket"
          className={FIELD}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div>
        <label htmlFor="gcs-credential-path" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Service Account JSON
        </label>
        <div className="flex gap-2">
          <input
            id="gcs-credential-path"
            type="text"
            value={credentialPath}
            onChange={(e) => setCredentialPath(e.target.value)}
            placeholder="/Users/you/keys/gcs-service-account.json"
            className={FIELD}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={browseForCredential}
            className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
          >
            Browse…
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          The key file stays on disk — only its path is saved in the profile.
        </p>
      </div>
      <div>
        <label htmlFor="gcs-credential" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          …or paste the JSON <span className="font-normal text-zinc-500">(stored in the keyring)</span>
        </label>
        <textarea
          id="gcs-credential"
          value={sftpPassword}
          onChange={(e) => setSftpPassword(e.target.value)}
          rows={3}
          placeholder='{"type": "service_account", …}'
          className={FIELD}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div>
        <label htmlFor="gcs-endpoint" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Endpoint <span className="font-normal text-zinc-500">(optional)</span>
        </label>
        <input
          id="gcs-endpoint"
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="storage.googleapis.com"
          className={FIELD}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-zinc-500">
          Leave blank for the public GCS endpoint. Point it at a GCS-compatible
          emulator if you use one.
        </p>
      </div>
    </>
  );
}
