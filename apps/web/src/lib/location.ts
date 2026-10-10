/**
 * The consumer's chosen delivery location — the SAME store the consumer area uses today
 * (`features/consumer/location.ts`: localStorage `thali.location`, `{lat,lng,label,source,addressId?}`).
 * Foundation code (public landing, shells, area gate) reads/writes it here; the consumer area can switch its
 * module to re-export from this file. Writes also notify the consumer module's own subscribers in this tab
 * (it listens for `storage` events on the same key).
 *
 *   const loc = useChosenLocation();                     // null until chosen
 *   setChosenLocation({ lat, lng, label: '12th Main Rd', source: 'address', address: '12th Main Rd, Indiranagar' });
 */
import { useSyncExternalStore } from 'react';
import type { GeoPoint } from '@thali/contracts';
import { isValidGeoPoint } from './geo';

export const LOCATION_STORAGE_KEY = 'thali.location';

export interface ChosenLocation extends GeoPoint {
  /** Short label for the header chip ("Home", "12th Main Rd", "Current location"). */
  label: string;
  source: 'gps' | 'pin' | 'address';
  /** Saved identity address id when chosen from saved addresses. */
  addressId?: string;
  /** Longer one-line address for the header chip's second line (optional). */
  address?: string;
  /** Places id (MKT-1) when chosen from address search. */
  placeId?: string;
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: ChosenLocation | null = null;
let memoryRaw: string | null = null;

function rawValue(): string | null {
  try {
    return localStorage.getItem(LOCATION_STORAGE_KEY);
  } catch {
    return memoryRaw;
  }
}

function read(): ChosenLocation | null {
  const raw = rawValue();
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

export function getChosenLocation(): ChosenLocation | null {
  return read();
}

export function setChosenLocation(loc: ChosenLocation | null): void {
  const raw = loc ? JSON.stringify(loc) : null;
  try {
    if (raw) localStorage.setItem(LOCATION_STORAGE_KEY, raw);
    else localStorage.removeItem(LOCATION_STORAGE_KEY);
  } catch {
    memoryRaw = raw;
  }
  for (const l of [...listeners]) l();
  // Same-tab notification for the consumer area's store (it subscribes to `storage` events on this key).
  try {
    window.dispatchEvent(new StorageEvent('storage', { key: LOCATION_STORAGE_KEY, newValue: raw }));
  } catch {
    /* very old browsers: the consumer store re-reads on its next render anyway */
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCATION_STORAGE_KEY || e.key === null) cb();
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
