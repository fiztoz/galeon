import React, { type Dispatch, type SetStateAction } from 'react';
import { FIELD } from './field';
export interface RemoteFieldsProps {
  host: string;
  setHost: Dispatch<SetStateAction<string>>;
  port: number;
  setPort: Dispatch<SetStateAction<number>>;
  username: string;
  setUsername: Dispatch<SetStateAction<string>>;
  sftpPassword: string;
  setSftpPassword: Dispatch<SetStateAction<string>>;
}
interface RemoteFieldSlots {
  passwordHelp: string;
  beforeFields?: React.ReactNode;
  keyFields?: React.ReactNode;
  afterFields?: React.ReactNode;
}
export function RemoteFields({ host, setHost, port, setPort, username, setUsername, sftpPassword, setSftpPassword, passwordHelp, beforeFields, keyFields, afterFields }: RemoteFieldsProps & RemoteFieldSlots) {
 return (
<>
                {beforeFields}
                <div>
                  <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                    Host
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    required
                    placeholder="e.g., sftp.example.com"
                    className={FIELD}
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                      Port
                    </label>
                    <input
                      type="number"
                      value={port}
                      onChange={(e) => setPort(Number(e.target.value))}
                      className={FIELD}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                      Username
                    </label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                      className={FIELD}
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="mb-3">
                  <label htmlFor="storage-password" className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                    Password
                  </label>
                  <div className="space-y-2">
                    <div>
                      <p className="mb-1 text-xs text-zinc-500">
                        {passwordHelp}
                      </p>
                      <input
                        id="storage-password"
                        type="password"
                        value={sftpPassword}
                        onChange={(e) => setSftpPassword(e.target.value)}
                        placeholder="Enter password"
                        className={FIELD}
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="current-password"
                        spellCheck={false}
                      />
                    </div>
                    {keyFields}
                  </div>
                </div>
                {afterFields}
              </>
 );
}
