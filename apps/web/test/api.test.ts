import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, getAccessToken, onSessionExpired, setAccessToken } from '../src/lib/api';
import { ApiError } from '../src/lib/errors';
import { GUEST_CART_STORAGE_KEY } from '../src/lib/guest';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const fetchMock = vi.fn<typeof fetch>();
const call = (i: number) => {
  const [url, init] = fetchMock.mock.calls[i]!;
  return { url: String(url), init: init ?? {}, headers: new Headers(init?.headers) };
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setAccessToken(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken(null);
});

describe('api()', () => {
  it('prefixes /api/v1, sends bearer token and JSON body', async () => {
    setAccessToken('tok');
    fetchMock.mockResolvedValueOnce(json(201, { id: 'x' }));
    const res = await api<{ id: string }>('/cart/items', { method: 'POST', body: { itemId: 'i1' } });
    expect(res).toEqual({ id: 'x' });
    const c = call(0);
    expect(c.url).toBe('/api/v1/cart/items');
    expect(c.init.method).toBe('POST');
    expect(c.headers.get('Authorization')).toBe('Bearer tok');
    expect(c.headers.get('Content-Type')).toBe('application/json');
    expect(c.init.body).toBe(JSON.stringify({ itemId: 'i1' }));
  });

  it('serializes query params and skips undefined/null', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { items: [], nextCursor: null }));
    await api('/discovery/restaurants', { query: { lat: 12.9, lng: 77.5, veg: true, q: undefined, cursor: null } });
    expect(call(0).url).toBe('/api/v1/discovery/restaurants?lat=12.9&lng=77.5&veg=true');
  });

  it('returns undefined for 204', async () => {
    fetchMock.mockResolvedValueOnce(json(204, null));
    await expect(api('/cart', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('on 401 UNAUTHENTICATED refreshes once (cookie + CSRF header) and retries with the new token', async () => {
    setAccessToken('old');
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', requestId: 'r1' } }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new' }))
      .mockResolvedValueOnce(json(200, { ok: true }));

    await expect(api<{ ok: boolean }>('/orders')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(call(0).headers.get('Authorization')).toBe('Bearer old');
    const refresh = call(1);
    expect(refresh.url).toBe('/api/v1/auth/refresh');
    expect(refresh.init.method).toBe('POST');
    expect(refresh.init.credentials).toBe('include');
    expect(refresh.headers.get('X-Requested-With')).toBe('thali-web');
    expect(call(2).url).toBe('/api/v1/orders');
    expect(call(2).headers.get('Authorization')).toBe('Bearer new');
    expect(getAccessToken()).toBe('new');
  });

  it('shares a single refresh between concurrent 401s', async () => {
    setAccessToken('old');
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) return json(200, { accessToken: 'new' });
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth === 'Bearer old') return json(401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } });
      return json(200, { url });
    });
    const [a, b] = await Promise.all([api<{ url: string }>('/a'), api<{ url: string }>('/b')]);
    expect(a.url).toBe('/api/v1/a');
    expect(b.url).toBe('/api/v1/b');
    const refreshCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('when refresh fails: emits session-expired, clears the token and throws the original 401', async () => {
    setAccessToken('old');
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', requestId: 'r1' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'SESSION_REVOKED', message: 'revoked', requestId: 'r2' } }));

    const err = await api('/orders').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    off();
  });

  it.each([
    ['401 SESSION_REUSE_DETECTED', () => json(401, { error: { code: 'SESSION_REUSE_DETECTED', message: 'reuse', requestId: 'r2' } })],
    ['403 ACCOUNT_BLOCKED', () => json(403, { error: { code: 'ACCOUNT_BLOCKED', message: 'blocked', requestId: 'r2' } })],
  ])('refresh rejected with %s ends the session', async (_label, refreshResponse) => {
    setAccessToken('old');
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', requestId: 'r1' } }))
      .mockResolvedValueOnce(refreshResponse());
    const err = (await api('/orders').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    off();
  });

  it.each([
    ['network error', () => Promise.reject(new TypeError('Failed to fetch')), 'NETWORK_ERROR', 0],
    ['503', () => Promise.resolve(json(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'down', requestId: 'r2' } })), 'SERVICE_UNAVAILABLE', 503],
    ['502 html', () => Promise.resolve(new Response('bad gateway', { status: 502, headers: { 'content-type': 'text/html' } })), 'UPSTREAM_UNAVAILABLE', 502],
    ['504', () => Promise.resolve(json(504, { error: { code: 'UPSTREAM_TIMEOUT', message: 'slow', requestId: 'r2' } })), 'UPSTREAM_TIMEOUT', 504],
    ['429', () => Promise.resolve(json(429, { error: { code: 'RATE_LIMITED', message: 'slow down', requestId: 'r2' } }, { 'Retry-After': '5' })), 'RATE_LIMITED', 429],
  ])('transient refresh failure (%s) keeps the session and throws a retryable error', async (_label, refreshResponse, code, status) => {
    setAccessToken('old');
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', requestId: 'r1' } }))
      .mockImplementationOnce(refreshResponse);
    const err = (await api('/orders').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(expired).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('old');
    off();
  });

  it('403 CSRF_CHECK_FAILED from refresh keeps the session (original 401 rethrown, no expiry event)', async () => {
    setAccessToken('old');
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired', requestId: 'r1' } }))
      .mockResolvedValueOnce(json(403, { error: { code: 'CSRF_CHECK_FAILED', message: 'csrf', requestId: 'r2' } }));
    const err = (await api('/orders').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('UNAUTHENTICATED');
    expect(expired).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe('old');
    off();
  });

  it('does not emit session-expired for anonymous 401s (no session to expire)', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'login', requestId: 'r1' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'no cookie', requestId: 'r2' } }));
    await expect(api('/orders')).rejects.toBeInstanceOf(ApiError);
    expect(expired).not.toHaveBeenCalled();
    off();
  });

  it('parses the error envelope into ApiError {code,status,message,details,requestId}', async () => {
    fetchMock.mockResolvedValueOnce(
      json(422, {
        error: { code: 'PRICE_CHANGED', message: 'Prices changed', details: { totalPaise: 1200 }, requestId: 'req-9' },
      }),
    );
    const err = (await api('/checkouts', { method: 'POST', body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('PRICE_CHANGED');
    expect(err.status).toBe(422);
    expect(err.message).toBe('Prices changed');
    expect(err.details).toEqual({ totalPaise: 1200 });
    expect(err.requestId).toBe('req-9');
  });

  it('keeps unknown server error codes as open strings', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: 'SOMETHING_NEW', message: 'new', requestId: 'r' } }));
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('SOMETHING_NEW');
  });

  it('reads Retry-After on 429', async () => {
    fetchMock.mockResolvedValueOnce(
      json(429, { error: { code: 'RATE_LIMITED', message: 'slow down', requestId: 'r' } }, { 'Retry-After': '27' }),
    );
    const err = (await api('/auth/otp/request', { method: 'POST', body: { phone: 'x' } }).catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfterSec).toBe(27);
  });

  it('maps a non-JSON gateway failure to UPSTREAM_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(err.status).toBe(502);
  });

  it('maps network failures to NETWORK_ERROR (status 0)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.status).toBe(0);
  });

  it('sets the Idempotency-Key header when provided', async () => {
    setAccessToken('tok');
    fetchMock.mockResolvedValueOnce(json(201, { checkout: {} }));
    await api('/checkouts', { method: 'POST', body: {}, idempotencyKey: 'key_12345678' });
    expect(call(0).headers.get('Idempotency-Key')).toBe('key_12345678');
  });

  it('sends X-Guest-Cart for guest cart calls when signed out, never when signed in', async () => {
    localStorage.setItem(GUEST_CART_STORAGE_KEY, 'guest-token-1');
    fetchMock.mockImplementation(async () => json(200, { items: [] }));
    await api('/cart', { guest: true });
    expect(call(0).headers.get('X-Guest-Cart')).toBe('guest-token-1');

    setAccessToken('tok');
    await api('/cart', { guest: true });
    expect(call(1).headers.get('X-Guest-Cart')).toBeNull();
    expect(call(1).headers.get('Authorization')).toBe('Bearer tok');
  });

  it('creates a guest cart token before a guest cart mutation when none exists', async () => {
    fetchMock
      .mockResolvedValueOnce(json(201, { guestToken: 'fresh-guest' }))
      .mockResolvedValueOnce(json(201, { lines: [] }));
    await api('/cart/items', { method: 'POST', body: { itemId: 'i' }, guest: true });
    expect(call(0).url).toBe('/api/v1/cart/guest');
    expect(call(1).headers.get('X-Guest-Cart')).toBe('fresh-guest');
    expect(localStorage.getItem(GUEST_CART_STORAGE_KEY)).toBe('fresh-guest');
  });
});
