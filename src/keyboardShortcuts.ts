/**
 * The keyboard map.
 *
 * The window now has a real keyboard model — the file lists, the palette, and
 * the native menu — so the keys live here as data instead of as prose spread
 * across components. Chords are written logically (`Mod+Shift+U`) and formatted
 * for the platform that is reading them, so one list serves macOS (⌘) and every
 * other platform (Ctrl) without a second copy.
 */

export type ShortcutPlatform = 'mac' | 'other';

/** Modifier labels as the OS draws them. `Mod` is ⌘ on macOS, Ctrl elsewhere. */
const MODIFIERS: Record<ShortcutPlatform, Record<string, string>> = {
  mac: { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' },
  other: { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Ctrl: 'Ctrl' },
};

/** Keys whose name is longer than the symbol a keyboard prints. */
const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: '⌦',
};

export type ShortcutRow = {
  /** One chord, or several alternatives for the same action (`Home` / `End`). */
  chords: string[];
  /** What the chord does, in the imperative voice the menus use. */
  action: string;
};

export type ShortcutGroup = {
  id: string;
  title: string;
  rows: ShortcutRow[];
};

/**
 * Render one chord as the labels it shows on the keyboard.
 *
 * A chord is `Mod+Shift+K`; the parts come back in the order they are pressed.
 * Unknown parts pass through, so a future key does not need a table entry
 * before it can appear.
 */
export function formatChord(chord: string, platform: ShortcutPlatform): string[] {
  const modifiers = MODIFIERS[platform];
  return chord
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => modifiers[part] ?? KEY_LABELS[part] ?? part);
}

/** Which modifier row the user is looking at. */
export function detectShortcutPlatform(
  nav: { platform?: string; userAgent?: string } | undefined | null,
): ShortcutPlatform {
  if (!nav) return 'other';
  const haystack = `${nav.platform ?? ''} ${nav.userAgent ?? ''}`;
  return /Mac|iPhone|iPod|iPad|Macintosh|Mac OS X/.test(haystack) ? 'mac' : 'other';
}

/**
 * Every shortcut the window binds, grouped the way a cheatsheet reads.
 *
 * A key belongs here only if the app really handles it: the mac menu
 * accelerators, the file-list model in `useFileListKeyboard`, and the splitter.
 * Listing a key that does nothing would be worse than leaving it out.
 */
export function shortcutGroups(): ShortcutGroup[] {
  return [
    {
      id: 'app',
      title: 'Anywhere',
      rows: [
        { chords: ['Mod+K'], action: 'Open the command palette' },
        { chords: ['Mod+,'], action: 'Open Settings' },
        { chords: ['Mod+/'], action: 'Show this keyboard map' },
        { chords: ['Shift+Mod+U'], action: 'Upload files to the open folder' },
        { chords: ['Shift+Mod+N'], action: 'Create a folder' },
        { chords: ['Alt+Mod+L'], action: 'Show or hide the local pane' },
      ],
    },
    {
      id: 'file-list',
      title: 'File list',
      rows: [
        { chords: ['ArrowUp', 'ArrowDown'], action: 'Move the cursor and select that row' },
        { chords: ['Shift+ArrowUp', 'Shift+ArrowDown'], action: 'Extend the selection' },
        { chords: ['Home', 'End'], action: 'Jump to the first or last row' },
        { chords: ['Enter'], action: 'Open the row under the cursor' },
        { chords: ['F2'], action: 'Rename the row — remote pane' },
        { chords: ['Mod+A'], action: 'Select every row' },
        { chords: ['Mod+Backspace'], action: 'Delete the selected rows — remote pane' },
        { chords: ['Escape'], action: 'Clear the selection' },
      ],
    },
    {
      id: 'layout',
      title: 'Split pane',
      rows: [
        { chords: ['ArrowLeft', 'ArrowRight'], action: 'Resize the panes — focus the divider first' },
        { chords: ['Home', 'End'], action: 'Give one pane all the room' },
        { chords: ['Enter'], action: 'Reset the divider to the middle' },
      ],
    },
  ];
}