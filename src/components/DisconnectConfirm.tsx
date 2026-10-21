import React from 'react';
import { ConfirmDialog } from './Dialogs';
import type { EditSessionInfo } from './ActiveEditors';

/** Shared warning body for the switch / disconnect confirmations. */
export function EditorWatchWarning({ action, sessions }: { action: string; sessions: EditSessionInfo[] }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        You have {sessions.length} file{sessions.length === 1 ? '' : 's'} open in an external editor.
        {action} will stop watching them — unsaved changes in your editor won't be re-uploaded.
      </p>
      {sessions.length > 0 && (
        <ul className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2">
          {sessions.map((s) => (
            <li key={s.editorId} className="text-sm text-zinc-300 truncate">
              {s.filename}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Props = {
  /** A switch to another connection is waiting for confirmation. */
  switchPending: boolean;
  /** A disconnect is waiting for confirmation. */
  disconnectPending: boolean;
  sessions: EditSessionInfo[];
  onCancelSwitch: () => void;
  onConfirmSwitch: () => void;
  onCancelDisconnect: () => void;
  onConfirmDisconnect: () => void;
};

/**
 * The two confirmations that guard a session with external editors open.
 *
 * Only one is mounted at a time, so they share one dialog surface instead of
 * two near-identical blocks in the shell.
 */
export const DisconnectConfirmations: React.FC<Props> = ({
  switchPending,
  disconnectPending,
  sessions,
  onCancelSwitch,
  onConfirmSwitch,
  onCancelDisconnect,
  onConfirmDisconnect,
}) => (
  <>
    {switchPending && (
      <ConfirmDialog
        title="Switch connection?"
        width="w-[480px]"
        tone="danger"
        confirmLabel="Switch anyway"
        onCancel={onCancelSwitch}
        onConfirm={onConfirmSwitch}
      >
        <EditorWatchWarning action="Switching" sessions={sessions} />
      </ConfirmDialog>
    )}

    {disconnectPending && (
      <ConfirmDialog
        title="Disconnect?"
        width="w-[480px]"
        tone="danger"
        confirmLabel="Disconnect"
        cancelLabel="Stay connected"
        onCancel={onCancelDisconnect}
        onConfirm={onConfirmDisconnect}
      >
        <EditorWatchWarning action="Disconnecting" sessions={sessions} />
      </ConfirmDialog>
    )}
  </>
);
