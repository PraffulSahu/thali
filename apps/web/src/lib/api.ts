/**
 * The one HTTP client for the web app. Every call goes through the gateway under `/api/v1`.
 *
 *   const restaurants = await api<Paginated<RestaurantCard>>('/discovery/restaurants', { query: { lat, lng } });
 *   await api('/checkouts', { method: 'POST', body, idempotencyKey });
 *   await api('/cart/items', { method: 'POST', body: line, guest: true });
 *
 * - Parses the LLD §1.2 error envelope into `ApiError { code, status, message, details, requestId, retryAfterSec }`.
 * - Access token lives in memory only (`setAccessToken`); never in storage.
 * - On 401 it performs ONE `POST /auth/refresh` (cookie, `credentials: 'include'`, `X-Requested-With: thali-web`),
 *   shared by all concurrent callers, then retries the request once with the new token. If the refresh is
 *   rejected with 401 (or 403 ACCOUNT_BLOCKED) and there was a session, the token is cleared and
 *   `onSessionExpired` listeners fire (the UI shows "Session expired — sign in again" and preserves the route).
 *   Transient refresh failures (offline, 5xx, 429) keep the token and throw that retryable error instead.
 * - `X-Requested-With: thali-web` is sent on every request (CSRF header required by the cookie endpoints).
 */
import type { Paginated } from '@thali/contracts';
import { ApiError, isApiError, isRetryable } from './errors';
import { ensureGuestCartToken, getGuestCartToken, GUEST_CART_HEADER } from './guest';

export type { Paginated };

export const API_BASE = '/api/v1';
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'thali-web';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly (string | number)[]>;

export interface ApiOptions {
  method?: HttpMethod;
  /** JSON-serialized unless it is FormData / Blob / URLSearchParams / ArrayBuffer / string. */
  body?: unknown;
  /** Appended as a query string; `undefined`/`null`/'' values are skipped, arrays repeat the key. */
  query?: Query;
  /** Sets `Idempotency-Key` (8–128 chars `[A-Za-z0-9_-]`). Use `useIdempotencyKey()`. */
  idempotencyKey?: string;
  /** Cart calls: send `X-Guest-Cart` while signed out (mutations create the token if missing). */
  guest?: boolean;
  /** Default true: attach the bearer token and do the 401 refresh/retry dance. */
  auth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  credentials?: RequestCredentials;
}

/* ------------------------------------------------------------------ token store */

let accessToken: string | null = null;
const tokenListeners = new Set<(token: string | null) => void>();
const expiredListeners = new Set<() => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  if (token === accessToken) return;
  accessToken = token;
  for (const l of [...tokenListeners]) l(token);
}

/** Subscribe to access-token changes (sign-in, refresh, sign-out). Returns an unsubscribe function. */
export function onAccessTokenChange(listener: (token: string | null) => void): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

/** Fired once when a signed-in session can no longer be refreshed. Returns an unsubscribe function. */
export function onSessionExpired(listener: () => void): () => void {
  expiredListeners.add(listener);
  return () => expiredListeners.delete(listener);
}

function emitSessionExpired(): void {
  for (const l of [...expiredListeners]) l();
}

/* ------------------------------------------------------------------ url helpers */

export function apiUrl(path: string, query?: Query): string {
  const base = /^https?:\/\//.test(path) || path.startsWith('/api/') ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
    else if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
}

/* ------------------------------------------------------------------ core request */

function isRawBody(b: unknown): b is BodyInit {
  return (
    typeof b === 'string' ||
    (typeof FormData !== 'undefined' && b instanceof FormData) ||
    (typeof Blob !== 'undefined' && b instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) ||
    b instanceof ArrayBuffer
  );
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, Math.ceil(secs));
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

async function parseResponse<T>(res: Response): Promise<T> {
  const headerRequestId = res.headers.get('x-request-id') ?? undefined;
  const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'));
  if (res.status === 204 || res.status === 205) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  let data: unknown;
  let parsed = false;
  if (text && (contentType.includes('json') || /^[[{]/.test(text.trim()))) {
    try {
      data = JSON.parse(text);
      parsed = true;
    } catch {
      parsed = false;
    }
  }

  if (res.ok) {
    if (!text) return undefined as T;
    if (parsed) return data as T;
    if (contentType.includes('json')) {
      throw new ApiError({ code: 'INVALID_RESPONSE', status: res.status, message: 'The server sent an unreadable response.', requestId: headerRequestId });
    }
    return text as T;
  }

  const envelope = parsed ? (data as { error?: { code?: unknown; message?: unknown; details?: unknown; requestId?: unknown } })?.error : undefined;
  if (envelope && typeof envelope.code === 'string') {
    const details = envelope.details;
    const detailRetry = (details as { retryAfterSec?: unknown } | undefined)?.retryAfterSec;
    throw new ApiError({
      code: envelope.code,
      status: res.status,
      message: typeof envelope.message === 'string' ? envelope.message : res.statusText,
      details,
      requestId: typeof envelope.requestId === 'string' ? envelope.requestId : headerRequestId,
      retryAfterSec: retryAfterSec ?? (typeof detailRetry === 'number' ? Math.ceil(detailRetry) : undefined),
    });
  }

  const code =
    res.status === 504 ? 'UPSTREAM_TIMEOUT'
    : res.status >= 502 && res.status <= 503 ? 'UPSTREAM_UNAVAILABLE'
    : res.status === 401 ? 'UNAUTHENTICATED'
    : res.status === 429 ? 'RATE_LIMITED'
    : 'HTTP_ERROR';
  throw new ApiError({
    code,
    status: res.status,
    message: res.statusText || `Request failed (${res.status})`,
    requestId: headerRequestId,
    retryAfterSec,
  });
}

async function send<T>(path: string, opts: ApiOptions, token: string | null): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', [CSRF_HEADER]: CSRF_VALUE, ...opts.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.guest && !token) {
    const guestToken = method === 'GET' ? getGuestCartToken() : await ensureGuestCartToken();
    if (guestToken) headers[GUEST_CART_HEADER] = guestToken;
  }

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (isRawBody(opts.body)) body = opts.body;
    else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: opts.credentials ?? 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError({ code: 'NETWORK_ERROR', status: 0, message: 'Network request failed' });
  }
  return parseResponse<T>(res);
}

/* ------------------------------------------------------------------ refresh */

export interface AuthTokenResponse {
  accessToken: string;
  user?: unknown;
  [key: string]: unknown;
}

let refreshing: Promise<AuthTokenResponse> | null = null;
let lastAnonymousRefreshFailure = 0;
const ANON_REFRESH_BACKOFF_MS = 30_000;

/**
 * `POST /auth/refresh` with the httpOnly cookie. Single-flight: concurrent callers share one request
 * (refresh tokens rotate, so two parallel refreshes would trip reuse detection). On success stores the new
 * access token. On failure throws (does NOT clear the token or emit session-expired; `api()` decides that).
 */
export function refreshSession(): Promise<AuthTokenResponse> {
  if (!refreshing) {
    refreshing = send<AuthTokenResponse>('/auth/refresh', { method: 'POST', credentials: 'include' }, null)
      .then((res) => {
        if (!res || typeof res.accessToken !== 'string') {
          throw new ApiError({ code: 'INVALID_RESPONSE', status: 200, message: 'Refresh response missing accessToken' });
        }
        setAccessToken(res.accessToken);
        return res;
      })
      .catch((err: unknown) => {
        if (!accessToken) lastAnonymousRefreshFailure = Date.now();
        throw err;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

const NO_REFRESH_CODES = new Set(['INVALID_CREDENTIALS']);

/**
 * Whether a failed `POST /auth/refresh` means the session is really over: any 401 from refresh
 * (UNAUTHENTICATED, SESSION_REVOKED, SESSION_REUSE_DETECTED, ...) or 403 ACCOUNT_BLOCKED.
 * Network errors, 5xx, 429 and other 403s (CSRF_CHECK_FAILED) do NOT end the session.
 */
export function refreshEndsSession(e: unknown): boolean {
  return isApiError(e) && (e.status === 401 || (e.status === 403 && e.code === 'ACCOUNT_BLOCKED'));
}
const isAuthPath = (path: string) => /^(\/api\/v1)?\/?auth\//.test(path);

/** Typed request to the API. See module docs. Throws `ApiError` (or `AbortError` when aborted). */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const useAuth = opts.auth !== false;
  const tokenAtStart = useAuth ? accessToken : null;
  try {
    return await send<T>(path, opts, tokenAtStart);
  } catch (err) {
    if (!useAuth || !isApiError(err) || err.status !== 401 || NO_REFRESH_CODES.has(err.code) || isAuthPath(path)) throw err;

    // Someone else already refreshed while we were in flight: just retry with the current token.
    if (accessToken && accessToken !== tokenAtStart) return send<T>(path, opts, accessToken);

    // Anonymous caller whose refresh recently failed: no cookie session, don't hammer /auth/refresh.
    if (!tokenAtStart && !refreshing && Date.now() - lastAnonymousRefreshFailure < ANON_REFRESH_BACKOFF_MS) throw err;

    let refreshed: AuthTokenResponse;
    try {
      refreshed = await refreshSession();
    } catch (refreshErr) {
      if (refreshEndsSession(refreshErr)) {
        if (tokenAtStart && accessToken !== null) {
          setAccessToken(null);
          emitSessionExpired();
        }
        throw err;
      }
      // Transient refresh failure (offline, 5xx, 429): the session may still be fine. Keep the token and
      // surface the retryable refresh error so the UI offers "Try again" rather than "sign in again".
      // Anything else (e.g. 403 CSRF_CHECK_FAILED, a 200 without a token) also keeps the token and
      // rethrows the original 401.
      throw isRetryable(refreshErr) ? refreshErr : err;
    }
    return send<T>(path, opts, refreshed.accessToken);
  }
}

/** Test-only: reset module state between tests. */
export function __resetApiForTests(): void {
  accessToken = null;
  refreshing = null;
  lastAnonymousRefreshFailure = 0;
  tokenListeners.clear();
  expiredListeners.clear();
}
