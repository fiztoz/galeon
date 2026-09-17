import { Dialog } from './Dialogs';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Folder,
  File,
  ChevronRight,
  ChevronUp,
  Upload,
  Plus,
  Loader2,
  AlertTriangle,
  Eye,
  EyeOff,
  ArrowUpToLine,
} from 'lucide-react';
import { formatSize } from './Explorer';
import {
  GALEON_LOCAL_PATHS_MIME,
  GALEON_REMOTE_KEYS_MIME,
  dragHasType,
  readDragJson,
} from './paneDrag';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Mirrors the Rust `LocalEntry` struct from src-tauri/src/commands/local.rs. */
interface LocalEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modifiedMs: number | null;
  isHidden: boolean;
  parentPath: string | null;
}

export interface LocalPaneProps {
  initialPath?: string;
  /** The remote pane's current prefix, used as the upload destination hint. */
  remotePrefix: string;
  onUploadToRemote: (paths: string[], targetPrefix: string) => void;
  /** In-app drag from the remote pane: download these keys into `targetDir`. */
  onDownloadToLocal?: (remoteKeys: string[], targetDir: string) => void;
  onRegisterCommands?: (cmds: { refresh: () => void; newFolder: () => void }) => void;
  active?: boolean;
  /** Called when the local pane navigates to a new directory. */
  onPathChange?: (path: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SortKey = 'name' | 'size' | 'date';

const sortEntries = (
  entries: LocalEntry[],
  sortKey: SortKey,
  sortDir: 'asc' | 'desc',
): LocalEntry[] => {
  const sorted = [...entries].sort((a, b) => {
    // Dirs always first
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;

    let cmp = 0;
    switch (sortKey) {
      case 'name':
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        break;
      case 'size':
        cmp = (a.size ?? 0) - (b.size ?? 0);
        break;
      case 'date':
        cmp = (a.modifiedMs ?? 0) - (b.modifiedMs ?? 0);
        break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });
  return sorted;
};

// ─── Component ────────────────────────────────────────────────────────────────

export const LocalPane: React.FC<LocalPaneProps> = ({
  initialPath,
  remotePrefix,
  onUploadToRemote,
  onDownloadToLocal,
  onRegisterCommands,
  onPathChange,
}) => {
  // ── State ──────────────────────────────────────────────────────────────────
  const [currentPath, setCurrentPath] = useState(() => {
    return initialPath || '/';
  });
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [listFailed, setListFailed] = useState(false);

  // Selection
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  // Sort & filter
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Hidden files toggle (default OFF — macOS convention)
  const [showHidden, setShowHidden] = useState(false);

  // New folder modal
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  // ── In-app drag state (remote → local) ───────────────────────────────────
  // HTML5 only, additive over Tauri's native OS drop: we only preventDefault
  // when the remote pane's MIME is present, so OS file drags still reach the
  // window-level `tauri://drag-drop` listener untouched.
  const [dragOverRemote, setDragOverRemote] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const localDragPaths = (entry: LocalEntry): string[] => {
    if (selectedItems.has(entry.path) && selectedItems.size > 0) return [...selectedItems];
    return [entry.path];
  };
  const listNonceRef = useRef(0);

  // ── Fetch directory ────────────────────────────────────────────────────────
  const fetchDirectory = useCallback(async (path: string) => {
    const nonce = ++listNonceRef.current;
    setLoading(true);
    setError('');
    setListFailed(false);
    try {
      const res = await invoke<LocalEntry[]>('list_local_directory', { path });
      if (nonce !== listNonceRef.current) return;
      setEntries(res);
    } catch (err: unknown) {
      if (nonce !== listNonceRef.current) return;
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^Error:\s*/i, '') || 'Failed to list directory.');
      setListFailed(true);
    } finally {
      if (nonce === listNonceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDirectory(currentPath);
    // The parent owns persistence and mirrors this back as `initialPath`, so the
    // pane keeps exactly one source of truth for the current directory.
    onPathChange?.(currentPath);
  }, [currentPath, fetchDirectory, onPathChange]);

  // ── Register commands with parent ──────────────────────────────────────────
  const refresh = useCallback(() => fetchDirectory(currentPath), [currentPath, fetchDirectory]);

  const handleNewFolder = useCallback(() => {
    setShowNewFolder(true);
    setNewFolderName('');
  }, []);

  useEffect(() => {
    onRegisterCommands?.({ refresh, newFolder: handleNewFolder });
  }, [refresh, handleNewFolder, onRegisterCommands]);

  // ── Filtered + sorted entries ──────────────────────────────────────────────
  const filteredEntries = useMemo(() => {
    let result = entries;

    // Hidden filter
    if (!showHidden) {
      result = result.filter((e) => !e.isHidden);
    }

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((e) => e.name.toLowerCase().includes(q));
    }

    return sortEntries(result, sortKey, sortDirection);
  }, [entries, showHidden, searchQuery, sortKey, sortDirection]);

  // ── Sort handler ───────────────────────────────────────────────────────────
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  // ── Selection ──────────────────────────────────────────────────────────────
  const handleSelectItem = (path: string, index: number, shiftKey: boolean = false) => {
    const newSelected = new Set(selectedItems);

    if (shiftKey && lastSelectedIndex !== null) {
      const startIdx = Math.min(lastSelectedIndex, index);
      const endIdx = Math.max(lastSelectedIndex, index);
      for (let i = startIdx; i <= endIdx; i++) {
        if (filteredEntries[i]) {
          newSelected.add(filteredEntries[i].path);
        }
      }
    } else {
      if (newSelected.has(path)) {
        newSelected.delete(path);
      } else {
        newSelected.add(path);
      }
    }

    setSelectedItems(newSelected);
    setLastSelectedIndex(index);
  };

  const handleSelectAll = () => {
    if (selectedItems.size === filteredEntries.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(filteredEntries.map((e) => e.path)));
    }
  };

  const clearSelection = () => {
    setSelectedItems(new Set());
    setLastSelectedIndex(null);
  };

  // ── Navigation ─────────────────────────────────────────────────────────────
  const handleDoubleClick = (entry: LocalEntry) => {
    if (entry.isDir) {
      setCurrentPath(entry.path);
      clearSelection();
    }
  };

  const navigateUp = () => {
    // Derive parent from path string (no invoke needed)
    const parts = currentPath.split('/');
    // Remove trailing empty segment from trailing slash
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    if (parts.length > 1) {
      parts.pop();
      const parent = parts.join('/') || '/';
      setCurrentPath(parent);
      clearSelection();
    }
  };

  // ── Create folder ──────────────────────────────────────────────────────────
  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const sep = currentPath.endsWith('/') ? '' : '/';
    const fullPath = currentPath + sep + name;
    try {
      await invoke('create_local_folder', { path: fullPath });
      setShowNewFolder(false);
      fetchDirectory(currentPath);
    } catch (err: unknown) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^Error:\s*/i, '') || 'Failed to create folder.');
    }
  };

  // ── Upload to remote ───────────────────────────────────────────────────────
  const handleUploadSelected = () => {
    if (selectedItems.size === 0) return;
    const paths = [...selectedItems];
    onUploadToRemote(paths, remotePrefix);
    clearSelection();
  };

  // ── Format helpers ─────────────────────────────────────────────────────────
  const formatDate = (ms: number | null) => {
    if (ms === null) return '-';
    return new Date(ms).toLocaleString();
  };

  // ── Path bar segments ──────────────────────────────────────────────────────
  const pathSegments = useMemo(() => {
    const trimmed = currentPath.replace(/\/+$/, '');
    if (!trimmed) return [];
    return trimmed.split('/').filter(Boolean);
  }, [currentPath]);

  const navigateToSegment = (index: number) => {
    const joined = '/' + pathSegments.slice(0, index + 1).join('/');
    setCurrentPath(joined);
    clearSelection();
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const hasSelection = selectedItems.size > 0;

  return (
    <div
      className="file-pane flex flex-col h-full bg-zinc-950 text-zinc-100"
      onDragOver={(e) => {
        if (dragHasType(e, GALEON_REMOTE_KEYS_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragOverRemote(true);
        }
      }}
      onDragLeave={() => setDragOverRemote(false)}
      onDrop={(e) => {
        if (!dragHasType(e, GALEON_REMOTE_KEYS_MIME)) return;
        e.preventDefault();
        setDragOverRemote(false);
        const keys = readDragJson<string[]>(e, GALEON_REMOTE_KEYS_MIME);
        if (keys && keys.length > 0) onDownloadToLocal?.(keys, currentPath);
      }}
    >
      {/* Path bar */}
      <div className="pane-path flex items-center justify-between gap-3 py-3 px-4 bg-zinc-900 border-b border-zinc-800 text-sm">
        <nav aria-label="Local path" className="flex items-center space-x-1 min-w-0 galeon-scrollbar">
          <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full font-medium mr-1 shrink-0">
            LOCAL
          </span>
          <button
            onClick={() => { setCurrentPath('/'); clearSelection(); }}
            className="text-gale-teal hover:text-deep-current font-medium"
          >
            /
          </button>
          {pathSegments.map((seg, idx) => (
            <React.Fragment key={idx}>
              <ChevronRight className="w-4 h-4 text-zinc-500 flex-shrink-0" />
              <button
                onClick={() => navigateToSegment(idx)}
                className="text-gale-teal hover:text-deep-current truncate font-medium"
              >
                {seg}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <button
          onClick={navigateUp}
          disabled={pathSegments.length === 0}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
          title="Go up one level"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>

      {/* Toolbar */}
      <div className="pane-toolbar bg-zinc-900/50 border-b border-zinc-800 space-y-3">
        <div className="pane-toolbar-row">
          <div className="pane-actions">
            <button
              onClick={handleUploadSelected}
              disabled={!hasSelection}
              className="flex items-center space-x-2 px-3 py-1.5 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-semibold transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ArrowUpToLine className="w-4 h-4" />
              <span>Upload to Remote</span>
            </button>
            <button
              onClick={() => setShowNewFolder(true)}
              className="flex items-center space-x-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>New Folder</span>
            </button>
            <button
              onClick={() => fetchDirectory(currentPath)}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
            >
              Refresh
            </button>
          </div>
          <div className="pane-search">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search local files"
              placeholder="Search local files…"
              className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all w-48"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <div className="pane-filters">
          <button
            onClick={() => setShowHidden(!showHidden)}
            aria-pressed={showHidden}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              showHidden ? 'bg-gale-teal text-on-accent font-semibold' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            {showHidden ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            Hidden
          </button>
          <span className="text-xs text-zinc-500">Sort:</span>
          {(['name', 'size', 'date'] as SortKey[]).map((key) => (
            <button
              key={key}
              onClick={() => handleSort(key)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                sortKey === key ? 'bg-gale-teal text-on-accent font-semibold' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              {key === 'name' ? 'Name' : key === 'size' ? 'Size' : 'Date'}
              {sortKey === key && (sortDirection === 'asc' ? ' ↑' : ' ↓')}
            </button>
          ))}
          {(searchQuery || showHidden) && (
            <button
              onClick={() => { setSearchQuery(''); setShowHidden(false); }}
              className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className={`pane-content flex-1 overflow-auto galeon-scrollbar ${dragOverRemote ? 'ring-2 ring-inset ring-gale-teal/60 bg-gale-teal/5' : ''}`}>
        {dragOverRemote && (
          <div className="mb-2 text-xs text-gale-teal font-medium px-1">Drop to download here</div>
        )}
        {error && (
          <div className="p-3 mb-4 text-sm bg-red-950/50 border border-red-800 text-red-200 rounded-lg flex items-start justify-between gap-3">
            <span className="min-w-0 break-words">{error}</span>
            <button
              type="button"
              onClick={() => setError('')}
              className="shrink-0 text-red-400/80 hover:text-red-200 text-lg leading-none"
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col justify-center items-center h-48 gap-3">
            <Loader2 className="w-6 h-6 text-gale-teal animate-spin" />
            <span className="text-zinc-400 text-sm">Loading…</span>
          </div>
        ) : (
          <div className="border border-zinc-800 rounded-xl bg-zinc-900/40 backdrop-blur-md">
            <table className="file-table text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/70 text-zinc-400 text-xs uppercase tracking-wider font-semibold">
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all visible local items"
                      checked={filteredEntries.length > 0 && selectedItems.size === filteredEntries.length}
                      onChange={handleSelectAll}
                      className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-gale-teal focus:ring-gale-teal focus:ring-1 accent-gale-teal"
                    />
                  </th>
                  <th
                    aria-sort={sortKey === 'name' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="px-6 py-3 cursor-pointer hover:text-zinc-200 select-none"
                  >
                    <button type="button" onClick={() => handleSort('name')}>Name {sortKey === 'name' && (sortDirection === 'asc' ? '↑' : '↓')}</button>
                  </th>
                  <th
                    aria-sort={sortKey === 'size' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="px-6 py-3 w-40 cursor-pointer hover:text-zinc-200 select-none"
                  >
                    <button type="button" onClick={() => handleSort('size')}>Size {sortKey === 'size' && (sortDirection === 'asc' ? '↑' : '↓')}</button>
                  </th>
                  <th
                    aria-sort={sortKey === 'date' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className="px-6 py-3 w-60 cursor-pointer hover:text-zinc-200 select-none"
                  >
                    <button type="button" onClick={() => handleSort('date')}>Modified {sortKey === 'date' && (sortDirection === 'asc' ? '↑' : '↓')}</button>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50 text-sm text-zinc-200">
                {filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-14 text-center text-zinc-500">
                      <div className="flex flex-col items-center gap-3 max-w-sm mx-auto">
                        {listFailed ? (
                          <>
                            <AlertTriangle className="w-10 h-10 text-red-500/70" />
                            <p className="text-sm text-zinc-300">Couldn&apos;t load this folder</p>
                            <p className="text-xs text-zinc-500">
                              Its contents are unknown — this is not an empty folder.
                            </p>
                            <button
                              type="button"
                              onClick={() => fetchDirectory(currentPath)}
                              className="mt-1 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-medium text-zinc-200"
                            >
                              Try again
                            </button>
                          </>
                        ) : searchQuery || showHidden ? (
                          <>
                            <Folder className="w-10 h-10 text-zinc-600 opacity-70" />
                            <p className="text-sm text-zinc-400">No matching items</p>
                            <button
                              type="button"
                              onClick={() => { setSearchQuery(''); setShowHidden(false); }}
                              className="text-xs text-gale-teal hover:text-deep-current"
                            >
                              Clear search / filter
                            </button>
                          </>
                        ) : (
                          <>
                            <Folder className="w-10 h-10 text-zinc-600 opacity-70" />
                            <p className="text-sm text-zinc-300">This folder is empty</p>
                            <p className="text-xs text-zinc-500">
                              Create a folder, or download files from the remote pane.
                            </p>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredEntries.map((entry, index) => (
                    <tr
                      key={entry.path}
                      draggable={!entry.isDir}
                      onDragStart={(e) => {
                        if (entry.isDir) { e.preventDefault(); return; }
                        e.dataTransfer.setData(GALEON_LOCAL_PATHS_MIME, JSON.stringify(localDragPaths(entry)));
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onDoubleClick={() => handleDoubleClick(entry)}
                      className={`hover:bg-zinc-800/40 cursor-pointer transition-colors ${
                        selectedItems.has(entry.path) ? 'bg-gale-teal/10 border-l-2 border-gale-teal' : ''
                      } ${entry.isHidden ? 'opacity-50' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${entry.name}`}
                          checked={selectedItems.has(entry.path)}
                          onChange={() => {}}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectItem(entry.path, index, e.shiftKey);
                          }}
                          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-gale-teal focus:ring-gale-teal focus:ring-1 accent-gale-teal"
                        />
                      </td>
                      <td className="px-6 py-3">
                        <div className="file-name">
                        {entry.isDir ? (
                          <Folder className="w-5 h-5 text-gale-teal flex-shrink-0" />
                        ) : (
                          <File className="w-5 h-5 text-zinc-400 flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <button type="button" onClick={(event) => handleSelectItem(entry.path, index, event.shiftKey)}
                            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); handleDoubleClick(entry); } }} title={entry.name} className="block max-w-full hover:text-gale-teal">{entry.name}</button>
                          <span className="compact-date">{formatDate(entry.modifiedMs)}</span>
                        </div>
                        </div>
                      </td>
                      <td className="px-6 py-3 text-zinc-400 metric-text">
                        {entry.isDir ? '—' : formatSize(entry.size)}
                      </td>
                      <td className="px-6 py-3 text-zinc-400 metric-text">
                        {formatDate(entry.modifiedMs)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Floating Batch Toolbar */}
      {hasSelection && (
        <div className="pane-selection">
          <div className="text-sm">
            <span className="text-sm text-zinc-300">
              <span className="font-semibold">{selectedItems.size}</span> selected
            </span>
            <div className="h-6 w-px bg-zinc-700" />
            <button
              onClick={clearSelection}
              className="text-sm text-zinc-400 hover:text-zinc-200"
            >
              Deselect All
            </button>
            <button
              onClick={handleUploadSelected}
              className="flex items-center space-x-1 px-3 py-1.5 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-semibold transition-colors"
            >
              <Upload className="w-4 h-4" />
              <span>Upload to Remote</span>
            </button>
          </div>
        </div>
      )}

      {/* New Folder Modal */}
      {showNewFolder && (
        <Dialog title="New Folder" onClose={() => setShowNewFolder(false)}>
            <input
              ref={inputRef}
              aria-label="Folder name"
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
              placeholder="Folder name"
              className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all mb-4"
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex justify-end space-x-2">
              <button
                onClick={() => setShowNewFolder(false)}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim()}
                className="px-4 py-2 bg-gale-teal hover:bg-deep-current hover:text-white text-on-accent rounded-lg text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Create
              </button>
            </div>
        </Dialog>
      )}
    </div>
  );
};
