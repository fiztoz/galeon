import React from 'react';
import { Loader2, Trash2, X, CheckCircle, XCircle } from 'lucide-react';

export interface DeleteProgress {
  jobId: string;
  done: number;
  total: number;
  currentKey: string;
  complete: boolean;
  cancelled: boolean;
  failures: string[];
  error?: string;
}

interface DeleteProgressToastProps {
  progress: DeleteProgress;
  onCancel: () => void;
  onDismiss: () => void;
}

const itemLabel = (key: string) => key.split('/').filter(Boolean).pop() || key;

export const DeleteProgressToast: React.FC<DeleteProgressToastProps> = ({
  progress,
  onCancel,
  onDismiss,
}) => {
  const { done, total, currentKey, complete, cancelled, failures, error } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const failed = failures.length > 0 || !!error;

  let title = 'Deleting items…';
  if (complete) {
    if (cancelled) title = 'Delete cancelled';
    else if (failed) title = `Deleted ${done - failures.length} of ${total}`;
    else title = `Deleted ${total} item${total !== 1 ? 's' : ''}`;
  }

  return (
    <div className="fixed bottom-14 right-6 z-50 w-80 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <div className="mt-0.5 shrink-0">
          {complete ? (
            failed || cancelled ? (
              <XCircle className="w-5 h-5 text-amber-400" />
            ) : (
              <CheckCircle className="w-5 h-5 text-gale-teal" />
            )
          ) : (
            <Loader2 className="w-5 h-5 text-doubloon animate-spin" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-zinc-100">{title}</p>
            {complete ? (
              <button
                onClick={onDismiss}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={onCancel}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
          {!complete && (
            <p className="text-xs text-zinc-500 mt-1 truncate">
              <Trash2 className="w-3 h-3 inline mr-1 -mt-0.5" />
              {itemLabel(currentKey)}
            </p>
          )}
          <div className="mt-2 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className={`h-full transition-all duration-200 ${
                complete && failed
                  ? 'bg-amber-500'
                  : complete
                    ? 'bg-gradient-to-r from-gale-teal to-emerald-400'
                    : 'bg-gradient-to-r from-doubloon via-amber-500 to-amber-400'
              }`}
              style={{ width: `${complete ? 100 : pct}%` }}
            />
          </div>
          <p className="text-[11px] text-zinc-500 mt-1.5">
            {done} / {total}
            {!complete && ` (${pct}%)`}
          </p>
          {complete && failures.length > 0 && (
            <ul className="mt-2 max-h-24 overflow-y-auto text-[11px] text-red-400/90 space-y-0.5">
              {failures.slice(0, 5).map((f) => (
                <li key={f} className="truncate" title={f}>{f}</li>
              ))}
              {failures.length > 5 && (
                <li className="text-zinc-500">+{failures.length - 5} more</li>
              )}
            </ul>
          )}
          {complete && error && (
            <p className="mt-2 text-[11px] text-red-400 truncate" title={error}>{error}</p>
          )}
        </div>
      </div>
    </div>
  );
};