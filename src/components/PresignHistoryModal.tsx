import { openUrl } from '@tauri-apps/plugin-opener';
import { useState } from 'react';
import { Check, Clock, Copy, ExternalLink, Link, Trash2 } from 'lucide-react';
import type { PresignHistoryEntry } from '../types';

/** Human expiry window, e.g. "45m", "6h", "3d". Only this modal renders it. */
const formatDuration = (seconds: number) => {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

const HistoryItem: React.FC<{
  entry: PresignHistoryEntry;
  onDelete: (id: string) => void;
}> = ({ entry, onDelete }) => {
  const [copied, setCopied] = useState(false);

  const createdAt = new Date(entry.createdAt);
  const isExpired = Date.now() > createdAt.getTime() + entry.expiresInSeconds * 1000;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(entry.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleOpen = async () => {
    if (isExpired) return;
    try {
      await openUrl(entry.url);
    } catch (err) {
      console.error('Failed to open URL:', err);
    }
  };

  return (
    <div className={`p-3 rounded-lg border ${isExpired ? 'bg-zinc-900/50 border-zinc-800 opacity-60' : 'bg-zinc-800/50 border-zinc-700'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2 min-w-0">
          <span className="text-sm font-medium truncate">{entry.fileName}</span>
          {isExpired && <span className="text-xs text-red-400">Expired</span>}
        </div>
        <div className="flex items-center space-x-1">
          <button
            onClick={handleCopy}
            className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
          >
            {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={handleOpen}
            disabled={isExpired}
            title={isExpired ? 'Link expired' : 'Open in browser'}
            className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ExternalLink className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(entry.id)}
            className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-red-400"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex items-center space-x-3 mt-1 text-xs text-zinc-500 metric-text">
        <span className="flex items-center space-x-1">
          <Clock className="w-3 h-3" />
          <span>Expires in {formatDuration(entry.expiresInSeconds)}</span>
        </span>
        <span>•</span>
        <span>{createdAt.toLocaleDateString()} {createdAt.toLocaleTimeString()}</span>
      </div>
    </div>
  );
};

export interface PresignHistoryModalProps {
  entries: PresignHistoryEntry[];
  onClearAll: () => void;
  onDelete: (entryId: string) => void;
  onClose: () => void;
}

/**
 * "Shared Links History" dialog, lifted out of App.tsx so the shell stays a
 * shell. The parent decides *whether* it is open; this owns what it shows.
 */
export const PresignHistoryModal: React.FC<PresignHistoryModalProps> = ({
  entries,
  onClearAll,
  onDelete,
  onClose,
}) => (
  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-[600px] max-h-[80vh] shadow-2xl flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold flex items-center space-x-2">
          <Link className="w-5 h-5 text-gale-teal" />
          <span>Shared Links History</span>
        </h3>
        <div className="flex items-center space-x-2">
          {entries.length > 0 && (
            <button
              onClick={onClearAll}
              className="flex items-center space-x-1 text-xs text-red-400 hover:text-red-300"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear All</span>
            </button>
          )}
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 text-xl"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {entries.length === 0 ? (
          <div className="text-center py-8 text-zinc-500">
            <Link className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No shared links yet</p>
            <p className="text-xs mt-1">Generate a share link from the file context menu</p>
          </div>
        ) : (
          entries.map((entry) => (
            <HistoryItem
              key={entry.id}
              entry={entry}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  </div>
);

export default PresignHistoryModal;
