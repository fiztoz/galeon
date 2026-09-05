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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-96 shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">
              {editingProfile ? 'Edit Profile' : 'Save Profile'}
            </h3>
            <input
              type="text"
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
          </div>
        </div>
  );
}
