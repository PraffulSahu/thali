/**
 * Run a callback on an interval while `enabled`. The latest callback is always used.
 *
 *   usePolling(() => checkout.refetch(), 3000, { enabled: checkout.data?.status === 'AWAITING_PAYMENT' });
 *
 * Options: `immediate` (run once on enable), `pauseWhenHidden` (skip ticks while the tab is hidden and run
 * once when it becomes visible again). For realtime-backed screens use `useRealtime({ fallbackRefetch })`
 * instead; it polls only while the live stream is down. For plain query polling TanStack's
 * `refetchInterval` is also fine.
 */
import { useEffect, useRef } from 'react';

export interface UsePollingOptions {
  enabled?: boolean;
  immediate?: boolean;
  pauseWhenHidden?: boolean;
}

export function usePolling(callback: () => unknown, intervalMs: number, opts: UsePollingOptions = {}): void {
  const { enabled = true, immediate = false, pauseWhenHidden = false } = opts;
  const cb = useRef(callback);
  useEffect(() => {
    cb.current = callback;
  });

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const hidden = () => pauseWhenHidden && typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (immediate) void cb.current();
    const id = setInterval(() => {
      if (!hidden()) void cb.current();
    }, intervalMs);
    const onVisible = () => {
      if (pauseWhenHidden && document.visibilityState === 'visible') void cb.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, immediate, pauseWhenHidden]);
}
