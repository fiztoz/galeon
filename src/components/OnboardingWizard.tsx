import { useState } from 'react';
import { Database, Shield, WifiOff, Anchor, Server, KeyRound, ChevronRight, ChevronLeft } from 'lucide-react';

export type OnboardingProtocol = 's3' | 'sftp' | 'ftp' | 'ftps';

interface OnboardingWizardProps {
  onComplete: (selectedProtocol?: OnboardingProtocol) => void;
  onSkip: () => void;
}

const STEPS = ['Welcome', 'Choose your isle', 'Secure by default', 'Offline by design', 'Start sailing'] as const;

const ISLE_CARDS: {
  protocol: OnboardingProtocol;
  title: string;
  description: string;
  examples: string;
  icon: typeof Database;
}[] = [
  {
    protocol: 's3',
    title: 'S3-compatible bucket',
    description: 'Object storage with S3 API',
    examples: 'AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2',
    icon: Database,
  },
  {
    protocol: 'sftp',
    title: 'SFTP server',
    description: 'SSH file transfer',
    examples: 'SSH key or password authentication',
    icon: KeyRound,
  },
  {
    protocol: 'ftp',
    title: 'FTP / FTPS host',
    description: 'Traditional file transfer',
    examples: 'FTP or TLS-secured FTPS',
    icon: Server,
  },
];

export function OnboardingWizard({ onComplete, onSkip }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const [selectedProtocol, setSelectedProtocol] = useState<OnboardingProtocol | null>(null);

  const goNext = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const handleCreateProfile = () => {
    onComplete(selectedProtocol ?? undefined);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-950/95 backdrop-blur-sm p-6 macos-traffic-safe">
      <div className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Progress */}
        <div className="px-6 pt-6 pb-2 border-b border-zinc-800/80">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Step {step + 1} of {STEPS.length}
            </span>
            <button
              type="button"
              onClick={onSkip}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Skip for now
            </button>
          </div>
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  i <= step ? 'bg-gale-teal' : 'bg-zinc-800'
                }`}
              />
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto galeon-scrollbar px-8 py-8">
          {step === 0 && (
            <div className="text-center space-y-6">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-abyss/60 border border-gale-teal/20">
                <Anchor className="w-8 h-8 text-gale-teal" />
              </div>
              <div>
                <h1 className="text-4xl font-display font-medium tracking-[0.06em] bg-gradient-to-r from-gale-teal to-doubloon bg-clip-text text-transparent">
                  Galeon
                </h1>
                <p className="mt-2 text-lg text-zinc-300">Sail your cloud.</p>
              </div>
              <p className="text-sm text-zinc-400 max-w-md mx-auto leading-relaxed">
                A fast, lightweight desktop client for S3-compatible storage, SFTP, and FTP/FTPS.
                Connect to the locations you choose — nothing else.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl font-display font-medium text-zinc-100">Choose your isle</h2>
                <p className="mt-2 text-sm text-zinc-400">
                  Pick the storage location Galeon should sail to — an S3 bucket, SFTP server, or FTP host.
                </p>
              </div>
              <div className="grid gap-3">
                {ISLE_CARDS.map((card) => {
                  const Icon = card.icon;
                  const selected = selectedProtocol === card.protocol;
                  return (
                    <button
                      key={card.protocol}
                      type="button"
                      onClick={() => setSelectedProtocol(card.protocol)}
                      className={`w-full text-left p-4 rounded-xl border transition-all ${
                        selected
                          ? 'border-gale-teal/50 bg-abyss/40 ring-1 ring-gale-teal/30'
                          : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700 hover:bg-zinc-800/30'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${selected ? 'text-gale-teal' : 'text-zinc-500'}`} />
                        <div>
                          <div className="font-medium text-zinc-100">{card.title}</div>
                          <div className="text-sm text-zinc-400 mt-0.5">{card.description}</div>
                          <div className="text-xs text-zinc-500 mt-1">{card.examples}</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-zinc-800 border border-zinc-700">
                <Shield className="w-6 h-6 text-gale-teal" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-zinc-100">Secure by default</h2>
                <p className="mt-4 text-sm text-zinc-400 leading-relaxed">
                  Galeon stores saved credentials in your Mac&apos;s secure password system. Access is protected
                  by your Mac login password, Touch ID, or system security settings. Galeon does not have its
                  own master password.
                </p>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-zinc-800 border border-zinc-700">
                <WifiOff className="w-6 h-6 text-doubloon" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-zinc-100">Offline by design</h2>
                <p className="mt-4 text-sm text-zinc-400 leading-relaxed">
                  Galeon is an offline desktop app. It does not track usage, send telemetry, or upload crash
                  reports. It connects only to storage locations you configure.
                </p>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="text-center space-y-6">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-abyss/60 border border-gale-teal/20">
                <Anchor className="w-8 h-8 text-gale-teal" />
              </div>
              <div>
                <h2 className="text-2xl font-display font-medium text-zinc-100">Start sailing</h2>
                <p className="mt-2 text-sm text-zinc-400 max-w-md mx-auto">
                  {selectedProtocol
                    ? `Ready to set up your ${ISLE_CARDS.find((c) => c.protocol === selectedProtocol)?.title.toLowerCase() ?? 'storage'}.`
                    : 'Create your first storage profile, or explore Galeon on your own.'}
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
                <button
                  type="button"
                  onClick={handleCreateProfile}
                  className="px-6 py-2.5 rounded-lg bg-gale-teal text-on-accent font-medium text-sm hover:bg-gale-teal/90 transition-colors"
                >
                  Create first profile
                </button>
                <button
                  type="button"
                  onClick={onSkip}
                  className="px-6 py-2.5 rounded-lg border border-zinc-700 text-zinc-300 text-sm hover:bg-zinc-800 transition-colors"
                >
                  Skip for now
                </button>
              </div>
            </div>
          )}
        </div>

        {step < 4 && (
          <div className="px-8 py-5 border-t border-zinc-800 flex justify-between">
            <button
              type="button"
              onClick={goBack}
              disabled={step === 0}
              className="flex items-center gap-1 px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:pointer-events-none transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
            <button
              type="button"
              onClick={goNext}
              className="flex items-center gap-1 px-5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-100 transition-colors"
            >
              Continue
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}