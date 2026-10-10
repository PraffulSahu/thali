/**
 * Shared clock: `useNow(1000)` re-renders the caller every second with `Date.now()`. All subscribers with the
 * same interval share one timer, so dozens of countdowns/relative times cost a single setInterval.
 */
import { useSyncExternalStore } from 'react';

interface Ticker {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | undefined;
}
const tickers = new Map<number, Ticker>();

function getTicker(ms: number): Ticker {
  let t = tickers.get(ms);
  if (!t) {
    t = { now: Date.now(), listeners: new Set(), timer: undefined };
    tickers.set(ms, t);
  }
  return t;
}

export function useNow(intervalMs = 1000): number {
  const t = getTicker(intervalMs);
  return useSyncExternalStore(
    (cb) => {
      t.listeners.add(cb);
      if (!t.timer) {
        t.now = Date.now();
        t.timer = setInterval(() => {
          t.now = Date.now();
          for (const l of [...t.listeners]) l();
        }, intervalMs);
      }
      return () => {
        t.listeners.delete(cb);
        if (t.listeners.size === 0 && t.timer) {
          clearInterval(t.timer);
          t.timer = undefined;
        }
      };
    },
    () => {
      // Idle ticker (first render before subscribe): refresh a stale value, but keep it stable per tick
      // because useSyncExternalStore requires consecutive snapshots to be equal.
      if (!t.timer && Date.now() - t.now >= intervalMs) t.now = Date.now();
      return t.now;
    },
    () => t.now,
  );
}
