/**
 * Subscribe to realtime SSE events with an automatic polling fallback.
 *
 *   const order = useQuery({ queryKey: ['order', id], queryFn: () => api(`/orders/${id}`) });
 *   const { status } = useRealtime(['order.updated'], (e) => {
 *     if (e.data.checkoutId === id) void order.refetch();
 *   }, { fallbackRefetch: order.refetch });
 *   <RealtimeStatus status={status} />   // shows "Live updates paused — refreshing every 10 s" when not live
 *
 * - `events`: SSE event names (LLD §11). The array may be inline; it is compared by value.
 * - `onEvent`: latest closure is always used (no need to memoize).
 * - `fallbackRefetch`: called every 10 s while status is not 'live', once immediately when a live stream drops,
 *   and once when it comes back (to resync anything missed).
 * - `enabled: false` unsubscribes and stops polling.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  REALTIME_POLL_INTERVAL_MS,
  useRealtimeClient,
  type RealtimeEvent,
  type RealtimeStatus,
} from '../lib/realtime';

export interface UseRealtimeOptions {
  fallbackRefetch?: () => unknown;
  pollIntervalMs?: number;
  enabled?: boolean;
}

export interface UseRealtimeResult {
  status: RealtimeStatus;
  isLive: boolean;
}

export function useRealtime<T = unknown>(
  events: readonly string[],
  onEvent?: (event: RealtimeEvent<T>) => void,
  options: UseRealtimeOptions = {},
): UseRealtimeResult {
  const { fallbackRefetch, pollIntervalMs = REALTIME_POLL_INTERVAL_MS, enabled = true } = options;
  const client = useRealtimeClient();
  const handlerRef = useRef(onEvent);
  const refetchRef = useRef(fallbackRefetch);
  useEffect(() => {
    handlerRef.current = onEvent;
    refetchRef.current = fallbackRefetch;
  });

  const key = [...events].sort().join('|');
  useEffect(() => {
    if (!enabled) return;
    const names = key.split('|').filter(Boolean);
    return client.subscribe(names, (e) => handlerRef.current?.(e as RealtimeEvent<T>));
  }, [client, key, enabled]);

  const status = useSyncExternalStore(client.onStatus, client.getStatus, client.getStatus);
  const isLive = enabled && status === 'live';

  const prevLive = useRef<boolean | null>(null);
  useEffect(() => {
    if (!enabled) {
      prevLive.current = null;
      return;
    }
    const prev = prevLive.current;
    prevLive.current = isLive;
    if (prev !== null && prev !== isLive) void refetchRef.current?.(); // resync on drop and on recovery
    if (isLive) return;
    const id = setInterval(() => void refetchRef.current?.(), pollIntervalMs);
    return () => clearInterval(id);
  }, [isLive, enabled, pollIntervalMs]);

  return { status, isLive };
}
