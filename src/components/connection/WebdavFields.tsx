import type { Dispatch, SetStateAction } from 'react';
import { FIELD } from './field';

export interface WebdavFieldsProps {
  endpoint: string;
  setEndpoint: Dispatch<SetStateAction<string>>;
  username: string;
  setUsername: Dispatch<SetStateAction<string>>;
  sftpPassword: string;
  setSftpPassword: Dispatch<SetStateAction<string>>;
}

/**
 * WebDAV fields (Nextcloud/ownCloud, NAS boxes, shared hosting). Endpoint-first
 * like S3 — WebDAV servers live under a URL path, so a host/port pair cannot
 * express the root. `username`/`sftpPassword` map to the shared remote auth
 * state; an empty pair connects anonymously.
 */
export function WebdavFields({ endpoint, setEndpoint, username, setUsername, sftpPassword, setSftpPassword }: WebdavFieldsProps) {
  return (
    <>
      <div>
        <label htmlFor="webdav-endpoint" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          WebDAV Server URL
        </label>
        <input
          id="webdav-endpoint"
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://cloud.example.com/remote.php/dav/files/you"
          className={FIELD}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-zinc-500">
          The full WebDAV or DAV root URL, including its path. The scheme is added
          automatically if you paste a bare host.
        </p>
      </div>
      <div>
        <label htmlFor="webdav-username" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Username
        </label>
        <input
          id="webdav-username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="you"
          className={FIELD}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div>
        <label htmlFor="webdav-password" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
          Password
        </label>
        <input
          id="webdav-password"
          type="password"
          value={sftpPassword}
          onChange={(e) => setSftpPassword(e.target.value)}
          placeholder="Enter password"
          className={FIELD}
          autoCapitalize="off"
          autoComplete="current-password"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-zinc-500">
          Leave the username and password empty for a public WebDAV share.
        </p>
      </div>
    </>
  );
}
