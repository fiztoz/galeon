import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save, open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Folder, File, ChevronRight, Download, Upload, Plus, Trash2, Pencil, MoreVertical, FolderInput, FolderDown, Share2, Copy, Info, Loader2, Eye, PenLine, AlertTriangle } from 'lucide-react';
import { ProtocolCapabilities } from '../types';
import {
  ConflictDialog,
  ConfirmDialog,
  DestinationDialog,
  ShareLinkDialog,
  TextPromptDialog,
} from './Dialogs';
import { isPreviewableFile } from './PropertiesInspector';

export interface GaleonObject {
  name: string;
  fullKey: string;
  objectType: 'folder' | 'file';
  sizeBytes: number | null;
  lastModified: string | null;
}

interface PendingConflict {
  remoteKey: string;
  localPath: string;
  direction: 'download' | 'upload';
}

const toUploadTargets = (paths: string[], prefix: string) =>
  paths.map((filePath) => {
    const fileName = filePath.split(/[/\\]/).pop() || 'file';
    return { localPath: filePath, remoteKey: prefix ? `${prefix}${fileName}` : fileName };
  });

/** Format byte count to human-readable size string. Reused by LocalPane. */
export const formatSize = (bytes: number | null) => {
  if (bytes === null) return '-';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

interface PrefixSizeProgress {
  jobId: string;
  prefix: string;
  totalBytes: number;
  fileCount: number;
  complete: boolean;
  cancelled: boolean;
  error?: string;
}

interface ComputePrefixSizeResponse {
  jobId: string;
  cached: boolean;
  totalBytes?: number;
  fileCount?: number;
}

type FolderSizeEntry = {
  status: 'loading' | 'ready' | 'error';
  totalBytes?: number;
  fileCount?: number;
};

const FOLDER_SIZE_CONCURRENCY = 2;

interface ExplorerProps {
  sessionId: string;
  bucket: string;
  protocol?: 's3' | 'sftp' | 'ftp' | 'ftps';
  capabilities?: ProtocolCapabilities;
  onInitiateDownload: (remoteKey: string, localPath: string) => void;
  onInitiateUpload: (localPath: string, remoteKey: string) => void;
  onCreateFolder: (prefix: string, folderName: string) => Promise<void>;
  onDeleteObjects: (items: { key: string; isFolder: boolean }[]) => Promise<void>;
  onRenameObject: (oldKey: string, newKey: string, isFolder: boolean) => Promise<void>;
  onGeneratePresignedUrl: (key: string, expiresInSeconds: number) => Promise<string>;
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
  const [prefix, setPrefix] = useState('');
  const [objects, setObjects] = useState<GaleonObject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Distinct from `error`, which any action (delete, rename…) can set: this means the
  // current listing failed, so the rows we show are unknown rather than empty.
  const [listFailed, setListFailed] = useState(false);

  // Modal states
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [renameTarget, setRenameTarget] = useState<GaleonObject | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GaleonObject | null>(null);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [moveTarget, setMoveTarget] = useState<GaleonObject | null>(null);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [copyTarget, setCopyTarget] = useState<GaleonObject | null>(null);
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);
  const [showShareModal, setShowShareModal] = useState(false);
  const [shareTarget, setShareTarget] = useState<GaleonObject | null>(null);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  
  // Search, Filter, Sort states
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'folders' | 'files'>('all');
  const [sortKey, setSortKey] = useState<'name' | 'size' | 'date'>('name');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  
  // Multi-select states
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  
  // Conflict resolution state
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [conflictFile, setConflictFile] = useState<string>('');
  const [applyToAll, setApplyToAll] = useState(false);
  const [pendingConflicts, setPendingConflicts] = useState<PendingConflict[]>([]);

  // Prefix / folder size state (computed in background)
  const [prefixSizeBytes, setPrefixSizeBytes] = useState<number | null>(null);
  const [prefixFileCount, setPrefixFileCount] = useState<number | null>(null);
  const [prefixSizeLoading, setPrefixSizeLoading] = useState(false);
  const [prefixSizeError, setPrefixSizeError] = useState('');
  const [folderSizes, setFolderSizes] = useState<Record<string, FolderSizeEntry>>({});
  const prefixSizeJobRef = useRef<string | null>(null);
  const prefixSizeLocalCache = useRef<Record<string, { totalBytes: number; fileCount: number }>>({});
  const folderJobRefs = useRef<Map<string, string>>(new Map());
  const folderQueueRef = useRef<string[]>([]);
  const folderRunningRef = useRef(0);
  const folderSizesRef = useRef(folderSizes);
  folderSizesRef.current = folderSizes;
  const listNonceRef = useRef(0);

  const prefixSizeCacheKey = (targetPrefix: string) => `${sessionId}:${targetPrefix}`;

  const savePrefixSizeToLocalCache = (targetPrefix: string, totalBytes: number, fileCount: number) => {
    prefixSizeLocalCache.current[prefixSizeCacheKey(targetPrefix)] = { totalBytes, fileCount };
  };

  // Upload pre-flight: route uploads whose remote key already exists
  // through the conflict modal instead of silently overwriting
  const initiateUploadsWithConflictCheck = async (
    files: Array<{ localPath: string; remoteKey: string }>
  ) => {
    const conflicts: PendingConflict[] = [];
    for (const f of files) {
      let exists = false;
      try {
        exists = await invoke<boolean>('check_remote_exists', { sessionId, key: f.remoteKey });
      } catch {
        exists = false; // can't tell — behave like before the check existed
      }
      if (exists) {
        conflicts.push({ remoteKey: f.remoteKey, localPath: f.localPath, direction: 'upload' });
      } else {
        onInitiateUpload(f.localPath, f.remoteKey);
      }
    }
    startConflictCheck(conflicts);
  };
  // Ref so the drag-drop listener (subscribed once per prefix) always calls
  // the latest closure without re-registering on every render
  const uploadWithCheckRef = useRef(initiateUploadsWithConflictCheck);
  uploadWithCheckRef.current = initiateUploadsWithConflictCheck;

  // Listen for native Tauri Drag-and-Drop events
  useEffect(() => {
    let active = true;
    let unlistenOver: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    let unlistenLeave: (() => void) | null = null;

    const setupListeners = async () => {
      const window = getCurrentWindow();
      
      const over = await window.listen<{ paths: string[] }>('tauri://drag-over', () => {
        if (active) setIsDragging(true);
      });
      if (!active) { over(); return; }
      unlistenOver = over;

      const drop = await window.listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
        if (!active) return;
        setIsDragging(false);
        uploadWithCheckRef.current(toUploadTargets(event.payload.paths, prefix));
      });
      if (!active) { drop(); return; }
      unlistenDrop = drop;

      const leave = await window.listen('tauri://drag-leave', () => {
        if (active) setIsDragging(false);
      });
      if (!active) { leave(); return; }
      unlistenLeave = leave;
    };

    setupListeners();

    return () => {
      active = false;
      if (unlistenOver) unlistenOver();
      if (unlistenDrop) unlistenDrop();
      if (unlistenLeave) unlistenLeave();
    };
  }, [prefix, onInitiateUpload]);

  const fetchDirectory = async (currentPrefix: string) => {
    // Listings race: prefix changes, Refresh, and create/delete/rename all fire one.
    // Only the most recent request may touch state, otherwise a slow failure for a
    // folder we already navigated away from wipes the rows we are actually showing.
    const nonce = ++listNonceRef.current;
    setLoading(true);
    setError('');
    setListFailed(false);
    try {
      const res = await invoke<GaleonObject[]>('list_directory', {
        sessionId,
        prefix: currentPrefix,
      });
      if (nonce !== listNonceRef.current) return;
      setObjects(res);
    } catch (err: unknown) {
      if (nonce !== listNonceRef.current) return;
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      setError(msg.replace(/^Error:\s*/i, '') || 'Failed to list directory.');
      setListFailed(true);
      setObjects([]);
    } finally {
      // A newer request owns the spinner from here on.
      if (nonce === listNonceRef.current) setLoading(false);
    }
  };

  const cancelPrefixSizeJob = (jobId: string | null) => {
    if (!jobId) return;
    invoke('cancel_prefix_size', { jobId }).catch(() => {});
  };

  const applyComputePrefixSizeResponse = (
    res: ComputePrefixSizeResponse,
    targetPrefix: string,
    onCached: (totalBytes: number, fileCount: number) => void,
  ) => {
    if (res.cached && res.totalBytes != null) {
      const fileCount = res.fileCount ?? 0;
      savePrefixSizeToLocalCache(targetPrefix, res.totalBytes, fileCount);
      onCached(res.totalBytes, fileCount);
    }
  };

  const startFolderSizeScan = (folderKey: string) => {
    invoke<ComputePrefixSizeResponse>('compute_prefix_size', { sessionId, prefix: folderKey })
      .then((res) => {
        folderJobRefs.current.set(res.jobId, folderKey);
        if (res.cached && res.totalBytes != null) {
          folderJobRefs.current.delete(res.jobId);
          folderRunningRef.current = Math.max(0, folderRunningRef.current - 1);
          applyComputePrefixSizeResponse(res, folderKey, (totalBytes, fileCount) => {
            setFolderSizes((prev) => ({
              ...prev,
              [folderKey]: { status: 'ready', totalBytes, fileCount },
            }));
          });
          drainFolderSizeQueue();
          return;
        }
        setFolderSizes((prev) => ({
          ...prev,
          [folderKey]: { status: 'loading' },
        }));
      })
      .catch(() => {
        setFolderSizes((prev) => ({
          ...prev,
          [folderKey]: { status: 'error' },
        }));
        folderRunningRef.current = Math.max(0, folderRunningRef.current - 1);
        drainFolderSizeQueue();
      });
  };

  const drainFolderSizeQueue = () => {
    while (
      folderRunningRef.current < FOLDER_SIZE_CONCURRENCY &&
      folderQueueRef.current.length > 0
    ) {
      const folderKey = folderQueueRef.current.shift();
      if (!folderKey) break;
      const existing = folderSizesRef.current[folderKey];
      if (existing?.status === 'ready' || existing?.status === 'loading') {
        continue;
      }
      folderRunningRef.current += 1;
      startFolderSizeScan(folderKey);
    }
  };

  const cancelInFlightFolderSizeJobs = () => {
    for (const jobId of folderJobRefs.current.keys()) {
      cancelPrefixSizeJob(jobId);
    }
    folderJobRefs.current.clear();
    folderQueueRef.current = [];
    folderRunningRef.current = 0;
  };

  useEffect(() => {
    const unsub = listen<PrefixSizeProgress>('prefix-size-progress', (ev) => {
      const {
        jobId,
        totalBytes,
        fileCount,
        complete,
        cancelled,
        error,
      } = ev.payload;

      if (jobId === prefixSizeJobRef.current) {
        if (!complete) {
          setPrefixSizeLoading(true);
          setPrefixSizeBytes(totalBytes);
          setPrefixFileCount(fileCount);
          return;
        }
        if (cancelled) return;
        setPrefixSizeLoading(false);
        if (error) {
          setPrefixSizeError(error);
          setPrefixSizeBytes(null);
          setPrefixFileCount(null);
        } else {
          setPrefixSizeError('');
          setPrefixSizeBytes(totalBytes);
          setPrefixFileCount(fileCount);
          savePrefixSizeToLocalCache(ev.payload.prefix, totalBytes, fileCount);
        }
        return;
      }

      const folderKey = folderJobRefs.current.get(jobId);
      if (!folderKey) return;

      if (!complete) {
        setFolderSizes((prev) => ({
          ...prev,
          [folderKey]: { status: 'loading', totalBytes, fileCount },
        }));
        return;
      }

      folderJobRefs.current.delete(jobId);
      folderRunningRef.current = Math.max(0, folderRunningRef.current - 1);

      if (cancelled) {
        drainFolderSizeQueue();
        return;
      }

      if (!error) {
        savePrefixSizeToLocalCache(folderKey, totalBytes, fileCount);
      }
      setFolderSizes((prev) => ({
        ...prev,
        [folderKey]: error
          ? { status: 'error' }
          : { status: 'ready', totalBytes, fileCount },
      }));
      drainFolderSizeQueue();
    });

    return () => {
      unsub.then((fn) => fn()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!isS3) {
      cancelPrefixSizeJob(prefixSizeJobRef.current);
      prefixSizeJobRef.current = null;
      setPrefixSizeLoading(false);
      setPrefixSizeBytes(null);
      setPrefixFileCount(null);
      setPrefixSizeError('');
      return;
    }
    if (loading) return;

    cancelPrefixSizeJob(prefixSizeJobRef.current);
    prefixSizeJobRef.current = null;
    setPrefixSizeError('');

    const localCached = prefixSizeLocalCache.current[prefixSizeCacheKey(prefix)];
    if (localCached) {
      setPrefixSizeBytes(localCached.totalBytes);
      setPrefixFileCount(localCached.fileCount);
      setPrefixSizeLoading(false);
    } else {
      setPrefixSizeLoading(true);
      setPrefixSizeBytes(null);
      setPrefixFileCount(null);
    }

    invoke<ComputePrefixSizeResponse>('compute_prefix_size', { sessionId, prefix })
      .then((res) => {
        prefixSizeJobRef.current = res.jobId;
        applyComputePrefixSizeResponse(res, prefix, (totalBytes, fileCount) => {
          setPrefixSizeLoading(false);
          setPrefixSizeBytes(totalBytes);
          setPrefixFileCount(fileCount);
        });
      })
      .catch((err) => {
        setPrefixSizeLoading(false);
        setPrefixSizeError(String(err));
      });
  }, [prefix, loading, sessionId, isS3]);

  useEffect(() => {
    if (!isS3) {
      cancelInFlightFolderSizeJobs();
      setFolderSizes({});
      return;
    }
    if (loading) return;

    cancelInFlightFolderSizeJobs();

    const folders = objects
      .filter((obj) => obj.objectType === 'folder')
      .map((obj) => obj.fullKey);

    const restoredFromCache: Record<string, FolderSizeEntry> = {};
    const toScan: string[] = [];

    for (const folderKey of folders) {
      if (folderSizesRef.current[folderKey]?.status === 'ready') {
        continue;
      }
      const cached = prefixSizeLocalCache.current[prefixSizeCacheKey(folderKey)];
      if (cached) {
        restoredFromCache[folderKey] = {
          status: 'ready',
          totalBytes: cached.totalBytes,
          fileCount: cached.fileCount,
        };
      } else {
        toScan.push(folderKey);
      }
    }

    if (Object.keys(restoredFromCache).length > 0) {
      setFolderSizes((prev) => ({ ...prev, ...restoredFromCache }));
    }

    folderQueueRef.current = toScan;
    drainFolderSizeQueue();
  }, [objects, loading, sessionId, isS3]);

  useEffect(() => {
    return () => {
      cancelPrefixSizeJob(prefixSizeJobRef.current);
      for (const jobId of folderJobRefs.current.keys()) {
        cancelPrefixSizeJob(jobId);
      }
    };
  }, []);

  // Filtered and sorted objects
  const filteredObjects = React.useMemo(() => {
    let result = [...objects];
    
    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(obj => obj.name.toLowerCase().includes(query));
    }
    
    // Apply type filter
    if (filterType === 'folders') {
      result = result.filter(obj => obj.objectType === 'folder');
    } else if (filterType === 'files') {
      result = result.filter(obj => obj.objectType === 'file');
    }
    
    // Apply sorting
    result.sort((a, b) => {
      // Folders always come first
      if (a.objectType === 'folder' && b.objectType !== 'folder') return -1;
      if (a.objectType !== 'folder' && b.objectType === 'folder') return 1;
      
      let comparison = 0;
      switch (sortKey) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'size': {
          const sizeOf = (obj: GaleonObject) => {
            if (obj.objectType === 'file') return obj.sizeBytes || 0;
            return folderSizes[obj.fullKey]?.totalBytes || 0;
          };
          comparison = sizeOf(a) - sizeOf(b);
          break;
        }
        case 'date':
          const dateA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
          const dateB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
          comparison = dateA - dateB;
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    
    return result;
  }, [objects, searchQuery, filterType, sortKey, sortDirection, folderSizes]);

  const handleSort = (key: 'name' | 'size' | 'date') => {
    if (sortKey === key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  // Multi-select handlers
  const handleSelectItem = (key: string, index: number, shiftKey: boolean = false) => {
    const newSelected = new Set(selectedItems);
    
    if (shiftKey && lastSelectedIndex !== null) {
      // Range select
      const startIndex = Math.min(lastSelectedIndex, index);
      const endIndex = Math.max(lastSelectedIndex, index);
      for (let i = startIndex; i <= endIndex; i++) {
        if (filteredObjects[i]) {
          newSelected.add(filteredObjects[i].fullKey);
        }
      }
    } else {
      // Toggle select
      if (newSelected.has(key)) {
        newSelected.delete(key);
      } else {
        newSelected.add(key);
      }
    }
    
    setSelectedItems(newSelected);
    setLastSelectedIndex(index);
  };

  const handleSelectAll = () => {
    if (selectedItems.size === filteredObjects.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(filteredObjects.map(obj => obj.fullKey)));
    }
  };

  const clearSelection = () => {
    setSelectedItems(new Set());
    setLastSelectedIndex(null);
  };

  const handleBatchDownload = async () => {
    let localPath: string | null = null;

    if (downloadDestination) {
      localPath = downloadDestination;
    } else {
      const { open } = await import('@tauri-apps/plugin-dialog');
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

    setShowBatchDeleteConfirm(false);
    clearSelection();
    try {
      await onDeleteObjects(items);
    } catch (err: any) {
      setError(String(err));
    }
  };

  useEffect(() => {
    fetchDirectory(prefix);
    onPrefixChange?.(prefix);
  }, [prefix]);

  // Cross-component navigation (e.g. Command Palette "Go to path")
  useEffect(() => {
    if (navRequest) setPrefix(navRequest.path);
  }, [navRequest?.nonce]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClose = () => setActiveMenu(null);
    if (activeMenu) {
      document.addEventListener('click', handleClose);
      document.addEventListener('contextmenu', handleClose);
      return () => {
        document.removeEventListener('click', handleClose);
        document.removeEventListener('contextmenu', handleClose);
      };
    }
  }, [activeMenu]);

  const normalizeFsPath = (path: string) => path.replace(/\/+/g, '/');

  const handleDoubleClick = (obj: GaleonObject) => {
    if (obj.objectType === 'folder') {
      setPrefix(isFsProtocol ? normalizeFsPath(obj.fullKey) : obj.fullKey);
    }
  };

  const openItemMenu = (obj: GaleonObject, x: number, y: number) => {
    const menuWidth = 160;
    const menuHeight = 320;
    setMenuPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
    setActiveMenu(obj.fullKey);
  };

  const handleRowContextMenu = (e: React.MouseEvent, obj: GaleonObject, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedItems.has(obj.fullKey)) {
      setSelectedItems(new Set([obj.fullKey]));
      setLastSelectedIndex(index);
    }
    openItemMenu(obj, e.clientX, e.clientY);
  };

  // Conflict resolution helpers
  const checkFileExists = async (path: string): Promise<boolean> => {
    try {
      return await invoke<boolean>('check_file_exists', { path });
    } catch {
      return false;
    }
  };

  const conflictDisplayName = (item: PendingConflict) =>
    (item.direction === 'upload'
      ? item.remoteKey.split('/')
      : item.localPath.split(/[/\\]/)
    ).pop() || item.remoteKey;

  const startConflictCheck = (files: PendingConflict[]) => {
    if (files.length === 0) return;
    setPendingConflicts(files);
    setConflictFile(conflictDisplayName(files[0]));
    setShowConflictModal(true);
    setApplyToAll(false);
  };

  const initiateConflictItem = (item: PendingConflict) => {
    if (item.direction === 'upload') {
      onInitiateUpload(item.localPath, item.remoteKey);
    } else {
      onInitiateDownload(item.remoteKey, item.localPath);
    }
  };

  // Rename targets the side being written: the remote key for uploads,
  // the local path for downloads (preserve OS path separator locally)
  const withRenamedTarget = (item: PendingConflict): PendingConflict => {
    const addSuffix = (fileName: string) => {
      const dotIdx = fileName.lastIndexOf('.');
      return dotIdx > 0
        ? fileName.substring(0, dotIdx) + ' (1)' + fileName.substring(dotIdx)
        : fileName + ' (1)';
    };
    if (item.direction === 'upload') {
      const parts = item.remoteKey.split('/');
      const renamed = addSuffix(parts.pop() || 'file');
      return { ...item, remoteKey: [...parts, renamed].join('/') };
    }
    const sep = item.localPath.includes('\\') ? '\\' : '/';
    const parts = item.localPath.split(/[/\\]/);
    const renamed = addSuffix(parts.pop() || 'file');
    return { ...item, localPath: [...parts, renamed].join(sep) };
  };

  const handleConflictResolve = (action: 'overwrite' | 'skip' | 'rename') => {
    if (pendingConflicts.length === 0) return;
    const [current, ...remaining] = pendingConflicts;

    const resolve = (item: PendingConflict) => {
      if (action === 'skip') return;
      initiateConflictItem(action === 'rename' ? withRenamedTarget(item) : item);
    };

    resolve(current);
    if (applyToAll) {
      remaining.forEach(resolve);
    }
    if (applyToAll || remaining.length === 0) {
      setPendingConflicts([]);
      setShowConflictModal(false);
    } else {
      setPendingConflicts(remaining);
      setConflictFile(conflictDisplayName(remaining[0]));
    }
  };

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

  const handleUpload = async () => {
    try {
      const selected = await open({
        multiple: true,
        title: 'Select files to upload',
      });
      
      if (selected) {
        const files = Array.isArray(selected) ? selected : [selected];
        await initiateUploadsWithConflictCheck(toUploadTargets(files, prefix));
      }
    } catch (err) {
      console.error(err);
    }
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
      newFolder: () => setShowCreateFolder(true),
      upload: () => uploadRef.current(),
    });
  }, [onRegisterCommands]);

  const handleCreateFolder = async (name: string) => {
    if (!name.trim()) return;
    try {
      await onCreateFolder(prefix, name.trim());
      setShowCreateFolder(false);
      await fetchDirectory(prefix);
    } catch (err: any) {
      setError(String(err));
    }
  };

  const handleRename = async (newName: string) => {
    if (!renameTarget || !newName.trim()) return;
    try {
      // Strip trailing slash from fullKey for proper prefix calculation
      const cleanFullKey = renameTarget.fullKey.replace(/\/$/, '');
      const prefixPath = cleanFullKey.substring(0, cleanFullKey.length - renameTarget.name.length);
      const newKey = prefixPath + newName.trim();
      await onRenameObject(renameTarget.fullKey, newKey, renameTarget.objectType === 'folder');
      setShowRename(false);
      setRenameTarget(null);
      await fetchDirectory(prefix);
    } catch (err: any) {
      setError(String(err));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setShowDeleteConfirm(false);
    setDeleteTarget(null);
    try {
      await onDeleteObjects([{
        key: target.fullKey,
        isFolder: target.objectType === 'folder',
      }]);
    } catch (err: any) {
      setError(String(err));
    }
  };

  const fetchAllFolders = async () => {
    try {
      const result = await invoke<GaleonObject[]>('list_directory', {
        sessionId,
        prefix: '',
      });
      const folders = result
        .filter(obj => obj.objectType === 'folder')
        .map(obj => obj.fullKey);
      setAvailableFolders(folders);
    } catch (err) {
      console.error('Failed to fetch folders:', err);
    }
  };

  const handleMove = async (destination: string) => {
    if (!moveTarget || !destination) return;
    try {
      const sourcePath = moveTarget.fullKey.replace(/\/$/, '');
      const sourceName = moveTarget.name;
      const destPrefix = destination === '/' ? '' : destination.replace(/\/$/, '/');
      const newKey = destPrefix + sourceName;
      
      if (sourcePath === newKey.replace(/\/$/, '')) {
        setError('Source and destination are the same');
        return;
      }
      
      await onRenameObject(sourcePath, newKey, moveTarget.objectType === 'folder');
      setShowMoveModal(false);
      setMoveTarget(null);
      await fetchDirectory(prefix);
    } catch (err: any) {
      setError(String(err));
    }
  };

  const handleCopy = async (destination: string) => {
    if (!copyTarget || !destination) return;
    try {
      const sourcePath = copyTarget.fullKey.replace(/\/$/, '');
      const sourceName = copyTarget.name;
      const destPrefix = destination === '/' ? '' : destination.replace(/\/$/, '/');
      const newKey = destPrefix + sourceName;
      
      if (sourcePath === newKey.replace(/\/$/, '')) {
        setError('Source and destination are the same');
        return;
      }
      
      await invoke('copy_object', {
        sessionId,
        oldKey: sourcePath,
        newKey,
        isFolder: copyTarget.objectType === 'folder',
      });
      setShowCopyModal(false);
      setCopyTarget(null);
      await fetchDirectory(prefix);
    } catch (err: any) {
      setError(String(err));
    }
  };

  const renderPrefixSizeSummary = () => {
    if (!isS3) return null;
    const label = prefix ? 'Folder total' : 'Bucket total';
    if (prefixSizeError) {
      return (
        <span className="text-xs text-red-400/80 whitespace-nowrap" title={prefixSizeError}>
          {label}: unavailable
        </span>
      );
    }
    if (prefixSizeLoading && prefixSizeBytes === null) {
      return (
        <span className="flex items-center gap-1.5 text-xs text-zinc-500 whitespace-nowrap">
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
        <span className="flex items-center gap-1.5 text-xs text-zinc-500 whitespace-nowrap metric-text">
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
      <div className="flex items-center justify-between gap-3 py-3 px-4 bg-zinc-900 border-b border-zinc-800 text-sm overflow-x-auto">
        <div className="flex items-center space-x-1 min-w-0">
        {protocol === 'sftp' && (
          <span className="text-xs bg-green-900/50 text-green-400 px-2 py-0.5 rounded-full font-medium mr-1">
            SFTP
          </span>
        )}
        {protocol === 'ftp' && (
          <span className="text-xs bg-blue-900/50 text-blue-400 px-2 py-0.5 rounded-full font-medium mr-1">
            FTP
          </span>
        )}
        {protocol === 'ftps' && (
          <span className="text-xs bg-blue-900/50 text-blue-400 px-2 py-0.5 rounded-full font-medium mr-1">
            FTPS
          </span>
        )}
        <button onClick={() => setPrefix('')} className="text-gale-teal hover:text-deep-current font-medium">
          {bucket}
        </button>
        {parts.map((part, index) => {
          const path = breadcrumbPath(index);
          return (
            <React.Fragment key={index}>
              <ChevronRight className="w-4 h-4 text-zinc-500 flex-shrink-0" />
              <button onClick={() => setPrefix(path)} className="text-gale-teal hover:text-deep-current truncate font-medium">
                {part}
              </button>
            </React.Fragment>
          );
        })}
        </div>
        {renderPrefixSizeSummary()}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      {renderBreadcrumbs()}
      
      {/* Drag & Drop Visual Overlay */}
      {isDragging && (
        <div className="fixed inset-0 bg-gale-teal/5 border-2 border-dashed border-gale-teal/60 rounded-xl z-50 flex items-center justify-center pointer-events-none backdrop-blur-sm">
          <div className="bg-zinc-900/90 border border-zinc-800 px-6 py-4 rounded-xl shadow-2xl flex flex-col items-center space-y-2">
            <Upload className="w-10 h-10 text-gale-teal animate-bounce" />
            <span className="text-sm font-semibold">Drop files here to upload</span>
            <span className="text-xs text-zinc-500">Uploading to {prefix || '/'}</span>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="px-6 py-3 bg-zinc-900/50 border-b border-zinc-800 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <button
              onClick={handleUpload}
              className="flex items-center space-x-2 px-3 py-1.5 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-semibold transition-colors shadow-sm"
            >
              <Upload className="w-4 h-4" />
              <span>Upload</span>
            </button>
            <button
              onClick={() => setShowCreateFolder(true)}
              className="flex items-center space-x-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>New Folder</span>
            </button>
            <button
              onClick={() => fetchDirectory(prefix)}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
            >
              Refresh
            </button>
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all w-48"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <span className="text-xs text-zinc-500">Filter:</span>
          <button
            onClick={() => setFilterType('all')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filterType === 'all' ? 'bg-gale-teal text-on-accent font-semibold' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            All
          </button>
          <button
            onClick={() => setFilterType('folders')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filterType === 'folders' ? 'bg-gale-teal text-on-accent font-semibold' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            Folders
          </button>
          <button
            onClick={() => setFilterType('files')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filterType === 'files' ? 'bg-gale-teal text-on-accent font-semibold' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
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
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 galeon-scrollbar">
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
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/70 text-zinc-400 text-xs uppercase tracking-wider font-semibold">
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={filteredObjects.length > 0 && selectedItems.size === filteredObjects.length}
                      onChange={handleSelectAll}
                      className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-gale-teal focus:ring-gale-teal focus:ring-1 accent-gale-teal"
                    />
                  </th>
                  <th 
                    onClick={() => handleSort('name')}
                    className="px-6 py-3 cursor-pointer hover:text-zinc-200 select-none"
                  >
                    Name {sortKey === 'name' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th 
                    onClick={() => handleSort('size')}
                    className="px-6 py-3 w-40 cursor-pointer hover:text-zinc-200 select-none"
                  >
                    Size {sortKey === 'size' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th 
                    onClick={() => handleSort('date')}
                    className="px-6 py-3 w-60 cursor-pointer hover:text-zinc-200 select-none"
                  >
                    Last Modified {sortKey === 'date' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th className="px-6 py-3 w-20 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50 text-sm text-zinc-200">
                {filteredObjects.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-14 text-center text-zinc-500">
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
                                onClick={() => setShowCreateFolder(true)}
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
                  filteredObjects.map((obj, index) => (
                    <tr
                      key={obj.fullKey}
                      onDoubleClick={() => handleDoubleClick(obj)}
                      onContextMenu={(e) => handleRowContextMenu(e, obj, index)}
                      className={`hover:bg-zinc-800/40 cursor-pointer transition-colors ${
                        selectedItems.has(obj.fullKey) ? 'bg-gale-teal/10 border-l-2 border-gale-teal' : ''
                      }`}
                    >
                      <td className="px-4 py-4">
                        <input
                          type="checkbox"
                          checked={selectedItems.has(obj.fullKey)}
                          onChange={() => {}}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectItem(obj.fullKey, index, e.shiftKey);
                          }}
                          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-gale-teal focus:ring-gale-teal focus:ring-1 accent-gale-teal"
                        />
                      </td>
                      <td className="px-6 py-4 flex items-center space-x-3 max-w-lg truncate">
                        {obj.objectType === 'folder' ? (
                          <Folder className="w-5 h-5 text-gale-teal flex-shrink-0" />
                        ) : (
                          <File className="w-5 h-5 text-zinc-400 flex-shrink-0" />
                        )}
                        <span className="truncate">{obj.name}</span>
                      </td>
                      <td className="px-6 py-4 text-zinc-400 metric-text">{renderObjectSize(obj)}</td>
                      <td className="px-6 py-4 text-zinc-400 metric-text">
                        {obj.lastModified ? new Date(obj.lastModified).toLocaleString() : '-'}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (activeMenu === obj.fullKey) {
                              setActiveMenu(null);
                              return;
                            }
                            const rect = e.currentTarget.getBoundingClientRect();
                            openItemMenu(obj, rect.right - 160, rect.bottom + 4);
                          }}
                          className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200 transition-colors"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Context Menu Portal */}
      {activeMenu && (
        <div
          className="fixed min-w-[10.5rem] bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-[9999] py-1"
          style={{ left: menuPosition.x, top: menuPosition.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {(() => {
            const obj = objects.find(o => o.fullKey === activeMenu);
            if (!obj) return null;

            const menuBtn = (className = 'text-zinc-200') =>
              `w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-zinc-700 whitespace-nowrap ${className}`;

            return (
              <>
                {obj.objectType === 'file' && (
                  <>
                    <button
                      onClick={() => handleDownload(obj)}
                      className={menuBtn()}
                    >
                      <Download className="w-4 h-4 shrink-0" />
                      <span>Download</span>
                    </button>
                    {downloadDestination && (
                      <button
                        onClick={() => handleDownloadHere(obj)}
                        className={menuBtn()}
                      >
                        <FolderDown className="w-4 h-4 shrink-0" />
                        <span>Download here</span>
                      </button>
                    )}
                    {isPreviewableFile(obj.fullKey, protocol) && (
                      <button
                        onClick={() => {
                          onShowPreview?.(obj);
                          setActiveMenu(null);
                        }}
                        className={menuBtn()}
                      >
                        <Eye className="w-4 h-4 shrink-0" />
                        <span>Preview</span>
                      </button>
                    )}
                    {capabilities?.supportsPresignedUrls && (
                      <button
                        onClick={() => {
                          setShareTarget(obj);
                          setShowShareModal(true);
                          setActiveMenu(null);
                        }}
                        className={menuBtn()}
                      >
                        <Share2 className="w-4 h-4 shrink-0" />
                        <span>Share Link</span>
                      </button>
                    )}
                    <button
                      onClick={() => {
                        onEditRemoteFile?.(obj.fullKey);
                        setActiveMenu(null);
                      }}
                      className={menuBtn()}
                    >
                      <PenLine className="w-4 h-4 shrink-0" />
                      <span>Edit Externally</span>
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    onShowProperties?.(obj);
                    setActiveMenu(null);
                  }}
                  className={menuBtn()}
                >
                  <Info className="w-4 h-4 shrink-0" />
                  <span>Properties</span>
                </button>
                <button
                  onClick={() => {
                    setRenameTarget(obj);
                    setShowRename(true);
                    setActiveMenu(null);
                  }}
                  className={menuBtn()}
                >
                  <Pencil className="w-4 h-4 shrink-0" />
                  <span>Rename</span>
                </button>
                <button
                  onClick={() => {
                    setMoveTarget(obj);
                    fetchAllFolders();
                    setShowMoveModal(true);
                    setActiveMenu(null);
                  }}
                  className={menuBtn()}
                >
                  <FolderInput className="w-4 h-4 shrink-0" />
                  <span>Move to...</span>
                </button>
                <button
                  onClick={() => {
                    setCopyTarget(obj);
                    fetchAllFolders();
                    setShowCopyModal(true);
                    setActiveMenu(null);
                  }}
                  className={menuBtn()}
                >
                  <Copy className="w-4 h-4 shrink-0" />
                  <span>Copy to...</span>
                </button>
                <button
                  onClick={() => {
                    setDeleteTarget(obj);
                    setShowDeleteConfirm(true);
                    setActiveMenu(null);
                  }}
                  className={menuBtn('text-red-400')}
                >
                  <Trash2 className="w-4 h-4 shrink-0" />
                  <span>Delete</span>
                </button>
              </>
            );
          })()}
        </div>
      )}

      {/* Create Folder Modal */}
      {showCreateFolder && (
        <TextPromptDialog
          title="Create New Folder"
          placeholder="Folder name"
          confirmLabel="Create"
          onConfirm={handleCreateFolder}
          onCancel={() => setShowCreateFolder(false)}
        />
      )}

      {showRename && renameTarget && (
        <TextPromptDialog
          title="Rename"
          placeholder="New name"
          confirmLabel="Rename"
          initialValue={renameTarget.name}
          onConfirm={handleRename}
          onCancel={() => { setShowRename(false); setRenameTarget(null); }}
        />
      )}

      {showDeleteConfirm && deleteTarget && (
        <ConfirmDialog
          title={`Delete ${deleteTarget.objectType === 'folder' ? 'Folder' : 'File'}`}
          titleClassName="mb-2"
          confirmLabel="Delete"
          tone="danger"
          onCancel={() => { setShowDeleteConfirm(false); setDeleteTarget(null); }}
          onConfirm={handleDelete}
        >
          <p className="text-zinc-400 text-sm mb-4">
            Are you sure you want to delete <span className="text-zinc-200 font-medium">"{deleteTarget.name}"</span>?
            {deleteTarget.objectType === 'folder' && (
              <span className="block mt-1 text-yellow-400">This will delete all contents inside the folder.</span>
            )}
          </p>
        </ConfirmDialog>
      )}

      {showMoveModal && moveTarget && (
        <DestinationDialog
          title={`Move "${moveTarget.name}" to...`}
          folders={availableFolders}
          confirmLabel="Move"
          onConfirm={handleMove}
          onCancel={() => { setShowMoveModal(false); setMoveTarget(null); }}
        />
      )}

      {showCopyModal && copyTarget && (
        <DestinationDialog
          title={`Copy "${copyTarget.name}" to...`}
          folders={availableFolders}
          confirmLabel="Copy"
          onConfirm={handleCopy}
          onCancel={() => { setShowCopyModal(false); setCopyTarget(null); }}
        />
      )}

      {showShareModal && shareTarget && (
        <ShareLinkDialog
          fileName={shareTarget.name}
          onGenerate={(seconds) => onGeneratePresignedUrl(shareTarget.fullKey, seconds)}
          onError={(message) => setError(message)}
          onClose={() => { setShowShareModal(false); setShareTarget(null); }}
        />
      )}

      {showBatchDeleteConfirm && (
        <ConfirmDialog
          title={`Delete ${selectedItems.size} Items`}
          confirmLabel="Delete All"
          tone="danger"
          onCancel={() => setShowBatchDeleteConfirm(false)}
          onConfirm={handleBatchDelete}
        >
          <p className="text-zinc-400 text-sm mb-4">
            Are you sure you want to delete {selectedItems.size} selected items?
            <span className="block mt-1 text-yellow-400">This action cannot be undone.</span>
          </p>
        </ConfirmDialog>
      )}

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
        <div className="fixed bottom-24 left-1/2 transform -translate-x-1/2 z-40">
          <div className="bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl px-4 py-3 flex items-center space-x-4">
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
              onClick={() => setShowBatchDeleteConfirm(true)}
              className="flex items-center space-x-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-medium"
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
