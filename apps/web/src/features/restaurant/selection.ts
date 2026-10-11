/**
 * Which of the owner's restaurants is selected (the switcher). Persisted in localStorage and shared through
 * an external store so the layout, the nav badge and pages agree without prop drilling.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'thali.restaurant.selected';
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function getSelectedRestaurantId(): string | null {
  return read();
}

export function setSelectedRestaurantId(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: selection falls back to the first restaurant */
  }
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

export function useSelectedRestaurantId(): string | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

/**
 * Resolve the selection against the list. No stored selection, or a stale id (deleted/other account), falls
 * back to the first live (APPROVED) restaurant, else the first one: an owner whose first restaurant is still
 * in review should land on the kitchen that is taking orders.
 */
export function resolveSelected<T extends { id: string; status?: string }>(list: T[] | undefined, selectedId: string | null): T | undefined {
  if (!list?.length) return undefined;
  return list.find((r) => r.id === selectedId) ?? list.find((r) => r.status === 'APPROVED') ?? list[0];
}
