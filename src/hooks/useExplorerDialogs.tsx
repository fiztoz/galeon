import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ConfirmDialog,
  DestinationDialog,
  ShareLinkDialog,
  TextPromptDialog,
} from '../components/Dialogs';
import type { DirectoryListing, GaleonObject } from '../types';

/**
 * The dialogs a file pane can open.
 *
 * One discriminated union instead of a boolean per dialog: a pane can only
 * have one dialog open at a time, and the state says which one and for what.
 */
type DialogState =
  | { kind: 'none' }
  | { kind: 'create-folder' }
  | { kind: 'rename'; target: GaleonObject }
  | { kind: 'delete'; target: GaleonObject }
  | { kind: 'move'; target: GaleonObject }
  | { kind: 'copy'; target: GaleonObject }
  | { kind: 'share'; target: GaleonObject }
  | { kind: 'batch-delete' };

export type ExplorerDialogsOptions = {
  sessionId: string;
  /** The prefix the pane is showing — where a new folder is created. */
  prefix: string;
  onCreateFolder: (prefix: string, name: string) => Promise<void>;
  onRenameObject: (oldKey: string, newKey: string, isFolder: boolean) => Promise<void>;
  onDeleteObjects: (items: { key: string; isFolder: boolean }[]) => Promise<void>;
  onGeneratePresignedUrl: (key: string, expiresInSeconds: number) => Promise<string>;
  onGeneratePresignedUploadUrl?: (key: string, expiresInSeconds: number) => Promise<string>;
  onError: (message: string) => void;
  /** Re-list the current directory after a change. */
  refresh: () => void;
  /** How many objects the batch-delete confirmation is about. */
  selectedCount: number;
  /** Perform the batch delete the user just confirmed. */
  onBatchDelete: () => void;
};

/**
 * Owns a file pane's dialogs: which one is open, and what each one does.
 *
 * The pane asks for a dialog (`openRename(obj)`) and renders the result.
 * The backend calls stay as injected callbacks, so this module never
 * decides *what* a rename means — only *how* the dialog behaves.
 */
export function useExplorerDialogs(options: ExplorerDialogsOptions) {
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [availableFolders, setAvailableFolders] = useState<string[]>([]);

  const close = () => setDialog({ kind: 'none' });

  const openCreateFolder = () => setDialog({ kind: 'create-folder' });
  const openRename = (target: GaleonObject) => setDialog({ kind: 'rename', target });
  const openDelete = (target: GaleonObject) => setDialog({ kind: 'delete', target });
  const openShare = (target: GaleonObject) => setDialog({ kind: 'share', target });
  const openBatchDelete = () => setDialog({ kind: 'batch-delete' });

  /** The destination pickers need every folder in the session, not just this one. */
  const fetchAllFolders = async () => {
    try {
      const result = await invoke<DirectoryListing>('list_directory', {
        sessionId: options.sessionId,
        prefix: '',
      });
      const folders = result.objects
        .filter((obj) => obj.objectType === 'folder')
        .map((obj) => obj.fullKey);
      setAvailableFolders(folders);
    } catch (err) {
      console.error('Failed to fetch folders:', err);
    }
  };

  const openMove = (target: GaleonObject) => {
    setDialog({ kind: 'move', target });
    fetchAllFolders();
  };

  const openCopy = (target: GaleonObject) => {
    setDialog({ kind: 'copy', target });
    fetchAllFolders();
  };

  const handleCreateFolder = async (name: string) => {
    if (!name.trim()) return;
    try {
      await options.onCreateFolder(options.prefix, name.trim());
      close();
      options.refresh();
    } catch (err) {
      options.onError(String(err));
    }
  };

  const handleRename = async (newName: string) => {
    if (dialog.kind !== 'rename' || !newName.trim()) return;
    const target = dialog.target;
    try {
      // Strip trailing slash from fullKey for proper prefix calculation
      const cleanFullKey = target.fullKey.replace(/\/$/, '');
      const prefixPath = cleanFullKey.substring(0, cleanFullKey.length - target.name.length);
      const newKey = prefixPath + newName.trim();
      await options.onRenameObject(target.fullKey, newKey, target.objectType === 'folder');
      close();
      options.refresh();
    } catch (err) {
      options.onError(String(err));
    }
  };

  const handleDelete = async () => {
    if (dialog.kind !== 'delete') return;
    const target = dialog.target;
    close();
    try {
      await options.onDeleteObjects([{
        key: target.fullKey,
        isFolder: target.objectType === 'folder',
      }]);
    } catch (err) {
      options.onError(String(err));
    }
  };

  const handleMove = async (destination: string) => {
    if (dialog.kind !== 'move' || !destination) return;
    const target = dialog.target;
    try {
      const sourcePath = target.fullKey.replace(/\/$/, '');
      const sourceName = target.name;
      const destPrefix = destination === '/' ? '' : destination.replace(/\/$/, '/');
      const newKey = destPrefix + sourceName;

      if (sourcePath === newKey.replace(/\/$/, '')) {
        options.onError('Source and destination are the same');
        return;
      }

      await options.onRenameObject(sourcePath, newKey, target.objectType === 'folder');
      close();
      options.refresh();
    } catch (err) {
      options.onError(String(err));
    }
  };

  const handleCopy = async (destination: string) => {
    if (dialog.kind !== 'copy' || !destination) return;
    const target = dialog.target;
    try {
      const sourcePath = target.fullKey.replace(/\/$/, '');
      const sourceName = target.name;
      const destPrefix = destination === '/' ? '' : destination.replace(/\/$/, '/');
      const newKey = destPrefix + sourceName;

      if (sourcePath === newKey.replace(/\/$/, '')) {
        options.onError('Source and destination are the same');
        return;
      }

      await invoke('copy_object', {
        sessionId: options.sessionId,
        oldKey: sourcePath,
        newKey,
        isFolder: target.objectType === 'folder',
      });
      close();
      options.refresh();
    } catch (err) {
      options.onError(String(err));
    }
  };

  const dialogs = (
    <>
      {dialog.kind === 'create-folder' && (
        <TextPromptDialog
          title="Create New Folder"
          placeholder="Folder name"
          confirmLabel="Create"
          onConfirm={handleCreateFolder}
          onCancel={close}
        />
      )}

      {dialog.kind === 'rename' && (
        <TextPromptDialog
          title="Rename"
          placeholder="New name"
          confirmLabel="Rename"
          initialValue={dialog.target.name}
          onConfirm={handleRename}
          onCancel={close}
        />
      )}

      {dialog.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${dialog.target.objectType === 'folder' ? 'Folder' : 'File'}`}
          titleClassName="mb-2"
          confirmLabel="Delete"
          tone="danger"
          onCancel={close}
          onConfirm={handleDelete}
        >
          <p className="text-zinc-400 text-sm mb-4">
            Are you sure you want to delete <span className="text-zinc-200 font-medium">"{dialog.target.name}"</span>?
            {dialog.target.objectType === 'folder' && (
              <span className="block mt-1 text-status-warning">This will delete all contents inside the folder.</span>
            )}
          </p>
        </ConfirmDialog>
      )}

      {dialog.kind === 'move' && (
        <DestinationDialog
          title={`Move "${dialog.target.name}" to...`}
          folders={availableFolders}
          confirmLabel="Move"
          onConfirm={handleMove}
          onCancel={close}
        />
      )}

      {dialog.kind === 'copy' && (
        <DestinationDialog
          title={`Copy "${dialog.target.name}" to...`}
          folders={availableFolders}
          confirmLabel="Copy"
          onConfirm={handleCopy}
          onCancel={close}
        />
      )}

      {dialog.kind === 'share' && (
        <ShareLinkDialog
          fileName={dialog.target.name}
          onGenerate={(seconds) => options.onGeneratePresignedUrl(dialog.target.fullKey, seconds)}
          onGenerateUpload={options.onGeneratePresignedUploadUrl
            ? (seconds) => options.onGeneratePresignedUploadUrl!(dialog.target.fullKey, seconds)
            : undefined}
          onError={options.onError}
          onClose={close}
        />
      )}

      {dialog.kind === 'batch-delete' && (
        <ConfirmDialog
          title={`Delete ${options.selectedCount} Items`}
          confirmLabel="Delete All"
          tone="danger"
          onCancel={close}
          onConfirm={() => { close(); options.onBatchDelete(); }}
        >
          <p className="text-zinc-400 text-sm mb-4">
            Are you sure you want to delete {options.selectedCount} selected items?
            <span className="block mt-1 text-status-warning">This action cannot be undone.</span>
          </p>
        </ConfirmDialog>
      )}
    </>
  );

  return {
    dialogs,
    openCreateFolder,
    openRename,
    openDelete,
    openMove,
    openCopy,
    openShare,
    openBatchDelete,
  };
}
