/**
 * Shared clock: `useNow(1000)` re-renders the caller every second with `Date.now()`. All subscribers with the
 * same interval share one timer, so dozens of countdowns/relative times cost a single setInterval.
 */
import { useSyncExternalStore } from 'react';

interface Ticker {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | undefined;
  /** Stable per ticker: a new function identity would make useSyncExternalStore resubscribe every render. */
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => number;
}
const tickers = new Map<number, Ticker>();

function getTicker(ms: number): Ticker {
  const existing = tickers.get(ms);
  if (existing) return existing;
  const t: Ticker = {
    now: Date.now(),
    listeners: new Set(),
    timer: undefined,
    // Never touch `t.now` here: a subscribe that changes the snapshot forces a re-render, and with a single
    // subscriber (unsubscribe -> timer stops -> resubscribe) that loops until "Maximum update depth exceeded".
    subscribe: (cb) => {
      t.listeners.add(cb);
      if (!t.timer) {
        t.timer = setInterval(() => {
          t.now = Date.now();
          for (const l of [...t.listeners]) l();
        }, ms);
      }
      return () => {
        t.listeners.delete(cb);
        if (t.listeners.size === 0 && t.timer) {
          clearInterval(t.timer);
          t.timer = undefined;
        }
      };
    },
    getSnapshot: () => {
      // Idle ticker (first render before any subscribe): refresh a stale value, but keep it stable per tick
      // because useSyncExternalStore requires consecutive snapshots to be equal.
      if (!t.timer && t.listeners.size === 0 && Date.now() - t.now >= ms) t.now = Date.now();
      return t.now;
    },
  };
  tickers.set(ms, t);
  return t;
}

export function useNow(intervalMs = 1000): number {
  const t = getTicker(intervalMs);
  return useSyncExternalStore(t.subscribe, t.getSnapshot, t.getSnapshot);
}
