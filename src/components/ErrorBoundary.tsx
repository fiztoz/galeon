import React from 'react';

/**
 * Catches render-time throws so a bad listing or a malformed profile cannot
 * leave the user staring at a blank window with no way back.
 *
 * Deliberately says nothing about the error's contents on screen: Galeon holds
 * credentials, and an OpenDAL or keyring error string can carry endpoint or
 * account detail. The message states what happened and what to try (DESIGN.md:
 * "state what happened and what to try"), and the details stay behind a
 * deliberate "copy details" so a user can report them if they choose.
 */

interface ErrorBoundaryState {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the console trail for anyone with devtools open.
    console.error('Uncaught render error:', error, info.componentStack);
    this.setState({ info: info.componentStack ?? '' });
  }

  private reset = () => {
    this.setState({ error: null, info: '' });
  };

  private reload = () => {
    window.location.reload();
  };

  private copyDetails = () => {
    const { error, info } = this.state;
    if (!error) return;
    const text = [`${error.name}: ${error.message}`, '', info].join('\n');
    navigator.clipboard?.writeText(text).catch(() => {
      /* Clipboard can be unavailable; the console still has the stack. */
    });
  };

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex items-center justify-center min-h-screen p-8 bg-zinc-950">
        <div className="w-full max-w-md rounded-lg border border-status-danger/30 bg-status-danger/10 p-6">
          <h1 className="text-base font-semibold text-zinc-100">Galeon hit an unexpected error</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Something in the interface failed to render. Your profiles and saved credentials are
            untouched on disk.
          </p>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded-lg bg-gale-teal px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-deep-current hover:text-white"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.reload}
              className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            >
              Reload window
            </button>
            <button
              type="button"
              onClick={this.copyDetails}
              className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
            >
              Copy details
            </button>
          </div>

          <details className="mt-4 text-xs text-zinc-500">
            <summary className="cursor-pointer select-none">Error details</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-900 p-2 text-[11px] text-zinc-400">
              {error.name}: {error.message}
              {info}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}