import { test, expect } from 'bun:test';
import {
  detectShortcutPlatform,
  formatChord,
  shortcutGroups,
  type ShortcutPlatform,
} from '../../src/keyboardShortcuts';

const MAC: ShortcutPlatform = 'mac';
const OTHER: ShortcutPlatform = 'other';

test('a chord renders the glyphs its platform prints', () => {
  expect(formatChord('Mod+K', MAC)).toEqual(['⌘', 'K']);
  expect(formatChord('Mod+K', OTHER)).toEqual(['Ctrl', 'K']);
  expect(formatChord('Shift+Mod+U', MAC)).toEqual(['⇧', '⌘', 'U']);
  expect(formatChord('Shift+Mod+U', OTHER)).toEqual(['Shift', 'Ctrl', 'U']);
  expect(formatChord('Alt+Mod+L', MAC)).toEqual(['⌥', '⌘', 'L']);
});

test('keys with a shorter symbol use it and unknown keys pass through', () => {
  expect(formatChord('Mod+Backspace', MAC)).toEqual(['⌘', '⌫']);
  expect(formatChord('ArrowUp', MAC)).toEqual(['↑']);
  expect(formatChord('F2', MAC)).toEqual(['F2']);
  expect(formatChord('Mod+PageDown', MAC)).toEqual(['⌘', 'PageDown']);
});

test('empty chord parts are ignored rather than drawn as a blank key', () => {
  expect(formatChord('Mod+', MAC)).toEqual(['⌘']);
  expect(formatChord('', MAC)).toEqual([]);
});

test('the platform is read from the navigator, not guessed', () => {
  expect(detectShortcutPlatform(undefined)).toBe('other');
  expect(detectShortcutPlatform({ platform: 'MacIntel' })).toBe('mac');
  expect(detectShortcutPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })).toBe('mac');
  expect(detectShortcutPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe('other');
  expect(detectShortcutPlatform({ platform: 'Linux x86_64' })).toBe('other');
});

test('every group is identified and every row says what the key does', () => {
  const groups = shortcutGroups();
  expect(groups.length).toBeGreaterThan(0);

  const ids = new Set<string>();
  for (const group of groups) {
    expect(group.id).not.toBe('');
    expect(ids.has(group.id)).toBe(false);
    ids.add(group.id);
    expect(group.title).not.toBe('');
    expect(group.rows.length).toBeGreaterThan(0);

    const actions = new Set<string>();
    for (const row of group.rows) {
      expect(row.chords.length).toBeGreaterThan(0);
      expect(row.chords.every((chord) => chord.length > 0)).toBe(true);
      expect(row.action.trim()).not.toBe('');
      expect(actions.has(row.action)).toBe(false);
      actions.add(row.action);
    }
  }
});

test('each platform draws only its own modifier names', () => {
  const chords = shortcutGroups().flatMap((group) => group.rows.flatMap((row) => row.chords));
  const macSymbols = ['⌘', '⇧', '⌥', '⌃'];

  for (const chord of chords) {
    const mac = formatChord(chord, MAC);
    const other = formatChord(chord, OTHER);

    // macOS draws glyphs; every other platform spells the modifier out. A
    // chord that leaked the other platform's labels would read wrong.
    expect(mac.some((label) => ['Ctrl', 'Shift', 'Alt'].includes(label))).toBe(false);
    expect(other.some((label) => macSymbols.includes(label))).toBe(false);
  }
});

test('the file list keys that exist are the ones documented', () => {
  const fileList = shortcutGroups().find((group) => group.id === 'file-list');
  const chords = fileList?.rows.flatMap((row) => row.chords) ?? [];
  for (const chord of ['ArrowUp', 'ArrowDown', 'Shift+ArrowUp', 'Home', 'End', 'Enter', 'F2', 'Mod+A', 'Mod+Backspace', 'Delete', 'PageUp', 'PageDown', 'Escape']) {
    expect(chords).toContain(chord);
  }
});

/**
 * Normalize a chord so `Shift+Mod+U` and the Rust menu's `CmdOrCtrl+Shift+U`
 * compare equal — the menu writes modifiers in its own order.
 */
function normalize(chord: string): string {
  const order = ['Mod', 'Ctrl', 'Shift', 'Alt'];
  const parts = chord.split('+').map((part) => (part === 'CmdOrCtrl' ? 'Mod' : part));
  const modifiers = parts.filter((part) => order.includes(part));
  const keys = parts.filter((part) => !order.includes(part));
  modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...modifiers, ...keys].join('+');
}

/**
 * Drift guard: a native menu accelerator that is not in the cheatsheet is a
 * shortcut the user can only find by opening the menu.
 */
test('every native menu accelerator appears in the cheatsheet', async () => {
  const source = await Bun.file(
    new URL('../../src-tauri/src/menu_bar.rs', import.meta.url).pathname,
  ).text();

  const accelerators = [...source.matchAll(/Some\("((?:CmdOrCtrl|Alt|Shift)[^"]+)"\)/g)]
    .map((match) => normalize(match[1]));

  expect(accelerators.length).toBeGreaterThan(0);

  const documented = new Set(
    shortcutGroups().flatMap((group) => group.rows.flatMap((row) => row.chords)).map(normalize),
  );

  for (const accelerator of accelerators) {
    expect(documented).toContain(accelerator);
  }
});