/**
 * Global single-key shortcut that ignores typing contexts (inputs, textareas, selects, contenteditable).
 *
 *   const ref = useRef<HTMLInputElement>(null);
 *   useHotkey('/', () => ref.current?.focus());      // header search
 *   useHotkey('k', openSearch, { meta: true });      // ⌘K / Ctrl+K
 */
import { useEffect, useRef } from 'react';

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, opts: { meta?: boolean; enabled?: boolean } = {}) {
  const { meta = false, enabled = true } = opts;
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      if (meta ? !(e.metaKey || e.ctrlKey) : e.metaKey || e.ctrlKey || e.altKey) return;
      if (!meta && isTypingTarget(e.target)) return;
      e.preventDefault();
      ref.current(e);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [key, meta, enabled]);
}
