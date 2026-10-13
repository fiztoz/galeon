import type { Dispatch, SetStateAction } from 'react';
import { FIELD } from './field';

export interface AzureFieldsProps {
  endpoint: string;
  setEndpoint: Dispatch<SetStateAction<string>>;
  /** Reuses the shared username state for the Azure account name. */
  username: string;
  setUsername: Dispatch<SetStateAction<string>>;
  /** Reuses the shared password state for the Azure account key. */
  sftpPassword: string;
  setSftpPassword: Dispatch<SetStateAction<string>>;
  bucket: string;
  setBucket: Dispatch<SetStateAction<string>>;
}

/**
 * Azure Blob fields. The account name rides the shared `username` state and the
 * account key the shared password state (keyring slot). `bucket` holds the
 * container name. A blank endpoint derives https://&lt;account&gt;.blob.core.windows.net;
 * sovereign clouds type their own.
 */
export function AzureFields({ endpoint, setEndpoint, username, setUsername, sftpPassword, setSftpPassword, bucket, setBucket }: AzureFieldsProps) {
  return (
    <>
      <div>
        <label htmlFor="azure-account" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Account Name
        </label>
        <input
          id="azure-account"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="mystorageaccount"
          className={FIELD}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div>
        <label htmlFor="azure-container" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Container
        </label>
        <input
          id="azure-container"
          type="text"
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="my-container"
          className={FIELD}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div>
        <label htmlFor="azure-key" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Account Key
        </label>
        <input
          id="azure-key"
          type="password"
          value={sftpPassword}
          onChange={(e) => setSftpPassword(e.target.value)}
          placeholder="Base64 account key"
          className={FIELD}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-zinc-500">
          From Azure Portal → Storage account → Access keys → key1 or key2.
        </p>
      </div>
      <div>
        <label htmlFor="azure-endpoint" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Endpoint <span className="font-normal text-zinc-500">(optional)</span>
        </label>
        <input
          id="azure-endpoint"
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://mystorageaccount.blob.core.windows.net"
          className={FIELD}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-zinc-500">
          Leave blank for the public Azure cloud. Azure Stack or Azure China
          users paste their account URL here.
        </p>
      </div>
    </>
  );
}
