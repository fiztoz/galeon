// Cross-pane drag payload types for dual-pane transfers.
//
// These use custom DataTransfer MIME types so in-app drags never collide with
// Tauri's native OS file drop (`tauri://drag-drop` in useUploadPipeline).
// Drop targets only `preventDefault` when their expected MIME is present —
// anything else (OS files) falls through to the native handler untouched.

export const GALEON_LOCAL_PATHS_MIME = 'application/x-galeon-local-paths';
export const GALEON_REMOTE_KEYS_MIME = 'application/x-galeon-remote-keys';

export const dragHasType = (e: React.DragEvent, mime: string): boolean => {
  try {
    return Array.from(e.dataTransfer.types || []).includes(mime);
  } catch {
    return false;
  }
};

export const readDragJson = <T,>(e: React.DragEvent, mime: string): T | null => {
  try {
    const raw = e.dataTransfer.getData(mime);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};
