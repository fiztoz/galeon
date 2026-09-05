import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, CornerDownLeft, Folder, Server, Command } from 'lucide-react';
import { ConnectionProfile } from '../App';

export interface CommandAction {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: ConnectionProfile[];
  recentPaths: string[];
  onConnectProfile: (profile: ConnectionProfile) => void;
  onNavigatePath: (path: string) => void;
  actions: CommandAction[];
}

// ─── Types for flat item list ─────────────────────────────────────────────────

type ActionItem = {
  kind: 'action';
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type ProfileItem = {
  kind: 'profile';
  id: string;
  label: string;
  profile: ConnectionProfile;
  run: () => void;
};

type PathItem = {
  kind: 'path';
  id: string;
  label: string;
  path: string;
  run: () => void;
};

type FlatItem = ActionItem | ProfileItem | PathItem;

// ─── Simple fuzzy/subsequence matcher ────────────────────────────────────────

function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return true;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) return true;
  return fields.some(f => f && fuzzyMatch(query, f));
}

// ─── Section header component ─────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500 select-none">
      {label}
    </div>
  );
}

// ─── CommandPalette ───────────────────────────────────────────────────────────

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onOpenChange,
  profiles,
  recentPaths,
  onConnectProfile,
  onNavigatePath,
  actions,
}) => {
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const highlightedRef = useRef<HTMLDivElement>(null);

  // ── Global hotkey ────────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onOpenChange]);

  // ── Reset on open ────────────────────────────────────────────────────────
  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlightedIndex(0);
      // Focus after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // ── Build flat item list ─────────────────────────────────────────────────
  const flatItems = useCallback((): FlatItem[] => {
    const items: FlatItem[] = [];

    // Actions
    for (const action of actions) {
      if (matchesQuery(query, action.label, action.hint, action.keywords)) {
        items.push({
          kind: 'action',
          id: `action-${action.id}`,
          label: action.label,
          hint: action.hint,
          run: action.run,
        });
      }
    }

    // Profiles
    for (const profile of profiles) {
      if (matchesQuery(query, profile.name, profile.bucket, profile.host)) {
        items.push({
          kind: 'profile',
          id: `profile-${profile.id}`,
          label: `Connect to ${profile.name}`,
          profile,
          run: () => onConnectProfile(profile),
        });
      }
    }

    // Recent paths
    for (const path of recentPaths) {
      if (matchesQuery(query, path)) {
        items.push({
          kind: 'path',
          id: `path-${path}`,
          label: `Go to ${path}`,
          path,
          run: () => onNavigatePath(path),
        });
      }
    }

    return items;
  }, [query, actions, profiles, recentPaths, onConnectProfile, onNavigatePath]);

  const items = flatItems();

  // Reset highlight index when query changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  // Scroll highlighted item into view
  useEffect(() => {
    highlightedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  // ── Execute an item ──────────────────────────────────────────────────────
  const executeItem = useCallback(
    (item: FlatItem) => {
      item.run();
      onOpenChange(false);
      setQuery('');
    },
    [onOpenChange],
  );

  // ── Keyboard nav inside the palette ─────────────────────────────────────
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex(i => (i + 1) % Math.max(items.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(i => (i - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[highlightedIndex];
      if (item) executeItem(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onOpenChange(false);
    }
  };

  // ── Sections for display ─────────────────────────────────────────────────
  const actionItems = items.filter(i => i.kind === 'action');
  const profileItems = items.filter(i => i.kind === 'profile');
  const pathItems = items.filter(i => i.kind === 'path');

  // Helper: get flat index of an item
  const getIndex = (item: FlatItem) => items.indexOf(item);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-start justify-center z-50 pt-[15vh]"
      onMouseDown={(e) => {
        // Close when clicking the backdrop (not the palette itself)
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-[560px] max-h-[60vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center px-4 py-3 border-b border-zinc-800 gap-3">
          <Search className="w-4 h-4 text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-500 outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex items-center gap-1 text-[10px] text-zinc-600 bg-zinc-800/50 px-1.5 py-0.5 rounded border border-zinc-700 shrink-0">
            <Command className="w-3.5 h-3.5" />
            <span>K</span>
          </div>
        </div>

        {/* Results list */}
        <div
          ref={listRef}
          className="overflow-y-auto flex-1 py-2 galeon-scrollbar"
        >
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No results
            </div>
          ) : (
            <>
              {/* Actions section */}
              {actionItems.length > 0 && (
                <div>
                  <SectionLabel label="Actions" />
                  {actionItems.map(item => {
                    const idx = getIndex(item);
                    const isHighlighted = idx === highlightedIndex;
                    return (
                      <div
                        key={item.id}
                        ref={isHighlighted ? highlightedRef : undefined}
                        className={`flex items-center justify-between px-3 py-2 mx-1 rounded-r-lg cursor-pointer select-none transition-all duration-150 ease-out ${
                          isHighlighted
                            ? 'bg-gale-teal/15 border-l-2 border-gale-teal text-foam pl-2.5'
                            : 'text-zinc-300 hover:bg-zinc-800/60 border-l-2 border-transparent pl-2.5'
                        }`}
                        onMouseEnter={() => setHighlightedIndex(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          executeItem(item);
                        }}
                      >
                        <span className="text-sm">{item.label}</span>
                        <div className="flex items-center gap-2">
                          {(item as ActionItem).hint && (
                            <span className="text-xs text-zinc-500">{(item as ActionItem).hint}</span>
                          )}
                          {isHighlighted && (
                            <CornerDownLeft className="w-3.5 h-3.5 text-gale-teal/80 transition-opacity duration-150" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Profiles section */}
              {profileItems.length > 0 && (
                <div>
                  <SectionLabel label="Profiles" />
                  {profileItems.map(item => {
                    const idx = getIndex(item);
                    const isHighlighted = idx === highlightedIndex;
                    const profileItem = item as ProfileItem;
                    return (
                      <div
                        key={item.id}
                        ref={isHighlighted ? highlightedRef : undefined}
                        className={`flex items-center justify-between px-3 py-2 mx-1 rounded-r-lg cursor-pointer select-none transition-all duration-150 ease-out ${
                          isHighlighted
                            ? 'bg-gale-teal/15 border-l-2 border-gale-teal text-foam pl-2.5'
                            : 'text-zinc-300 hover:bg-zinc-800/60 border-l-2 border-transparent pl-2.5'
                        }`}
                        onMouseEnter={() => setHighlightedIndex(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          executeItem(item);
                        }}
                      >
                        <div className="flex items-center gap-2.5">
                          <Server className={`w-3.5 h-3.5 shrink-0 transition-colors duration-150 ${isHighlighted ? 'text-gale-teal' : 'text-zinc-500'}`} />
                          <span className="text-sm">{item.label}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {profileItem.profile.protocol && (
                            <span className="text-[10px] uppercase tracking-wide text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded font-mono">
                              {profileItem.profile.protocol}
                            </span>
                          )}
                          {isHighlighted && (
                            <CornerDownLeft className="w-3.5 h-3.5 text-gale-teal/80 transition-opacity duration-150" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Recent Paths section */}
              {pathItems.length > 0 && (
                <div>
                  <SectionLabel label="Recent Paths" />
                  {pathItems.map(item => {
                    const idx = getIndex(item);
                    const isHighlighted = idx === highlightedIndex;
                    return (
                      <div
                        key={item.id}
                        ref={isHighlighted ? highlightedRef : undefined}
                        className={`flex items-center justify-between px-3 py-2 mx-1 rounded-r-lg cursor-pointer select-none transition-all duration-150 ease-out ${
                          isHighlighted
                            ? 'bg-gale-teal/15 border-l-2 border-gale-teal text-foam pl-2.5'
                            : 'text-zinc-300 hover:bg-zinc-800/60 border-l-2 border-transparent pl-2.5'
                        }`}
                        onMouseEnter={() => setHighlightedIndex(idx)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          executeItem(item);
                        }}
                      >
                        <div className="flex items-center gap-2.5">
                          <Folder className={`w-3.5 h-3.5 shrink-0 transition-colors duration-150 ${isHighlighted ? 'text-gale-teal' : 'text-zinc-500'}`} />
                          <span className="text-sm font-mono truncate max-w-[320px]">{(item as PathItem).path}</span>
                        </div>
                        {isHighlighted && (
                          <CornerDownLeft className="w-3.5 h-3.5 text-gale-teal/80 transition-opacity duration-150" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-zinc-800 px-4 py-2 flex items-center gap-4 text-[10px] text-zinc-600">
          <span className="flex items-center gap-1">
            <kbd className="bg-zinc-800 px-1 rounded text-zinc-500">↑↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-zinc-800 px-1 rounded text-zinc-500">↵</kbd> select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-zinc-800 px-1 rounded text-zinc-500">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
};
