/**
 * Light / dark / system theme.
 *
 *   const { preference, resolved, setPreference, toggle } = useTheme();
 *   <ThemeToggle />            // icon button (moon in light, sun in dark) — components/ui/ThemeToggle
 *   <ThemeSegmented />         // "Light | Dark" radiogroup (public utility bar)
 *
 * - Preference is persisted in localStorage `thali.theme` ('light' | 'dark' | 'system', default 'system').
 * - The resolved theme is written to `<html data-theme="light|dark">` (+ `color-scheme`), which flips every
 *   semantic token in styles.css. index.html runs the same logic inline before first paint (no flash).
 * - The store is module-level (useSyncExternalStore), so `useTheme()` works with or without <ThemeProvider>.
 *   <ThemeProvider> (mounted once in App) applies the theme on mount and follows OS changes while on 'system'
 *   and changes made in other tabs.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'thali.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#ffffff', dark: '#0d0c0c' };

export function readStoredPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

/** Writes the resolved theme to the document (data-theme, color-scheme, meta theme-color). */
export function applyTheme(theme: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

const listeners = new Set<() => void>();
let state: ThemeState | null = null;

function compute(): ThemeState {
  const preference = readStoredPreference();
  return { preference, resolved: resolveTheme(preference, systemPrefersDark()) };
}

function getState(): ThemeState {
  if (!state) state = compute();
  return state;
}

function publish(next: ThemeState) {
  if (state && state.preference === next.preference && state.resolved === next.resolved) {
    applyTheme(next.resolved);
    return;
  }
  state = next;
  applyTheme(next.resolved);
  for (const l of [...listeners]) l();
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* storage disabled: keep in memory */
  }
  publish({ preference, resolved: resolveTheme(preference, systemPrefersDark()) });
}

/** Re-read storage + OS preference (OS change, other tab, provider mount). */
export function syncTheme(): void {
  publish(compute());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const SERVER_STATE: ThemeState = { preference: 'system', resolved: 'light' };

export interface UseThemeResult extends ThemeState {
  setPreference(p: ThemePreference): void;
  /** Explicitly switch to the opposite of what is shown now. */
  toggle(): void;
}

export function useTheme(): UseThemeResult {
  const s = useSyncExternalStore(subscribe, getState, () => SERVER_STATE);
  return {
    ...s,
    setPreference: setThemePreference,
    toggle: () => setThemePreference(s.resolved === 'dark' ? 'light' : 'dark'),
  };
}

export function ThemeProvider({ children }: { children?: ReactNode }) {
  useEffect(() => {
    syncTheme();
    const mql = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
    const onSystem = () => syncTheme();
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY || e.key === null) syncTheme();
    };
    mql?.addEventListener?.('change', onSystem);
    window.addEventListener('storage', onStorage);
    return () => {
      mql?.removeEventListener?.('change', onSystem);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return <>{children}</>;
}

/** Test helper: forget the cached state so the next read re-computes from storage / matchMedia. */
export function __resetThemeForTests(): void {
  state = null;
  listeners.clear();
}
