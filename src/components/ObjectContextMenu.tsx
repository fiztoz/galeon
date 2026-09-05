import React, { useEffect, useState } from 'react';
import { Download, FolderDown, Eye, Share2, PenLine, Info, Pencil, FolderInput, Copy, Trash2 } from 'lucide-react';
import type { GaleonObject } from './Explorer';
import type { ProtocolCapabilities } from '../types';
import { isPreviewableFile } from './PropertiesInspector';

export type ObjectMenuAction = 'download' | 'downloadHere' | 'preview' | 'share' | 'edit' | 'properties' | 'rename' | 'move' | 'copy' | 'delete';
interface ObjectContextMenuProps {
  obj: GaleonObject;
  menuPosition: { x: number; y: number };
  protocol?: 's3' | 'sftp' | 'ftp' | 'ftps';
  capabilities?: ProtocolCapabilities;
  downloadDestination?: string;
  onAction: (action: ObjectMenuAction, obj: GaleonObject) => void;
  onClose: () => void;
}

export function ObjectContextMenu({ obj, menuPosition, protocol, capabilities, downloadDestination, onAction, onClose }: ObjectContextMenuProps) {
  useEffect(() => {
    document.addEventListener('click', onClose);
    document.addEventListener('contextmenu', onClose);
    return () => {
      document.removeEventListener('click', onClose);
      document.removeEventListener('contextmenu', onClose);
    };
  }, [onClose]);
  return (
        <div
          className="fixed min-w-[10.5rem] bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-[9999] py-1"
          style={{ left: menuPosition.x, top: menuPosition.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {(() => {

            const menuBtn = (className = 'text-zinc-200') =>
              `w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-zinc-700 whitespace-nowrap ${className}`;

            return (
              <>
                {obj.objectType === 'file' && (
                  <>
                    <button
                      onClick={() => onAction('download', obj)}
                      className={menuBtn()}
                    >
                      <Download className="w-4 h-4 shrink-0" />
                      <span>Download</span>
                    </button>
                    {downloadDestination && (
                      <button
                        onClick={() => onAction('downloadHere', obj)}
                        className={menuBtn()}
                      >
                        <FolderDown className="w-4 h-4 shrink-0" />
                        <span>Download here</span>
                      </button>
                    )}
                    {isPreviewableFile(obj.fullKey, protocol) && (
                      <button
                        onClick={() => onAction('preview', obj)}
                        className={menuBtn()}
                      >
                        <Eye className="w-4 h-4 shrink-0" />
                        <span>Preview</span>
                      </button>
                    )}
                    {capabilities?.supportsPresignedUrls && (
                      <button
                        onClick={() => onAction('share', obj)}
                        className={menuBtn()}
                      >
                        <Share2 className="w-4 h-4 shrink-0" />
                        <span>Share Link</span>
                      </button>
                    )}
                    <button
                      onClick={() => onAction('edit', obj)}
                      className={menuBtn()}
                    >
                      <PenLine className="w-4 h-4 shrink-0" />
                      <span>Edit Externally</span>
                    </button>
                  </>
                )}
                <button
                  onClick={() => onAction('properties', obj)}
                  className={menuBtn()}
                >
                  <Info className="w-4 h-4 shrink-0" />
                  <span>Properties</span>
                </button>
                <button
                  onClick={() => onAction('rename', obj)}
                  className={menuBtn()}
                >
                  <Pencil className="w-4 h-4 shrink-0" />
                  <span>Rename</span>
                </button>
                <button
                  onClick={() => onAction('move', obj)}
                  className={menuBtn()}
                >
                  <FolderInput className="w-4 h-4 shrink-0" />
                  <span>Move to...</span>
                </button>
                <button
                  onClick={() => onAction('copy', obj)}
                  className={menuBtn()}
                >
                  <Copy className="w-4 h-4 shrink-0" />
                  <span>Copy to...</span>
                </button>
                <button
                  onClick={() => onAction('delete', obj)}
                  className={menuBtn('text-red-400')}
                >
                  <Trash2 className="w-4 h-4 shrink-0" />
                  <span>Delete</span>
                </button>
              </>
            );
          })()}
        </div>
  );
}

export function useObjectContextMenu(selectedItems: Set<string>, setSelectedItems: React.Dispatch<React.SetStateAction<Set<string>>>, setLastSelectedIndex: React.Dispatch<React.SetStateAction<number | null>>) {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
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

  return { activeMenu, setActiveMenu, menuPosition, openItemMenu, handleRowContextMenu };
}
