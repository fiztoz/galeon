import type { Dispatch, SetStateAction } from 'react';
import { FIELD } from './field';
import { Key, AlertTriangle } from 'lucide-react';
import { SshKeyHelper } from '../SshKeyHelper';
import { SshConfigImport, type SshConfigConnection } from '../SshConfigImport';
import { RemoteFields, type RemoteFieldsProps } from './RemoteFields';
export interface SftpOptions {
  keyPath: string;
  setKeyPath: Dispatch<SetStateAction<string>>;
  showSshHelper: boolean;
  setShowSshHelper: Dispatch<SetStateAction<boolean>>;
  sshConfigNotice: string;
  credsLoading: boolean;
  handleSshConfigSelect: (connection: SshConfigConnection) => void;
}
export function SftpFields({ remote, ssh }: { remote: RemoteFieldsProps; ssh: SftpOptions }) {
  const { keyPath, setKeyPath, showSshHelper, setShowSshHelper, sshConfigNotice, credsLoading, handleSshConfigSelect } = ssh;
  const { sftpPassword } = remote;
  return <RemoteFields {...remote}
    passwordHelp="Default authentication. A password entered here takes precedence over an SSH key."
    beforeFields={(<>
                    <SshConfigImport onSelect={handleSshConfigSelect} />
                    {sshConfigNotice && (
                      <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg text-xs text-amber-200">
                        {sshConfigNotice}
                      </div>
                    )}
                  </>)}
    keyFields={(<>
                    <div className="flex items-center gap-3 text-xs text-zinc-500" aria-hidden="true">
                      <span className="h-px flex-1 bg-zinc-700" />
                      <span>or use an SSH key</span>
                      <span className="h-px flex-1 bg-zinc-700" />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500">SSH Private Key Path</label>
                      <input
                        type="text"
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                        placeholder="/Users/you/.ssh/id_ed25519"
                        className={FIELD}
                        autoCapitalize="off"
                        autoCorrect="off"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    {/* SSH Key Helper */}
                    <button
                      type="button"
                      onClick={() => setShowSshHelper(!showSshHelper)}
                      className="flex items-center space-x-1 text-xs text-gale-teal hover:text-deep-current transition-colors"
                    >
                      <Key className="w-3 h-3" />
                      <span>{showSshHelper ? 'Hide Key Helper' : 'Need an SSH key? Generate one'}</span>
                    </button>
                    {showSshHelper && (
                      <SshKeyHelper
                        onKeyGenerated={(path) => {
                          setKeyPath(path);
                          setShowSshHelper(false);
                        }}
                        onClose={() => setShowSshHelper(false)}
                      />
                    )}
                    </>)}
    afterFields={<>
                {!keyPath && !sftpPassword && !credsLoading && (
                    <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-lg">
                        <div className="flex items-start space-x-2">
                            <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5" />
                            <div>
                                <p className="text-xs text-amber-200 font-medium">Authentication Required</p>
                                <p className="text-xs text-amber-400/80 mt-1">
                                    Enter a password, or choose an SSH key if this server does not allow password login.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
</>}
  />;
}
