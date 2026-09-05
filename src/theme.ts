/**
 * Theme mode plumbing.
 *
 * The dark palette is the stylesheet's default, so "dark" is represented by the
 * *absence* of `data-theme` rather than a `data-theme="dark"` block. Only light
 * needs to override anything (see `src/index.css`).
 *
 * `'system'` is resolved in the browser against `prefers-color-scheme` and is
 * also the fallback for a stored value this build does not recognise — a settings
 * file from a future version can never put the app into an unrenderable state.
 */

export type ThemeMode = 'system' | 'dark' | 'light';
export type EffectiveTheme = 'dark' | 'light';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

export const THEME_MODES: ThemeMode[] = ['system', 'dark', 'light'];

export const THEME_LABELS: Record<ThemeMode, string> = {
  system: 'System',
  dark: 'Dark',
  light: 'Light',
};

/** Narrow an arbitrary stored value to a ThemeMode, defaulting to system. */
export function parseThemeMode(value: unknown): ThemeMode {
  return value === 'dark' || value === 'light' || value === 'system' ? value : 'system';
}

export function resolveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
}

/** Paint the document and report what was actually applied. */
export function applyTheme(mode: ThemeMode): EffectiveTheme {
  const effective = resolveTheme(mode);
  const root = document.documentElement;
  if (effective === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  return effective;
}

/**
 * Follow the OS while the user is on "system". Returns an unsubscribe function,
 * so the caller owns the listener lifetime.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia(LIGHT_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** system → light → dark → system, so a single action can cycle the lot. */
export function nextThemeMode(current: ThemeMode): ThemeMode {
  const i = THEME_MODES.indexOf(current);
  return THEME_MODES[(i + 1) % THEME_MODES.length];
}
