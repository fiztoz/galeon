import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '../types';
import { applyTheme, parseThemeMode, watchSystemTheme, type ThemeMode } from '../theme';

/**
 * Layout preferences: dual-pane on/off, the local pane's directory, the split
 * ratio, and the theme.
 *
 * These live here rather than inline in `App` because they are one cohesive
 * cluster that only talks to `app_settings.json`, and every new layout toggle
 * would otherwise land back in the shell.
 *
 * Persistence is a debounced read-modify-write of the whole settings object:
 * `save_app_settings` takes the full struct, so writing only these keys would
 * drop `onboardingComplete` / timestamps. The change-guard means a startup does
 * not immediately rewrite the file with the values it just read.
 */

const DEFAULT_RATIO = 0.5;

/** Ratio is only trusted when it is a real 0..1 number; anything else is 50/50. */
const readRatio = (value: AppSettings['splitRatio']): number =>
  typeof value === 'number' && value >= 0 && value <= 1 ? value : DEFAULT_RATIO;

export interface LayoutPreferences {
  dualPaneEnabled: boolean;
  setDualPaneEnabled: Dispatch<SetStateAction<boolean>>;
  toggleDualPane: () => void;
  localPanePath: string;
  setLocalPanePath: Dispatch<SetStateAction<string>>;
  splitRatio: number;
  setSplitRatio: Dispatch<SetStateAction<number>>;
  themeMode: ThemeMode;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
  /** Seed from a settings object the caller already fetched, and paint the theme. */
  applyLoadedSettings: (settings: AppSettings) => void;
}

export function useLayoutPreferences(): LayoutPreferences {
  const [dualPaneEnabled, setDualPaneEnabled] = useState(false);
  const [localPanePath, setLocalPanePath] = useState('');
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [splitRatio, setSplitRatio] = useState(DEFAULT_RATIO);

  const loadedRef = useRef(false);
  const persistedRef = useRef('');

  const snapshot = (p: {
    dualPaneEnabled?: boolean;
    localPanePath?: string | null;
    splitRatio?: number | null;
    theme?: string | null;
  }) => JSON.stringify([
    p.dualPaneEnabled ?? false,
    p.localPanePath ?? '',
    parseThemeMode(p.theme),
    readRatio(p.splitRatio),
  ]);

  const applyLoadedSettings = (settings: AppSettings) => {
    setDualPaneEnabled(settings.dualPaneEnabled ?? false);
    setLocalPanePath(settings.localPanePath ?? '');
    setSplitRatio(readRatio(settings.splitRatio));
    const mode = parseThemeMode(settings.theme);
    setThemeMode(mode);
    persistedRef.current = snapshot(settings);
    loadedRef.current = true;
    applyTheme(mode);
  };

  // Debounced write. Pane navigation changes the path often, so this coalesces.
  useEffect(() => {
    if (!loadedRef.current) return;
    const next = snapshot({ dualPaneEnabled, localPanePath, splitRatio, theme: themeMode });
    if (next === persistedRef.current) return;
    const timer = setTimeout(async () => {
      try {
        const current = await invoke<AppSettings>('get_app_settings');
        await invoke('save_app_settings', {
          settings: {
            ...current,
            dualPaneEnabled,
            localPanePath: localPanePath || null,
            splitRatio,
            theme: themeMode,
            updatedAtMs: Date.now(),
          },
        });
        persistedRef.current = next;
      } catch (err) {
        console.error('Failed to persist preferences:', err);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [dualPaneEnabled, localPanePath, themeMode, splitRatio]);

  // Paint the theme, and keep following macOS while the user is on "system".
  useEffect(() => {
    applyTheme(themeMode);
    if (themeMode !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [themeMode]);

  return {
    dualPaneEnabled,
    setDualPaneEnabled,
    toggleDualPane: () => setDualPaneEnabled((prev) => !prev),
    localPanePath,
    setLocalPanePath,
    splitRatio,
    setSplitRatio,
    themeMode,
    setThemeMode,
    applyLoadedSettings,
  };
}

export default useLayoutPreferences;
