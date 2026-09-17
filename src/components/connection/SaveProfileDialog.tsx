import { Dialog } from '../Dialogs';
import type { Dispatch, SetStateAction } from 'react';

interface SaveProfileDialogProps {
  editingProfile: boolean;
  profileName: string;
  setProfileName: Dispatch<SetStateAction<string>>;
  handleSaveProfile: () => void;
  onCancel: () => void;
}

export function SaveProfileDialog({ editingProfile, profileName, setProfileName, handleSaveProfile, onCancel }: SaveProfileDialogProps) {
  return (
        <Dialog title={editingProfile ? 'Edit Profile' : 'Save Profile'} onClose={onCancel}>
            <input
              type="text"
              aria-label="Profile name"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveProfile()}
              placeholder="Profile name"
              className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-gale-teal focus:ring-1 focus:ring-gale-teal transition-all mb-4"
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex justify-end space-x-2">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveProfile}
                disabled={!profileName.trim()}
                className="px-4 py-2 bg-gale-teal text-on-accent hover:bg-deep-current hover:text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingProfile ? 'Update' : 'Save'}
              </button>
            </div>
        </Dialog>
  );
}
