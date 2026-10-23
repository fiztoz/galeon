import React from 'react';
import { Columns } from 'lucide-react';
import { ActiveEditors, EditSessionInfo } from './ActiveEditors';
import { ConnectionSwitcher } from './ConnectionSwitcher';
import type { SwitcherProfile } from '../connectionSwitcher';
import type { StorageProtocol } from '../types';

type Props = {
  /** The bucket the open session is on. */
  bucket: string;
  protocol?: StorageProtocol;
  /** The saved profile the session came from, if any. */
  profileId?: string;
  /** Saved profiles, for the switcher. */
  profiles: SwitcherProfile[];
  onConnect: (profileId: string) => void;
  onDisconnect: () => void;
  dualPaneEnabled: boolean;
  onToggleDualPane: () => void;
  editSessions: EditSessionInfo[];
  onStopEditor: (editorId: string) => void;
  onStopAllEditors: () => void;
};

/**
 * The window titlebar of a connected session.
 *
 * It shows who we are connected to and the two things that belong to the
 * window rather than to a pane: the local-pane toggle and live editor state.
 * Every other action lives in the native menu or the command palette.
 */
export const ConnectedHeader: React.FC<Props> = ({
  bucket,
  protocol,
  profileId,
  profiles,
  onConnect,
  onDisconnect,
  dualPaneEnabled,
  onToggleDualPane,
  editSessions,
  onStopEditor,
  onStopAllEditors,
}) => {
  const isFsProtocol = protocol === 'sftp' || protocol === 'ftp' || protocol === 'ftps';

  return (
    <header
      data-tauri-drag-region
      className="app-titlebar app-titlebar-traffic justify-between gap-3 pr-3 bg-zinc-900 border-b border-zinc-800"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 min-w-0">
        <h1
          data-tauri-drag-region
          className="text-[13px] font-semibold tracking-tight text-zinc-100 shrink-0"
        >
          Galeon
        </h1>
        <span data-tauri-drag-region className="text-zinc-700 shrink-0" aria-hidden>
          ·
        </span>
        <ConnectionSwitcher
          profiles={profiles}
          sessionProfileId={profileId}
          fallbackLabel={isFsProtocol ? (protocol ?? '').toUpperCase() : bucket}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
      </div>
      <div data-no-drag className="flex items-center gap-1 shrink-0">
        <button
          onClick={onToggleDualPane}
          title="Toggle Dual Pane (⌥⌘L)"
          aria-pressed={dualPaneEnabled}
          className={`ui-button ${
            dualPaneEnabled
              ? 'text-gale-teal bg-gale-teal/10'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
          }`}
        >
          <Columns className="w-3.5 h-3.5" />
          <span>Local</span>
        </button>
        <ActiveEditors
          sessions={editSessions}
          onStop={onStopEditor}
          onStopAll={onStopAllEditors}
        />
      </div>
    </header>
  );
};
