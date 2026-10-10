/**
 * The consumer's chosen delivery location, persisted in localStorage (`thali.location`) and shared across tabs
 * of this area through useSyncExternalStore. Discovery, restaurant pages and checkout read it.
 */
import { useSyncExternalStore } from 'react';
import type { GeoPoint } from '@thali/contracts';
import { isValidGeoPoint } from '../../lib/geo';

export const LOCATION_STORAGE_KEY = 'thali.location';

export interface ChosenLocation extends GeoPoint {
  /** Short label for the header chip ("Home", "Pinned location", "Current location"). */
  label: string;
  source: 'gps' | 'pin' | 'address';
  /** Saved identity address id when chosen from saved addresses. */
  addressId?: string;
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: ChosenLocation | null = null;

function read(): ChosenLocation | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LOCATION_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    const v = raw ? (JSON.parse(raw) as ChosenLocation) : null;
    cached = v && isValidGeoPoint(v) && typeof v.label === 'string' ? v : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function getLocation(): ChosenLocation | null {
  return read();
}

export function setLocation(loc: ChosenLocation | null): void {
  try {
    if (loc) localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify(loc));
    else localStorage.removeItem(LOCATION_STORAGE_KEY);
  } catch {
    /* storage disabled: keep in memory only */
    cachedRaw = loc ? JSON.stringify(loc) : null;
    cached = loc;
  }
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCATION_STORAGE_KEY) cb();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

export function useChosenLocation(): ChosenLocation | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
