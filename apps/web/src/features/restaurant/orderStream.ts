/**
 * Live orders: query + realtime `owner.order` events + 10 s polling fallback, and the new-order alert
 * (visual highlight handled by the cards; sound handled here).
 *
 * Sound rules: browsers only allow audio after a user gesture, so the chime is armed from a click on the
 * "Order sound" button (or the first tap anywhere when the owner previously turned it on). Nothing plays
 * before that. Motion for the visual alert uses Tailwind's `motion-safe:` so reduced motion is respected.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRealtime } from '../../hooks/useRealtime';
import { keys, ordersApi } from './api';

/* ---------------------------------------------------------------- sound (module singleton) */

const SOUND_KEY = 'thali.restaurant.sound';
let audioCtx: AudioContext | null = null;
let snapshot = { enabled: readPref(), armed: false };
const soundListeners = new Set<() => void>();
let gestureHooked = false;

function readPref(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

function emitSound() {
  snapshot = { enabled: snapshot.enabled, armed: audioCtx?.state === 'running' };
  for (const l of [...soundListeners]) l();
}

function createContext(): AudioContext | null {
  const Ctor: typeof AudioContext | undefined =
    typeof window === 'undefined' ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/** Must be called from a user gesture. Resolves once the audio context is running (or could not start). */
export function armSound(): Promise<void> {
  audioCtx ??= createContext();
  emitSound();
  if (!audioCtx) return Promise.resolve();
  return audioCtx.resume().then(emitSound, emitSound);
}

function hookFirstGesture() {
  if (gestureHooked || typeof document === 'undefined') return;
  gestureHooked = true;
  const once = () => {
    document.removeEventListener('pointerdown', once);
    document.removeEventListener('keydown', once);
    gestureHooked = false;
    if (snapshot.enabled && !snapshot.armed) void armSound();
  };
  document.addEventListener('pointerdown', once);
  document.addEventListener('keydown', once);
}

/**
 * Turn the chime on/off (persisted). Turning it on from a click unlocks audio and, with `test`, plays one chime
 * so the owner hears what a new order sounds like.
 */
export function setSoundEnabled(enabled: boolean, opts: { test?: boolean } = {}): void {
  try {
    localStorage.setItem(SOUND_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
  snapshot = { ...snapshot, enabled };
  if (enabled) {
    void armSound().then(() => {
      if (opts.test) playOrderChime();
    });
  } else emitSound();
}

/** Two short notes. No-op unless the owner enabled sound and the context was unlocked by a gesture. */
export function playOrderChime(): boolean {
  if (!snapshot.enabled || !audioCtx || audioCtx.state !== 'running') return false;
  const ctx = audioCtx;
  const t0 = ctx.currentTime;
  [880, 1175].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.22);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + i * 0.22 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.22 + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + i * 0.22);
    osc.stop(t0 + i * 0.22 + 0.22);
  });
  return true;
}

export function useSoundState() {
  const s = useSyncExternalStore(
    (cb) => {
      soundListeners.add(cb);
      return () => soundListeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
  useEffect(() => {
    if (s.enabled && !s.armed) hookFirstGesture();
  }, [s.enabled, s.armed]);
  return { ...s, setEnabled: setSoundEnabled, toggle: () => setSoundEnabled(!s.enabled, { test: !s.enabled }) };
}

/* ---------------------------------------------------------------- stream */

export interface OrderStreamOptions {
  enabled?: boolean;
  /** Chime when a PLACED order appears that was not in the previous snapshot (default true). */
  alert?: boolean;
}

/**
 * Fetches the restaurant's active orders (new, in the kitchen, ready) and keeps them fresh. Returns them
 * oldest-first (the oldest PLACED order has the least time left), the ids of orders that arrived since the
 * screen opened, and the realtime status.
 */
export function useOrderStream(restaurantId: string | undefined, opts: OrderStreamOptions = {}) {
  const { enabled = true, alert = true } = opts;
  const on = Boolean(restaurantId) && enabled;
  const query = useQuery({
    queryKey: keys.orders(restaurantId ?? ''),
    queryFn: () => ordersApi.active(restaurantId!),
    enabled: on,
  });
  const { status } = useRealtime<{ restaurantId?: string }>(
    ['owner.order'],
    (e) => {
      if (!e.data?.restaurantId || e.data.restaurantId === restaurantId) void query.refetch();
    },
    { fallbackRefetch: query.refetch, enabled: on },
  );

  const active = useMemo(
    () => [...(query.data?.items ?? [])].sort((a, b) => Date.parse(a.placedAt ?? '') - Date.parse(b.placedAt ?? '')),
    [query.data],
  );

  // New-order detection: PLACED ids on the first successful load are the baseline; later ones are "new".
  const seen = useRef<Set<string> | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    seen.current = null;
    setNewIds(new Set());
  }, [restaurantId]);

  useEffect(() => {
    if (!query.data) return;
    const placed = query.data.items.filter((o) => o.status === 'PLACED').map((o) => o.id);
    if (seen.current === null) {
      seen.current = new Set(placed);
      return;
    }
    const known = seen.current;
    const added = placed.filter((id) => !known.has(id));
    if (added.length === 0) return;
    added.forEach((id) => known.add(id));
    setNewIds((prev) => new Set([...prev, ...added]));
    if (alert) playOrderChime();
  }, [query.data, alert]);

  const placedCount = active.filter((o) => o.status === 'PLACED').length;
  // screen-reader announcement for arrivals (rendered by the board in an aria-live region)
  const announcement = useMemo(() => {
    const arrived = active.filter((o) => o.status === 'PLACED' && newIds.has(o.id));
    if (arrived.length === 0) return '';
    return `New order${arrived.length > 1 ? 's' : ''}: ${arrived.map((o) => o.code).join(', ')}`;
  }, [active, newIds]);
  return { query, active, newIds, placedCount, announcement, realtime: status };
}

/* ---------------------------------------------------------------- all restaurants */

/**
 * New (PLACED) orders across every restaurant the owner has, with one cheap query (`GET /owner/orders?status=PLACED`
 * without restaurantId; the server scopes it to the owner). Refreshed by `owner.order` events (polling fallback 10 s,
 * plus a 30 s interval). Chimes for arrivals after the first load: for every restaurant, or only for restaurants other
 * than `skipRestaurantId` (the live board chimes for its own restaurant). Returns per-restaurant counts and an
 * announcement for an assertive live region.
 */
export function useAllNewOrders(opts: { enabled?: boolean; skipRestaurantId?: string } = {}) {
  const { enabled = true, skipRestaurantId } = opts;
  const query = useQuery({ queryKey: keys.placedAll, queryFn: ordersApi.placedAll, enabled, refetchInterval: 30_000 });
  useRealtime(['owner.order'], () => void query.refetch(), { fallbackRefetch: query.refetch, enabled });

  const seen = useRef<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!query.data) return;
    const items = query.data.items.filter((o) => o.status === 'PLACED');
    if (seen.current === null) {
      seen.current = new Set(items.map((o) => o.id));
      return;
    }
    const known = seen.current;
    const added = items.filter((o) => !known.has(o.id));
    added.forEach((o) => known.add(o.id));
    const relevant = added.filter((o) => o.restaurantId !== skipRestaurantId);
    if (relevant.length === 0) return;
    playOrderChime();
    setAnnouncement(`New order${relevant.length > 1 ? 's' : ''}: ${relevant.map((o) => `${o.code}${o.restaurantName ? ` at ${o.restaurantName}` : ''}`).join(', ')}`);
  }, [query.data, skipRestaurantId]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of query.data?.items ?? []) if (o.status === 'PLACED' && o.restaurantId) m.set(o.restaurantId, (m.get(o.restaurantId) ?? 0) + 1);
    return m;
  }, [query.data]);
  return { query, counts, announcement };
}

/** Read-only view of the per-restaurant new-order counts (shares the watcher's cache; no own polling). */
export function useNewOrderCounts(enabled = true): Map<string, number> {
  const q = useQuery({ queryKey: keys.placedAll, queryFn: ordersApi.placedAll, enabled, staleTime: 15_000 });
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const o of q.data?.items ?? []) if (o.status === 'PLACED' && o.restaurantId) m.set(o.restaurantId, (m.get(o.restaurantId) ?? 0) + 1);
    return m;
  }, [q.data]);
}
