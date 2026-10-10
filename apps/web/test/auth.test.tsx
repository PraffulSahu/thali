import './setup';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken, onSessionExpired, setAccessToken } from '../src/lib/api';
import { __resetAuthForTests, AuthProvider, useAuth } from '../src/lib/auth';
import { GUEST_CART_STORAGE_KEY } from '../src/lib/guest';
import { otpErrorInfo } from '../src/lib/errors';
import { ApiError } from '../src/lib/errors';
import { makeJwt } from './utils';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fetchMock = vi.fn<typeof fetch>();
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));
const bodyOf = (i: number) => JSON.parse(String(fetchMock.mock.calls[i]![1]?.body ?? 'null')) as Record<string, unknown>;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AuthProvider>{children}</AuthProvider>
  </QueryClientProvider>
);

const exp = () => Math.floor(Date.now() / 1000) + 900;
const consumerToken = makeJwt({ sub: 'u1', roles: ['CONSUMER'], sid: 's1', amr: ['otp'], exp: exp() });
const ownerToken = makeJwt({ sub: 'u1', roles: ['CONSUMER', 'RESTAURANT_OWNER'], sid: 's1', amr: ['otp'], exp: exp() });
const user = { id: 'u1', phone: '+919876543210', roles: ['CONSUMER'] };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setAccessToken(null);
  __resetAuthForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthProvider', () => {
  it('restores the session on boot via silent refresh', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { accessToken: consumerToken, user }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(urls()[0]).toBe('/api/v1/auth/refresh');
    expect(result.current.roles).toEqual(['CONSUMER']);
    expect(result.current.user?.id).toBe('u1');
  });

  it('fetches /me when the refresh response carries no user', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { accessToken: consumerToken })).mockResolvedValueOnce(json(200, user));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(urls()).toEqual(['/api/v1/auth/refresh', '/api/v1/me']);
    expect(result.current.user?.phone).toBe('+919876543210');
  });

  it('boots anonymous when there is no session, without a session-expired event', async () => {
    const expired = vi.fn();
    const off = onSessionExpired(expired);
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'no cookie', requestId: 'r' } }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));
    expect(expired).not.toHaveBeenCalled();
    off();
  });

  it('signInWithOtp sends the guest cart token, stores the access token and clears the merged guest cart', async () => {
    localStorage.setItem(GUEST_CART_STORAGE_KEY, 'g1');
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'no cookie', requestId: 'r' } }))
      .mockResolvedValueOnce(json(200, { accessToken: consumerToken, user, guestCartMerged: true }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));
    await act(() => result.current.signInWithOtp('+919876543210', '123456'));
    expect(urls()[1]).toBe('/api/v1/auth/otp/verify');
    expect(bodyOf(1)).toEqual({ phone: '+919876543210', code: '123456', guestCartToken: 'g1' });
    expect(fetchMock.mock.calls[1]![1]?.credentials).toBe('include');
    expect(getAccessToken()).toBe(consumerToken);
    expect(result.current.status).toBe('authenticated');
    expect(localStorage.getItem(GUEST_CART_STORAGE_KEY)).toBeNull();
  });

  it('retries the cart merge itself when the server could not merge during verify', async () => {
    localStorage.setItem(GUEST_CART_STORAGE_KEY, 'g1');
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } }))
      .mockResolvedValueOnce(json(200, { accessToken: consumerToken, user, guestCartMerged: false }))
      .mockResolvedValueOnce(json(200, { merged: true }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));
    await act(() => result.current.signInWithOtp('+919876543210', '123456'));
    expect(urls()[2]).toBe('/api/v1/cart/merge');
    expect(bodyOf(2)).toEqual({ guestToken: 'g1' });
    expect(localStorage.getItem(GUEST_CART_STORAGE_KEY)).toBeNull();
  });

  it('adminLogin handles mfaRequired and then the MFA step', async () => {
    const adminToken = makeJwt({ sub: 'a1', roles: ['CONSUMER', 'ADMIN'], adm: ['OPS'], amr: ['pwd', 'mfa'], exp: exp() });
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } }))
      .mockResolvedValueOnce(json(200, { mfaRequired: true, mfaToken: 'mfa-1' }))
      .mockResolvedValueOnce(json(200, { accessToken: adminToken, user: { id: 'a1', email: 'ops@thali.test', roles: ['CONSUMER', 'ADMIN'] } }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));

    let step: Awaited<ReturnType<typeof result.current.adminLogin>> | undefined;
    await act(async () => {
      step = await result.current.adminLogin('ops@thali.test', 'pw');
    });
    expect(step).toEqual({ kind: 'mfaRequired', mfaToken: 'mfa-1' });
    expect(getAccessToken()).toBeNull();

    await act(() => result.current.adminVerifyMfa('mfa-1', '654321'));
    expect(urls()[2]).toBe('/api/v1/auth/admin/mfa');
    expect(bodyOf(2)).toEqual({ mfaToken: 'mfa-1', code: '654321' });
    expect(result.current.hasMfa).toBe(true);
    expect(result.current.adminRoles).toEqual(['OPS']);
    expect(result.current.hasRole('ADMIN')).toBe(true);
  });

  it('adminLogin surfaces mfaSetupRequired and keeps the password-only token for setup calls', async () => {
    const pwdToken = makeJwt({ sub: 'a1', roles: ['CONSUMER', 'ADMIN'], amr: ['pwd'], exp: exp() });
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } }))
      .mockResolvedValueOnce(json(200, { mfaSetupRequired: true, accessToken: pwdToken }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));
    let step: Awaited<ReturnType<typeof result.current.adminLogin>> | undefined;
    await act(async () => {
      step = await result.current.adminLogin('ops@thali.test', 'pw');
    });
    expect(step?.kind).toBe('mfaSetupRequired');
    expect(getAccessToken()).toBe(pwdToken);
    expect(result.current.hasMfa).toBe(false);
  });

  it('refreshUser rotates the token to pick up newly granted roles', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { accessToken: consumerToken, user }))
      .mockResolvedValueOnce(json(200, { accessToken: ownerToken, user: { ...user, roles: ['CONSUMER', 'RESTAURANT_OWNER'] } }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.hasRole('RESTAURANT_OWNER')).toBe(false);
    await act(() => result.current.refreshUser());
    expect(result.current.hasRole('RESTAURANT_OWNER')).toBe(true);
  });

  it('signOut calls /auth/logout and clears the session', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { accessToken: consumerToken, user })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    await act(() => result.current.signOut());
    expect(urls()[1]).toBe('/api/v1/auth/logout');
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get('X-Requested-With')).toBe('thali-web');
    expect(getAccessToken()).toBeNull();
    expect(result.current.status).toBe('anonymous');
  });
});

describe('otpErrorInfo', () => {
  it('reads cooldown and remaining attempts from the error', () => {
    const e = new ApiError({ code: 'OTP_INVALID', status: 400, message: 'wrong', details: { attemptsRemaining: 2 } });
    expect(otpErrorInfo(e)).toMatchObject({ attemptsRemaining: 2 });
    const r = new ApiError({ code: 'RATE_LIMITED', status: 429, message: 'wait', details: { retryAfterSec: 12 }, retryAfterSec: 12 });
    expect(otpErrorInfo(r)).toMatchObject({ retryAfterSec: 12 });
  });
});
