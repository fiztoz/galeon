import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface PendingConflict {
  remoteKey: string;
  localPath: string;
  direction: 'download' | 'upload';
}

const toUploadTargets = (paths: string[], prefix: string) =>
  paths.map((filePath) => {
    const fileName = filePath.split(/[/\\]/).pop() || 'file';
    return { localPath: filePath, remoteKey: prefix ? `${prefix}${fileName}` : fileName };
  });

interface UploadPipelineOptions {
  sessionId: string;
  prefix: string;
  onInitiateUpload: (localPath: string, remoteKey: string) => void;
  onInitiateDownload: (remoteKey: string, localPath: string) => void;
}

export function useUploadPipeline({ sessionId, prefix, onInitiateUpload, onInitiateDownload }: UploadPipelineOptions) {
  const [isDragging, setIsDragging] = useState(false);

  // Conflict resolution state
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [conflictFile, setConflictFile] = useState<string>('');
  const [applyToAll, setApplyToAll] = useState(false);
  const [pendingConflicts, setPendingConflicts] = useState<PendingConflict[]>([]);

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

  return { isDragging, showConflictModal, conflictFile, applyToAll, setApplyToAll,
    pendingConflicts, checkFileExists, startConflictCheck, handleConflictResolve, handleUpload };
}
