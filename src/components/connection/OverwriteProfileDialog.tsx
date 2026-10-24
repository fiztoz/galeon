import { Dialog } from '../Dialogs';

interface OverwriteProfileDialogProps {
  profileName: string;
  onOverwrite: () => void;
  onSkip: () => void;
}

/**
 * A Connect from a saved profile succeeded with edits on top of it: the user
 * decides whether the saved profile should absorb the changes. Closing the
 * dialog counts as "don't save" — the session keeps whatever state it connected
 * with either way.
 */
export function OverwriteProfileDialog({ profileName, onOverwrite, onSkip }: OverwriteProfileDialogProps) {
  return (
    <Dialog title="Save changes?" onClose={onSkip}>
      <p className="text-sm text-zinc-300 mb-4">
        You connected to <span className="text-zinc-100 font-medium">{profileName}</span> with
        changes made in the form. Overwrite the saved profile, or keep it as it is?
      </p>
      <div className="flex justify-end space-x-2">
        <button
          type="button"
          onClick={onSkip}
          className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
        >
          Don&rsquo;t save
        </button>
        <button
          type="button"
          onClick={onOverwrite}
          className="px-4 py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-medium transition-colors"
        >
          Overwrite
        </button>
      </div>
    </Dialog>
  );
}
