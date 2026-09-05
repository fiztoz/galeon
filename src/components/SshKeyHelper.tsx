import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Key, Copy, Check, AlertTriangle } from 'lucide-react';

interface SshKeyHelperProps {
    onKeyGenerated?: (keyPath: string) => void;
    onClose?: () => void;
}

export const SshKeyHelper: React.FC<SshKeyHelperProps> = ({ onKeyGenerated, onClose }) => {
    const [step, setStep] = useState<'intro' | 'generating' | 'complete' | 'error'>('intro');
    const [keyPath, setKeyPath] = useState('~/.ssh/id_ed25519_galeon');
    const [publicKey, setPublicKey] = useState('');
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);
    
    const handleGenerateKey = async () => {
        setStep('generating');
        setError('');
        
        try {
            const result = await invoke<{ privateKey: string; publicKey: string }>('generate_ssh_key', {
                keyPath: keyPath.replace('~', await invoke('get_home_dir')),
            });
            setPublicKey(result.publicKey);
            setStep('complete');
        } catch (err: any) {
            setError(String(err));
            setStep('error');
        }
    };
    
    const handleCopyPublicKey = async () => {
        try {
            await navigator.clipboard.writeText(publicKey);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };
    
    const handleUseKey = () => {
        onKeyGenerated?.(keyPath);
        onClose?.();
    };
    
    return (
        <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-4">
            {step === 'intro' && (
                <>
                    <div className="flex items-center space-x-2 mb-3">
                        <Key className="w-5 h-5 text-gale-teal" />
                        <h4 className="text-sm font-semibold text-zinc-200">SSH Key Helper</h4>
                    </div>
                    <p className="text-xs text-zinc-400 mb-3">
                        Generate an SSH key pair for secure SFTP authentication.
                    </p>
                    <div className="mb-3">
                        <label className="block text-xs text-zinc-500 mb-1">Key file path</label>
                        <input
                            type="text"
                            value={keyPath}
                            onChange={(e) => setKeyPath(e.target.value)}
                            className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100"
                            placeholder="~/.ssh/id_ed25519_galeon"
                        />
                    </div>
                    <button
                        onClick={handleGenerateKey}
                        className="w-full py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded text-sm font-semibold transition-all shadow-sm"
                    >
                        Generate Key Pair
                    </button>
                </>
            )}
            
            {step === 'generating' && (
                <div className="text-center py-4">
                    <div className="animate-spin w-6 h-6 border-2 border-gale-teal border-t-transparent rounded-full mx-auto mb-2" />
                    <p className="text-xs text-zinc-400">Generating SSH key pair...</p>
                </div>
            )}
            
            {step === 'complete' && (
                <>
                    <div className="flex items-center space-x-2 mb-3">
                        <Check className="w-5 h-5 text-green-400" />
                        <h4 className="text-sm font-semibold text-zinc-200">Key Generated!</h4>
                    </div>
                    <div className="mb-3">
                        <label className="block text-xs text-zinc-500 mb-1">Your public key (copy this to server)</label>
                        <div className="relative">
                            <textarea
                                value={publicKey}
                                readOnly
                                className="w-full h-20 px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-xs text-zinc-300 font-mono"
                            />
                            <button
                                onClick={handleCopyPublicKey}
                                className="absolute top-2 right-2 p-1 hover:bg-zinc-800 rounded"
                            >
                                {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-zinc-400" />}
                            </button>
                        </div>
                    </div>
                    <div className="bg-zinc-900/50 rounded p-3 mb-3">
                        <p className="text-xs text-zinc-400 mb-2">Next steps:</p>
                        <ol className="text-xs text-zinc-500 space-y-1 list-decimal list-inside">
                            <li>Copy the public key above</li>
                            <li>Add it to your server's <code className="text-gale-teal font-mono text-xs">~/.ssh/authorized_keys</code></li>
                            <li>Click "Use This Key" below</li>
                        </ol>
                    </div>
                    <div className="flex space-x-2">
                        <button
                            onClick={handleCopyPublicKey}
                            className="flex-1 py-2 bg-raised hover:bg-raised-hover rounded text-sm"
                        >
                            {copied ? 'Copied!' : 'Copy Public Key'}
                        </button>
                        <button
                            onClick={handleUseKey}
                            className="flex-1 py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded text-sm font-semibold transition-colors"
                        >
                            Use This Key
                        </button>
                    </div>
                </>
            )}
            
            {step === 'error' && (
                <>
                    <div className="flex items-center space-x-2 mb-3">
                        <AlertTriangle className="w-5 h-5 text-red-400" />
                        <h4 className="text-sm font-semibold text-zinc-200">Error</h4>
                    </div>
                    <p className="text-xs text-red-400 mb-3">{error}</p>
                    <div className="flex space-x-2">
                        <button
                            onClick={() => setStep('intro')}
                            className="flex-1 py-2 bg-raised hover:bg-raised-hover rounded text-sm"
                        >
                            Try Again
                        </button>
                        <button
                            onClick={onClose}
                            className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm"
                        >
                            Cancel
                        </button>
                    </div>
                </>
            )}
        </div>
    );
};
