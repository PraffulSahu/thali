/**
 * Realtime connection manager (HLD §3.3, LLD §11).
 *
 * One shared SSE connection per tab: `POST /api/v1/realtime/ticket` (bearer) -> `{ ticket }` (30 s, single
 * use) -> `EventSource('/api/v1/realtime/stream?ticket=...')`. Components subscribe to SSE `event:` names
 * (`order.updated`, `owner.order`, `delivery.location`, `partner.offer`, `notification`) through the
 * `useRealtime()` hook; the stream opens with the first subscriber and closes with the last.
 *
 * Status: 'connecting' (first attempt) -> 'live' (stream open) -> on error the stream is closed and the
 * client goes 'polling' while it waits for an exponential-backoff reconnect (1 s, 2 s, 4 s … max 30 s,
 * ±20 % jitter); during each attempt the status is 'reconnecting'. Every attempt fetches a NEW ticket
 * because tickets are single-use (so the browser's built-in EventSource auto-retry is never relied on).
 * While signed out (no access token) the client stays 'polling' and reconnects when a token appears.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react';
import { api, apiUrl, getAccessToken, onAccessTokenChange } from './api';

export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';

export interface RealtimeEvent<T = unknown> {
  /** SSE event name, e.g. 'order.updated'. */
  type: string;
  /** JSON-parsed `data:` (raw string if it was not JSON). */
  data: T;
}

/** The subset of EventSource we use (lets tests inject a fake). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}
export type EventSourceCtor = new (url: string) => EventSourceLike;

export interface RealtimeClientOptions {
  fetchTicket?: () => Promise<string>;
  EventSource?: EventSourceCtor;
  /** Whether a stream may be opened now (default: an access token exists). */
  canConnect?: () => boolean;
  /** Notifies when `canConnect()` may have changed (default: access-token changes). */
  subscribeAuth?: (cb: () => void) => () => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface RealtimeClient {
  subscribe(events: readonly string[], handler: (e: RealtimeEvent) => void): () => void;
  getStatus(): RealtimeStatus;
  onStatus(listener: () => void): () => void;
  dispose(): void;
}

export const REALTIME_TICKET_PATH = '/realtime/ticket';
export const realtimeStreamUrl = (ticket: string) => apiUrl('/realtime/stream', { ticket });

async function defaultFetchTicket(): Promise<string> {
  const res = await api<{ ticket?: string; id?: string; token?: string }>(REALTIME_TICKET_PATH, { method: 'POST' });
  const ticket = res?.ticket ?? res?.id ?? res?.token;
  if (!ticket) throw new Error('Realtime ticket missing from response');
  return ticket;
}

interface Subscription {
  events: Set<string>;
  handler: (e: RealtimeEvent) => void;
}

export function createRealtimeClient(opts: RealtimeClientOptions = {}): RealtimeClient {
  const fetchTicket = opts.fetchTicket ?? defaultFetchTicket;
  const ES: EventSourceCtor | undefined =
    opts.EventSource ?? (typeof EventSource === 'undefined' ? undefined : (EventSource as unknown as EventSourceCtor));
  const canConnect = opts.canConnect ?? (() => getAccessToken() !== null);
  const subscribeAuth = opts.subscribeAuth ?? ((cb: () => void) => onAccessTokenChange(() => cb()));
  const base = opts.baseBackoffMs ?? 1_000;
  const max = opts.maxBackoffMs ?? 30_000;

  const subs = new Set<Subscription>();
  const statusListeners = new Set<() => void>();
  let status: RealtimeStatus = 'connecting';
  let source: EventSourceLike | null = null;
  let attached = new Set<string>();
  let attempt = 0;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let authUnsub: (() => void) | null = null;
  let lastCanConnect = false;

  const setStatus = (next: RealtimeStatus) => {
    if (next === status) return;
    status = next;
    for (const l of [...statusListeners]) l();
  };

  const dispatch = (type: string, ev: Event) => {
    const raw = (ev as MessageEvent).data;
    let data: unknown = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }
    for (const s of [...subs]) if (s.events.has(type)) s.handler({ type, data });
  };

  const attach = (type: string) => {
    if (!source || attached.has(type)) return;
    const current = source;
    current.addEventListener(type, (ev) => {
      if (current === source) dispatch(type, ev);
    });
    attached.add(type);
  };

  const closeSource = () => {
    generation += 1;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    source?.close();
    source = null;
    attached = new Set();
  };

  const scheduleRetry = () => {
    setStatus('polling');
    const delay = Math.min(max, base * 2 ** attempt) * (0.8 + Math.random() * 0.4);
    attempt += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void connect(), delay);
  };

  async function connect(): Promise<void> {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (subs.size === 0) return;
    lastCanConnect = canConnect();
    if (!ES || !lastCanConnect) {
      closeSource();
      setStatus('polling');
      return;
    }
    const gen = ++generation;
    setStatus(status === 'connecting' ? 'connecting' : 'reconnecting');
    let ticket: string;
    try {
      ticket = await fetchTicket();
    } catch {
      if (gen === generation) scheduleRetry();
      return;
    }
    if (gen !== generation || subs.size === 0) return;

    const es = new ES(realtimeStreamUrl(ticket));
    source = es;
    attached = new Set();
    for (const s of subs) for (const t of s.events) attach(t);
    es.addEventListener('open', () => {
      if (es !== source) return;
      attempt = 0;
      setStatus('live');
    });
    es.addEventListener('error', () => {
      if (es !== source) return;
      es.close();
      source = null;
      scheduleRetry();
    });
  }

  const onAuthChange = () => {
    const can = canConnect();
    if (can === lastCanConnect) return;
    lastCanConnect = can;
    attempt = 0;
    closeSource();
    void connect();
  };

  const stopAll = () => {
    closeSource();
    authUnsub?.();
    authUnsub = null;
    attempt = 0;
    setStatus('connecting');
  };

  return {
    subscribe(events, handler) {
      const sub: Subscription = { events: new Set(events), handler };
      const first = subs.size === 0;
      subs.add(sub);
      for (const t of sub.events) attach(t);
      if (first) {
        authUnsub = subscribeAuth(onAuthChange);
        void connect();
      }
      return () => {
        if (!subs.delete(sub)) return;
        if (subs.size === 0) stopAll();
      };
    },
    getStatus: () => status,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    dispose() {
      subs.clear();
      stopAll();
      statusListeners.clear();
    },
  };
}

let defaultClient: RealtimeClient | null = null;
export function getDefaultRealtimeClient(): RealtimeClient {
  defaultClient ??= createRealtimeClient();
  return defaultClient;
}

const RealtimeContext = createContext<RealtimeClient | null>(null);

/** Optional: inject a client (tests). Without a provider the shared default client is used. */
export function RealtimeProvider({ client, children }: { client: RealtimeClient; children?: ReactNode }) {
  return createElement(RealtimeContext.Provider, { value: client }, children);
}

export function useRealtimeClient(): RealtimeClient {
  return useContext(RealtimeContext) ?? getDefaultRealtimeClient();
}

/** Copy shown while not live (HLD §3.3, verbatim). */
export const REALTIME_PAUSED_MESSAGE = 'Live updates paused — refreshing every 10 s';
export const REALTIME_POLL_INTERVAL_MS = 10_000;
