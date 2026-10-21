import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { isCurrentProfile, switcherSubtitle, type SwitcherProfile } from '../connectionSwitcher';

type Props = {
  /** Saved profiles, in the order they should be listed. */
  profiles: SwitcherProfile[];
  /** The profile the open session came from, if any. */
  sessionProfileId?: string;
  /** Shown when the session does not belong to a saved profile. */
  fallbackLabel: string;
  /** Switch to a saved profile. */
  onConnect: (profileId: string) => void;
  /** Leave the current connection. */
  onDisconnect: () => void;
};

/**
 * The titlebar identity: the current connection, and the saved connections
 * one click away.
 *
 * Switching goes through the caller's connect path, so the editor warning
 * still applies. This component never connects by itself.
 */
export const ConnectionSwitcher: React.FC<Props> = ({
  profiles,
  sessionProfileId,
  fallbackLabel,
  onConnect,
  onDisconnect,
}) => {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const current = profiles.find((profile) => isCurrentProfile(profile.id, sessionProfileId));
  const label = current?.name ?? fallbackLabel;

  // The last row is always Disconnect, so the row count is the profile count
  // plus one.
  const rowCount = profiles.length + 1;

  const close = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const activate = (index: number) => {
    if (index < profiles.length) {
      const profile = profiles[index];
      // Re-picking the current profile only closes the menu.
      if (!isCurrentProfile(profile.id, sessionProfileId)) onConnect(profile.id);
      close();
      return;
    }
    onDisconnect();
    close();
  };

  // Clicking away closes the menu.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight(current ? profiles.indexOf(current) : 0);
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close(true);
        return;
      case 'ArrowDown':
        e.preventDefault();
        setHighlight((h) => (h + 1) % rowCount);
        return;
      case 'ArrowUp':
        e.preventDefault();
        setHighlight((h) => (h - 1 + rowCount) % rowCount);
        return;
      case 'Enter':
        e.preventDefault();
        activate(highlight);
        return;
      default:
    }
  };

  return (
    <div
      ref={rootRef}
      data-no-drag
      className="relative"
      onKeyDown={handleKeyDown}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setHighlight(current ? profiles.indexOf(current) : 0);
          setOpen((o) => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch connection"
        title={current ? switcherSubtitle(current) : fallbackLabel}
        className="ui-button ui-button-ghost"
      >
        <span className="truncate max-w-48">{label}</span>
        <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Saved connections"
          className="absolute left-0 z-50 mt-1 min-w-64 max-h-80 overflow-y-auto galeon-scrollbar rounded-lg border border-zinc-800 bg-zinc-900 py-1 shadow-xl"
        >
          {profiles.map((profile, index) => {
            const isCurrent = isCurrentProfile(profile.id, sessionProfileId);
            return (
              <button
                key={profile.id}
                type="button"
                role="menuitem"
                aria-current={isCurrent ? 'true' : undefined}
                onClick={() => activate(index)}
                onMouseEnter={() => setHighlight(index)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  isCurrent ? 'text-gale-teal' : 'text-zinc-300'
                } ${index === highlight ? 'bg-zinc-800' : ''} hover:bg-zinc-800`}
              >
                <span className="block truncate">{profile.name}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {switcherSubtitle(profile)}
                </span>
              </button>
            );
          })}

          <div className="my-1 border-t border-zinc-800" />

          <button
            type="button"
            role="menuitem"
            onClick={() => activate(profiles.length)}
            onMouseEnter={() => setHighlight(profiles.length)}
            className={`w-full text-left px-3 py-2 text-sm text-zinc-400 transition-colors ${
              highlight === profiles.length ? 'bg-zinc-800' : ''
            } hover:bg-zinc-800 hover:text-zinc-200`}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
};
