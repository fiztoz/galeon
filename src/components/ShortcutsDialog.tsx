import { X } from 'lucide-react';
import { ModalSurface } from './ModalSurface';
import { formatChord, shortcutGroups, type ShortcutPlatform } from '../keyboardShortcuts';

/**
 * The keyboard cheatsheet.
 *
 * The list lives in `keyboardShortcuts` so the same data can feed hints
 * elsewhere; this only draws it. Keys are formatted for the platform that is
 * reading the dialog, so a Windows build shows Ctrl where a Mac shows ⌘.
 */
export function ShortcutsDialog({ open, onClose, platform }: {
  open: boolean;
  onClose: () => void;
  platform: ShortcutPlatform;
}) {
  if (!open) return null;

  return (
    <ModalSurface
      label="Keyboard shortcuts"
      onClose={onClose}
      className="w-full max-w-xl p-0 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl"
    >
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <h2 className="text-lg font-semibold text-zinc-100">Keyboard shortcuts</h2>
        <button
          type="button"
          aria-label="Close keyboard shortcuts"
          onClick={onClose}
          className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="max-h-[calc(100dvh-200px)] overflow-y-auto galeon-scrollbar px-6 py-5 space-y-6">
        {shortcutGroups().map((group) => (
          <section key={group.id} aria-labelledby={`shortcuts-${group.id}`}>
            <h3
              id={`shortcuts-${group.id}`}
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500"
            >
              {group.title}
            </h3>
            <dl className="space-y-1">
              {group.rows.map((row) => (
                <div key={row.action} className="flex items-center justify-between gap-6 py-1">
                  <dt className="text-sm text-zinc-300">{row.action}</dt>
                  <dd className="flex shrink-0 items-center gap-2">
                    {row.chords.map((chord, chordIndex) => (
                      <span key={chord} className="flex items-center gap-1">
                        {chordIndex > 0 && (
                          <span className="text-[11px] text-zinc-600">or</span>
                        )}
                        {formatChord(chord, platform).map((label, labelIndex) => (
                          <kbd
                            key={`${label}-${labelIndex}`}
                            className="min-w-[1.5rem] rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-center text-[11px] font-medium text-zinc-300"
                          >
                            {label}
                          </kbd>
                        ))}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </ModalSurface>
  );
}