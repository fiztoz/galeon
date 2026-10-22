import { X as CloseIcon } from 'lucide-react';
import { Select } from './Select';
import { createPortal } from 'react-dom';
import { useObjectListing, useObjectSorting } from '../hooks/useObjectListing';
import { useMultiSelect } from '../hooks/useMultiSelect';
import { useWindowedRows } from '../hooks/useWindowedRows';
import { useFileListKeyboardNav, isInteractiveTarget } from '../hooks/useFileListKeyboard';
import { useExplorerDialogs } from '../hooks/useExplorerDialogs';
import {
  initialPathHistory,
  moveWithinHistory,
  parentPrefix,
  pushPath,
} from '../pathHistory';
import React, { useEffect, useRef, useState } from 'react';
import { useFolderSizes } from '../hooks/useFolderSizes';
import { save, open } from '@tauri-apps/plugin-dialog';
import { useUploadPipeline, type PendingConflict } from '../hooks/useUploadPipeline';
import { Folder, File, ChevronRight, Download, Upload, Plus, Trash2, Loader2, AlertTriangle, Search, RotateCw, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { ProtocolCapabilities, GaleonObject, StorageProtocol } from '../types';
import {
  ConflictDialog,
} from './Dialogs';
import { ObjectContextMenu, useObjectContextMenu, type ObjectMenuAction } from './ObjectContextMenu';
import { PaneChrome } from './PaneChrome';
import {
  GALEON_LOCAL_PATHS_MIME,
  GALEON_REMOTE_KEYS_MIME,
  dragHasType,
  readDragJson,
} from './paneDrag';

/** Format byte count to human-readable size string. Reused by LocalPane. */
export const formatSize = (bytes: number | null) => {
  if (bytes === null) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

interface ExplorerProps {
  sessionId: string;
  bucket: string;
  protocol?: StorageProtocol;
  capabilities?: ProtocolCapabilities;
  onInitiateDownload: (remoteKey: string, localPath: string) => void;
  onInitiateUpload: (localPath: string, remoteKey: string) => void;
  onCreateFolder: (prefix: string, folderName: string) => Promise<void>;
  onDeleteObjects: (items: { key: string; isFolder: boolean }[]) => Promise<void>;
  onRenameObject: (oldKey: string, newKey: string, isFolder: boolean) => Promise<void>;
  onGeneratePresignedUrl: (key: string, expiresInSeconds: number) => Promise<string>;
  onGeneratePresignedUploadUrl?: (key: string, expiresInSeconds: number) => Promise<string>;
  onEditRemoteFile?: (remoteKey: string) => void;
  onShowProperties?: (obj: GaleonObject) => void;
  onShowPreview?: (obj: GaleonObject) => void;
  navRequest?: { path: string; nonce: number } | null;
  onPrefixChange?: (prefix: string) => void;
  onRegisterCommands?: (cmds: { refresh: () => void; newFolder: () => void; upload: () => void }) => void;
  /** When set, batch downloads use this path instead of the OS dialog. */
  downloadDestination?: string;
}

export const Explorer: React.FC<ExplorerProps> = ({
  sessionId,
  bucket,
  protocol,
  capabilities,
  onInitiateDownload,
  onInitiateUpload,
  onCreateFolder,
  onDeleteObjects,
  onRenameObject,
  onGeneratePresignedUrl,
  onGeneratePresignedUploadUrl,
  onEditRemoteFile,
  onShowProperties,
  onShowPreview,
  navRequest,
  onPrefixChange,
  downloadDestination,
  onRegisterCommands,
}) => {
  const isS3 = !protocol || protocol === 's3';
  const isFsProtocol = protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps';
  const { prefix, setPrefix, objects, loading, error, setError, listFailed, truncated, fetchDirectory } =
    useObjectListing(sessionId);

  // Multi-select states

  const { isDragging, showConflictModal, conflictFile, applyToAll, setApplyToAll,
    pendingConflicts, checkFileExists, startConflictCheck, handleConflictResolve, handleUpload } =
    useUploadPipeline({ sessionId, prefix, onInitiateUpload, onInitiateDownload });

  const { prefixSizeBytes, prefixFileCount, prefixSizeLoading, prefixSizeError, folderSizes } =
    useFolderSizes(sessionId, prefix, isS3, loading, objects);
  const { searchQuery, setSearchQuery, filterType, setFilterType, sortKey, sortDirection, filteredObjects, handleSort } =
    useObjectSorting(objects, folderSizes);

  const { selectedItems, setSelectedItems, setLastSelectedIndex, cursorIndex, handleSelectItem, handleSelectAll, clearSelection } =
    useMultiSelect(filteredObjects);

  // -- Windowed rendering -----------------------------------------------------
  // DIRECTION.md promises 60 fps at 100k objects, so only the rows near the
  // viewport are mounted. Logic lives in `useWindowedRows`; the component just
  // spreads `visibleRows` between two spacer rows.
  const {
    scrollRef, tbodyRef, visibleRows, indexOf: rowIndexOf,
    topSpacer, bottomSpacer, hasTopSpacer, hasBottomSpacer, scrollToIndex,
  } = useWindowedRows(filteredObjects, objects);

  // -- Navigation history ----------------------------------------------------
  // The remote pane keeps its own stack of prefixes. Back and Forward walk
  // it; every other move — breadcrumb, folder, palette jump, Up — records a
  // new entry. The rules live in `pathHistory`; this only wires them up.
  const [history, setHistory] = useState(() => initialPathHistory(prefix));

  /** Move to another location. `record` is false for back/forward moves. */
  const goTo = (next: string, record: boolean = true) => {
    setHistory(h => (record ? pushPath(h, next) : moveWithinHistory(h, next)));
    setPrefix(next);
    clearSelection();
  };

  const goBack = () => {
    const previous = history.past[history.past.length - 1];
    if (previous === undefined) return;
    goTo(previous, false);
  };

  const goForward = () => {
    const next = history.future[0];
    if (next === undefined) return;
    goTo(next, false);
  };

  const goUp = () => {
    const parent = parentPrefix(prefix, isFsProtocol);
    if (parent === null) return;
    goTo(parent, true);
  };

  // In-app drag state (local → remote). HTML5 only, additive over the native
  // OS drop overlay (`isDragging`): we only preventDefault for our own MIME.
  const [dragOverLocal, setDragOverLocal] = useState(false);

  const remoteDragKeys = (obj: GaleonObject): string[] => {
    if (selectedItems.has(obj.fullKey) && selectedItems.size > 0) return [...selectedItems];
    return [obj.fullKey];
  };

  const { activeMenu, setActiveMenu, menuPosition, handleRowContextMenu } =
    useObjectContextMenu(selectedItems, setSelectedItems, setLastSelectedIndex);

  const handleMenuAction = (action: ObjectMenuAction, obj: GaleonObject) => {
    switch (action) {
      case 'download': handleDownload(obj); return;
      case 'downloadHere': handleDownloadHere(obj); return;
      case 'preview': onShowPreview?.(obj); break;
      case 'share': openShare(obj); break;
      case 'edit': onEditRemoteFile?.(obj.fullKey); break;
      case 'properties': onShowProperties?.(obj); break;
      case 'rename': openRename(obj); break;
      case 'move': openMove(obj); break;
      case 'copy': openCopy(obj); break;
      case 'delete': openDelete(obj); break;
    }
    setActiveMenu(null);
  };

  const handleBatchDownload = async () => {
    let localPath: string | null = null;

    if (downloadDestination) {
      localPath = downloadDestination;
    } else {
      const selected = await open({
        title: 'Select download folder',
        directory: true,
        multiple: false,
      });

      if (selected) {
        localPath = Array.isArray(selected) ? selected[0] : selected;
      }
    }

    if (localPath) {
      const conflicts: PendingConflict[] = [];
      const noConflict: Array<{remoteKey: string, localPath: string}> = [];
      let folderCount = 0;
      
      for (const key of selectedItems) {
        const obj = objects.find(o => o.fullKey === key);
        if (obj) {
          if (obj.objectType === 'folder') {
            folderCount++;
          } else {
            const fileName = obj.name;
            const fullPath = localPath.endsWith('/') ? localPath + fileName : localPath + '/' + fileName;
            const fileExists = await checkFileExists(fullPath);
            if (fileExists) {
              conflicts.push({ remoteKey: key, localPath: fullPath, direction: 'download' });
            } else {
              noConflict.push({ remoteKey: key, localPath: fullPath });
            }
          }
        }
      }
      
      // Show warning if folders were selected
      if (folderCount > 0) {
        setError(`${folderCount} folder(s) skipped. Folders cannot be downloaded.`);
      }
      
      // Start downloads without conflicts
      noConflict.forEach(item => onInitiateDownload(item.remoteKey, item.localPath));
      
      // Handle conflicts
      if (conflicts.length > 0) {
        startConflictCheck(conflicts);
      }
      
      clearSelection();
    }
  };

  const handleBatchDelete = async () => {
    const items = [...selectedItems]
      .map((key) => {
        const obj = objects.find((o) => o.fullKey === key);
        if (!obj) return null;
        return { key, isFolder: obj.objectType === 'folder' };
      })
      .filter((item): item is { key: string; isFolder: boolean } => item !== null);

    if (items.length === 0) return;

    clearSelection();
    try {
      await onDeleteObjects(items);
    } catch (err: any) {
      setError(String(err));
    }
  };

  // -- Dialogs ----------------------------------------------------------------
  // Create folder, rename, delete, move, copy, share, batch delete: one hook
  // owns which dialog is open and what each one does.
  const {
    dialogs,
    openCreateFolder,
    openRename,
    openDelete,
    openMove,
    openCopy,
    openShare,
    openBatchDelete,
  } = useExplorerDialogs({
    sessionId,
    prefix,
    onCreateFolder,
    onRenameObject,
    onDeleteObjects,
    onGeneratePresignedUrl,
    onGeneratePresignedUploadUrl,
    onError: setError,
    refresh: () => fetchDirectory(prefix),
    selectedCount: selectedItems.size,
    onBatchDelete: handleBatchDelete,
  });

  useEffect(() => {
    fetchDirectory(prefix);
    onPrefixChange?.(prefix);
  }, [prefix]);

  // Windowed rows keep their scroll offset across a listing, so navigating to
  // another folder would otherwise land the user halfway down the new one.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [prefix, sessionId]);

  // Cross-component navigation (e.g. Command Palette "Go to path")
  useEffect(() => {
    if (navRequest) goTo(navRequest.path);
  }, [navRequest?.nonce]);

  const normalizeFsPath = (path: string) => path.replace(/\/+/g, '/');

  const handleDoubleClick = (obj: GaleonObject) => {
    if (obj.objectType === 'folder') {
      goTo(isFsProtocol ? normalizeFsPath(obj.fullKey) : obj.fullKey);
    }
  };

  // -- Keyboard navigation ----------------------------------------------------
  // The pane owns its keys: arrows walk the rows, Enter opens, Cmd+A selects
  // everything, Escape clears. The listener stays on the pane so dialogs and
  // the command palette keep their own shortcuts.
  const paneRef = useRef<HTMLDivElement | null>(null);

  const handlePaneKeyDown = useFileListKeyboardNav({
    count: filteredObjects.length,
    cursor: cursorIndex,
    onMove: (index, extend) => {
      const obj = filteredObjects[index];
      if (!obj) return;
      // A shift move extends from the anchor; the anchor itself must not
      // move, or the next shift move would range from the wrong row.
      handleSelectItem(obj.fullKey, index, extend ? { shift: true } : {});
    },
    onOpen: (index) => {
      const obj = filteredObjects[index];
      if (obj) handleDoubleClick(obj);
    },
    onRename: (index) => {
      const obj = filteredObjects[index];
      if (obj) openRename(obj);
    },
    onDelete: (index) => {
      // A multi-row selection deletes as a batch; one row deletes on its own.
      if (selectedItems.size > 1) {
        openBatchDelete();
        return;
      }
      const obj = filteredObjects[index];
      if (obj) openDelete(obj);
    },
    onSelectAll: () => {
      // Select-all is idempotent: pressing it twice must not deselect.
      if (selectedItems.size !== filteredObjects.length) handleSelectAll();
    },
    onClear: clearSelection,
    onScrollTo: scrollToIndex,
  });

  const handleDownload = async (obj: GaleonObject) => {
    if (obj.objectType === 'folder') {
      setError('Folders cannot be downloaded. Please download individual files instead.');
      setActiveMenu(null);
      return;
    }
    try {
      const targetPath = await save({ defaultPath: obj.name });
      if (targetPath) {
        const fileExists = await checkFileExists(targetPath);
        if (fileExists) {
          startConflictCheck([{ remoteKey: obj.fullKey, localPath: targetPath, direction: 'download' }]);
        } else {
          onInitiateDownload(obj.fullKey, targetPath);
        }
      }
    } catch (err) {
      console.error(err);
    }
    setActiveMenu(null);
  };

  /** Download a single file directly to downloadDestination without a dialog. */
  const handleDownloadHere = async (obj: GaleonObject) => {
    if (obj.objectType === 'folder' || !downloadDestination) return;
    const sep = downloadDestination.endsWith('/') ? '' : '/';
    const fullPath = downloadDestination + sep + obj.name;
    const fileExists = await checkFileExists(fullPath);
    if (fileExists) {
      startConflictCheck([{ remoteKey: obj.fullKey, localPath: fullPath, direction: 'download' }]);
    } else {
      onInitiateDownload(obj.fullKey, fullPath);
    }
    setActiveMenu(null);
  };

  // Expose Explorer actions to the Command Palette. Refs keep the registered
  // callbacks pointing at the latest closures (prefix, etc.) each render.
  const refreshRef = useRef<() => void>(() => {});
  refreshRef.current = () => { fetchDirectory(prefix); };
  const uploadRef = useRef<() => void>(() => {});
  uploadRef.current = () => { handleUpload(); };
  useEffect(() => {
    onRegisterCommands?.({
      refresh: () => refreshRef.current(),
      newFolder: () => openCreateFolder(),
      upload: () => uploadRef.current(),
    });
  }, [onRegisterCommands]);

  const renderPrefixSizeSummary = () => {
    if (!isS3) return null;
    const label = prefix ? 'Folder total' : 'Bucket total';
    if (prefixSizeError) {
      return (
        <span className="text-xs text-status-danger whitespace-nowrap shrink-0" title={prefixSizeError}>
          {label}: unavailable
        </span>
      );
    }
    if (prefixSizeLoading && prefixSizeBytes === null) {
      return (
        <span className="flex items-center gap-1.5 text-xs text-zinc-500 whitespace-nowrap shrink-0">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>Calculating {label.toLowerCase()}…</span>
        </span>
      );
    }
    if (prefixSizeBytes !== null) {
      const files =
        prefixFileCount !== null
          ? ` · ${prefixFileCount.toLocaleString()} file${prefixFileCount === 1 ? '' : 's'}`
          : '';
      return (
        <span className="flex items-center gap-1.5 text-xs text-zinc-500 whitespace-nowrap metric-text shrink-0">
          {prefixSizeLoading && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />}
          <span>
            {label}: {formatSize(prefixSizeBytes)}
            {files}
          </span>
        </span>
      );
    }
    return null;
  };

  const renderObjectSize = (obj: GaleonObject) => {
    if (obj.objectType === 'file') {
      return formatSize(obj.sizeBytes);
    }
    if (!isS3) {
      return '—';
    }
    const folderSize = folderSizes[obj.fullKey];
    if (folderSize?.status === 'loading') {
      return (
        <span className="inline-flex items-center gap-1.5 text-zinc-500">
          <Loader2 className="w-3 h-3 animate-spin" />
          {folderSize.totalBytes != null ? (
            <span className="metric-text">{formatSize(folderSize.totalBytes)}</span>
          ) : (
            <span>…</span>
          )}
        </span>
      );
    }
    if (folderSize?.status === 'ready' && folderSize.totalBytes != null) {
      return formatSize(folderSize.totalBytes);
    }
    if (folderSize?.status === 'error') {
      return <span className="text-zinc-600" title="Could not calculate folder size">—</span>;
    }
    return '—';
  };

  const renderBreadcrumbs = () => {
    const parts = prefix.split('/').filter(Boolean);
    const breadcrumbPath = (index: number) =>
      isFsProtocol
        ? normalizeFsPath('/' + parts.slice(0, index + 1).join('/'))
        : parts.slice(0, index + 1).join('/') + '/';
    return (
      <>
        <nav aria-label="Remote path" className="flex items-center space-x-1 min-w-0 galeon-scrollbar">
        {protocol === 'sftp' && (
          <span className="text-xs bg-status-success/10 text-status-success px-2 py-0.5 rounded font-medium mr-1">
            SFTP
          </span>
        )}
        {protocol === 'ftp' && (
          <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded font-medium mr-1">
            FTP
          </span>
        )}
        {protocol === 'ftps' && (
          <span className="text-xs bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded font-medium mr-1">
            FTPS
          </span>
        )}
        <button onClick={() => goTo('')} className="text-gale-teal hover:text-deep-current font-medium">
          {bucket}
        </button>
        {parts.map((part, index) => {
          const path = breadcrumbPath(index);
          return (
            <React.Fragment key={index}>
              <ChevronRight className="w-4 h-4 text-zinc-500 flex-shrink-0" />
              <button onClick={() => goTo(path)} className="text-gale-teal hover:text-deep-current truncate font-medium">
                {part}
              </button>
            </React.Fragment>
          );
        })}
        </nav>
        {renderPrefixSizeSummary()}
      </>
    );
  };

  return (
    <div
      ref={paneRef}
      className="file-pane flex flex-col h-full bg-zinc-950 text-zinc-100"
      tabIndex={0}
      onKeyDown={handlePaneKeyDown}
      onDragOver={(e) => {
        if (dragHasType(e, GALEON_LOCAL_PATHS_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragOverLocal(true);
        }
      }}
      onDragLeave={() => setDragOverLocal(false)}
      onDrop={(e) => {
        if (!dragHasType(e, GALEON_LOCAL_PATHS_MIME)) return;
        e.preventDefault();
        setDragOverLocal(false);
        const paths = readDragJson<string[]>(e, GALEON_LOCAL_PATHS_MIME);
        if (!paths || paths.length === 0) return;
        for (const localPath of paths) {
          const fileName = localPath.split(/[/\\]/).pop() || 'file';
          onInitiateUpload(localPath, prefix ? `${prefix}${fileName}` : fileName);
        }
      }}
    >
      {/* Drag & Drop Visual Overlay */}
      {isDragging && (
        <div className="fixed inset-0 bg-gale-teal/5 border-2 border-dashed border-gale-teal/60 rounded-xl z-50 flex items-center justify-center pointer-events-none backdrop-blur-sm">
          <div className="bg-zinc-900/90 border border-zinc-800 px-6 py-4 rounded-xl shadow-2xl flex flex-col items-center space-y-2">
            <Upload className="w-10 h-10 text-gale-teal" />
            <span className="text-sm font-semibold">Drop files here to upload</span>
            <span className="text-xs text-zinc-500">Uploading to {prefix || '/'}</span>
          </div>
        </div>
      )}
      {dragOverLocal && !isDragging && (
        <div className="mx-6 mt-2 px-3 py-1.5 rounded-lg border border-dashed border-gale-teal/60 bg-gale-teal/5 text-xs text-gale-teal font-medium">
          Drop to upload here ({prefix || '/'})
        </div>
      )}

      {/* Chrome row */}
      <PaneChrome
        navigation={
          <>
            <button
              onClick={goBack}
              disabled={history.past.length === 0}
              aria-label="Back"
              title="Back"
              className="ui-button ui-button-ghost disabled:opacity-30"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              onClick={goForward}
              disabled={history.future.length === 0}
              aria-label="Forward"
              title="Forward"
              className="ui-button ui-button-ghost disabled:opacity-30"
            >
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              onClick={goUp}
              disabled={parentPrefix(prefix, isFsProtocol) === null}
              aria-label="Go up"
              title="Go up one level"
              className="ui-button ui-button-ghost disabled:opacity-30"
            >
              <ArrowUp className="w-4 h-4" aria-hidden="true" />
            </button>
          </>
        }
        path={renderBreadcrumbs()}
        search={
          <div className="pane-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search remote files"
              placeholder="Search remote files…"
              className="connection-field text-zinc-100 placeholder:text-zinc-500"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        }
        actions={
          <div className="pane-actions">
            <button
              onClick={handleUpload}
              className="ui-button ui-button-primary"
            >
              <Upload className="w-4 h-4" />
              <span>Upload</span>
            </button>
            <button
              onClick={() => openCreateFolder()}
              className="ui-button ui-button-secondary"
            >
              <Plus className="w-4 h-4" />
              <span>New folder</span>
            </button>
            <button
              onClick={() => fetchDirectory(prefix)}
              className="ui-button ui-button-ghost"
              aria-label="Refresh files"
              title="Refresh files"
            >
              <RotateCw size={14} aria-hidden="true" />
            </button>
          </div>
        }
        filters={
          <div className="pane-filters">
            <span className="sr-only">Filter:</span>
            <button
              onClick={() => setFilterType('all')}
              aria-pressed={filterType === 'all'}
              className="pane-filter-button"
            >
              All
            </button>
            <button
              onClick={() => setFilterType('folders')}
              aria-pressed={filterType === 'folders'}
              className="pane-filter-button"
            >
              Folders
            </button>
            <button
              onClick={() => setFilterType('files')}
              aria-pressed={filterType === 'files'}
              className="pane-filter-button"
            >
              Files
            </button>
            {(searchQuery || filterType !== 'all') && (
              <button
                onClick={() => { setSearchQuery(''); setFilterType('all'); }}
                className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
              >
                Clear
              </button>
            )}
            <div className="compact-sort items-center gap-2">
              <Select
                aria-label="Sort remote files by"
                value={sortKey}
                onValueChange={(value) => handleSort(value as 'name' | 'size' | 'date')}
                className="min-w-0 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300"
              >
                <option value="name">Name</option>
                <option value="size">Size</option>
                <option value="date">Modified</option>
              </Select>
              <button type="button" onClick={() => handleSort(sortKey)} aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`} className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300">
                {sortDirection === 'asc' ? 'Ascending' : 'Descending'}
              </button>
            </div>
          </div>
        }
      />

      <div ref={scrollRef} className="pane-content flex-1 overflow-auto galeon-scrollbar">
        {error && (
          <div role="alert" className="p-3 mb-4 text-sm bg-status-danger/10 border border-status-danger/30 text-status-danger rounded-lg flex items-start justify-between gap-3">
            <span className="min-w-0 break-words">{error}</span>
            <button
              type="button"
              onClick={() => setError('')}
              className="shrink-0 text-status-danger hover:text-status-danger text-lg leading-none"
              aria-label="Dismiss error"
            >
              <CloseIcon size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        {truncated && (
          <div
            role="status"
            className="m-3 px-3 py-2 text-sm bg-status-warning/10 border border-status-warning/30 text-status-warning rounded-lg"
          >
            Showing the first {truncated.returned.toLocaleString()} objects.{' '}
            This folder holds more — use search or filters to narrow it down.
          </div>
        )}
        {loading ? (
          <div className="flex flex-col justify-center items-center h-48 gap-3">
            <Loader2 className="w-6 h-6 text-gale-teal animate-spin" />
            <span className="text-zinc-400 text-sm">Loading…</span>
          </div>
        ) : (
          <div className="file-list">
            <table className="file-table text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900 text-zinc-400 text-xs font-medium">
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all visible remote items"
                      checked={filteredObjects.length > 0 && selectedItems.size === filteredObjects.length}
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
                    <button type="button" onClick={() => handleSort('date')}>Last Modified {sortKey === 'date' && (sortDirection === 'asc' ? '↑' : '↓')}</button>
                  </th>
                </tr>
              </thead>
              <tbody ref={tbodyRef} className="divide-y divide-zinc-800/50 text-sm text-zinc-200">
                {filteredObjects.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-14 text-center text-zinc-500">
                      <div className="flex flex-col items-center gap-3 max-w-sm mx-auto">
                        {listFailed ? (
                          <>
                            <AlertTriangle className="w-10 h-10 text-status-danger" />
                            <p className="text-sm text-zinc-300">Couldn&apos;t load this folder</p>
                            <p className="text-xs text-zinc-500">
                              Its contents are unknown — this is not an empty folder.
                            </p>
                            <button
                              type="button"
                              onClick={() => fetchDirectory(prefix)}
                              className="mt-1 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-medium text-zinc-200"
                            >
                              Try again
                            </button>
                          </>
                        ) : searchQuery || filterType !== 'all' ? (
                          <>
                            <Folder className="w-10 h-10 text-zinc-600 opacity-70" />
                            <p className="text-sm text-zinc-400">No matching items</p>
                            <button
                              type="button"
                              onClick={() => { setSearchQuery(''); setFilterType('all'); }}
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
                              Upload files or create a folder to get started.
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <button
                                type="button"
                                onClick={handleUpload}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-xs font-semibold"
                              >
                                <Upload className="w-3.5 h-3.5" />
                                Upload
                              </button>
                              <button
                                type="button"
                                onClick={() => openCreateFolder()}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs font-medium text-zinc-200"
                              >
                                <Plus className="w-3.5 h-3.5" />
                                New folder
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  <>
                    {hasTopSpacer && (
                      <tr aria-hidden="true" className="galeon-spacer">
                        <td colSpan={4} style={{ height: topSpacer }} />
                      </tr>
                    )}
                    {visibleRows.map((obj, windowIndex) => {
                      const index = rowIndexOf(windowIndex);
                      return (
                    <tr
                      key={obj.fullKey}
                      data-row-index={index}
                      draggable={obj.objectType === 'file'}
                      aria-selected={selectedItems.has(obj.fullKey)}
                      onDragStart={(e) => {
                        if (obj.objectType !== 'file') { e.preventDefault(); return; }
                        e.dataTransfer.setData(GALEON_REMOTE_KEYS_MIME, JSON.stringify(remoteDragKeys(obj)));
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={(e) => {
                        if (isInteractiveTarget(e.target)) return;
                        // The pane takes the focus so the arrow keys keep
                        // walking the rows straight after a click.
                        paneRef.current?.focus();
                        handleSelectItem(obj.fullKey, index, {
                          shift: e.shiftKey,
                          toggle: e.metaKey || e.ctrlKey,
                        });
                      }}
                      onDoubleClick={() => handleDoubleClick(obj)}
                      onContextMenu={(e) => handleRowContextMenu(e, obj, index)}
                      className={`hover:bg-zinc-800/40 cursor-pointer transition-colors ${
                        selectedItems.has(obj.fullKey) ? 'bg-gale-teal/10 border-l-2 border-gale-teal' : ''
                      } ${index === cursorIndex ? 'is-cursor' : ''}`}
                    >
                      <td className="px-4 py-4">
                        <input
                          type="checkbox"
                          aria-label={`Select ${obj.name}`}
                          checked={selectedItems.has(obj.fullKey)}
                          onChange={() => {}}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectItem(obj.fullKey, index, {
                              toggle: !e.shiftKey,
                              shift: e.shiftKey,
                            });
                          }}
                          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-gale-teal focus:ring-gale-teal focus:ring-1 accent-gale-teal"
                        />
                      </td>
                      <td className="px-6 py-4">
                        <div className="file-name">
                        {obj.objectType === 'folder' ? (
                          <Folder className="w-5 h-5 text-gale-teal flex-shrink-0" />
                        ) : (
                          <File className="w-5 h-5 text-zinc-400 flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <button type="button" onClick={(event) => { event.stopPropagation(); handleSelectItem(obj.fullKey, index, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey }); }}
                            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); handleDoubleClick(obj); } }} title={obj.name} className="block max-w-full hover:text-gale-teal">{obj.name}</button>
                          <span className="compact-date">{obj.lastModified ? new Date(obj.lastModified).toLocaleString() : '—'}</span>
                        </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-zinc-400 metric-text">{renderObjectSize(obj)}</td>
                      <td className="px-6 py-4 text-zinc-400 metric-text">
                        {obj.lastModified ? new Date(obj.lastModified).toLocaleString() : '-'}
                      </td>
                    </tr>
                      );
                    })}
                    {hasBottomSpacer && (
                      <tr aria-hidden="true" className="galeon-spacer">
                        <td colSpan={4} style={{ height: bottomSpacer }} />
                      </tr>
                    )}
                  </>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {activeMenu && objects.find(obj => obj.fullKey === activeMenu) && createPortal(
        <ObjectContextMenu
          obj={objects.find(obj => obj.fullKey === activeMenu)!}
          menuPosition={menuPosition}
          protocol={protocol}
          capabilities={capabilities}
          downloadDestination={downloadDestination}
          onClose={() => setActiveMenu(null)}
          onAction={handleMenuAction}
        />, document.body
      )}

      {dialogs}

      {showConflictModal && (
        <ConflictDialog
          fileName={conflictFile}
          pendingCount={pendingConflicts.length}
          applyToAll={applyToAll}
          onApplyToAllChange={setApplyToAll}
          onResolve={handleConflictResolve}
        />
      )}

      {/* Floating Batch Toolbar */}
      {selectedItems.size > 0 && (
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
              onClick={handleBatchDownload}
              className="flex items-center space-x-1 px-3 py-1.5 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-semibold transition-colors animate-fade-in"
            >
              <Download className="w-4 h-4" />
              <span>Download</span>
            </button>
            <button
              onClick={() => openBatchDelete()}
              className="flex items-center space-x-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium"
            >
              <Trash2 className="w-4 h-4" />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
