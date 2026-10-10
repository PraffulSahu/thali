/**
 * `useMediaQuery('(min-width: 768px)')` -> boolean, live. Falls back to `defaultValue` where matchMedia is
 * missing (jsdom), so components render their desktop variant in tests by default.
 */
import { useSyncExternalStore } from 'react';

export const MQ_DESKTOP = '(min-width: 768px)';

export function useMediaQuery(query: string, defaultValue = true): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : defaultValue),
    () => defaultValue,
  );
}
