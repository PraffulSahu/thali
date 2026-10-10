import '../setup';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignInPage from '../../src/components/auth/SignInPage';
import { AdminForgotPage, AdminResetPasswordPage } from '../../src/components/auth/AdminPasswordPages';
import { AuthContext, type AuthContextValue } from '../../src/lib/auth';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { ToastProvider } from '../../src/components/ui/Toast';
import { makeAuth, makeJwt, makeQueryClient } from '../utils';

function renderAt(path: string, auth: AuthContextValue) {
  const router = createMemoryRouter(
    [
      { path: '/signin', element: <SignInPage /> },
      { path: '/admin/forgot', element: <AdminForgotPage /> },
      { path: '/admin/reset-password', element: <AdminResetPasswordPage /> },
      { path: '*', element: <p>LANDED</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <AuthContext.Provider value={auth}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return router;
}

const slow = { timeout: 4000 };

/** fetch mock answering `path` with a fresh Response; everything else (e.g. /meta) fails offline. */
function respond(path: string, make: () => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === path) return make();
    throw new TypeError('offline');
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls: () => fn.mock.calls.filter(([u]) => String(u) === path) as unknown as Array<[string, RequestInit]> };
}

beforeEach(() => {
  __resetApiForTests();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});
afterEach(() => {
  setAccessToken(null);
  vi.unstubAllGlobals();
});

describe('unified sign-in', () => {
  it('role tabs swap copy and update ?role= (next kept)', async () => {
    const user = userEvent.setup();
    const router = renderAt('/signin?next=%2Forders', makeAuth());
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /your cart comes with you/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restaurant' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Restaurant sign in' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?next=%2Forders&role=restaurant');
    await user.click(screen.getByRole('button', { name: 'Admin' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Operations sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Forgot?' })).toHaveAttribute('href', '/admin/forgot');
  });

  it('restaurant OTP sign-in without the owner role lands on onboarding', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn().mockResolvedValue({ resendAfterSec: 30, demo: true, raw: {} });
    const signInWithOtp = vi.fn().mockImplementation(async () => {
      setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'] }));
      return { id: 'u1', roles: ['CONSUMER'] };
    });
    const router = renderAt('/signin?role=restaurant', makeAuth({ requestOtp, signInWithOtp }));
    await user.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Demo mode: no SMS is sent. Use code 123456.', {}, slow)).toBeInTheDocument();
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await waitFor(() => expect(router.state.location.pathname).toBe('/restaurant/onboarding'), slow);
  });

  it('partner OTP sign-in with the partner role honours ?next=', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn().mockResolvedValue({ resendAfterSec: 30, demo: false, raw: {} });
    const signInWithOtp = vi.fn().mockImplementation(async () => {
      setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER', 'DELIVERY_PARTNER'] }));
      return { id: 'u1' };
    });
    const router = renderAt('/signin?role=partner&next=%2Fpartner%2Fearnings', makeAuth({ requestOtp, signInWithOtp }));
    await user.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('6-digit code', {}, slow), '123456');
    await waitFor(() => expect(router.state.location.pathname).toBe('/partner/earnings'), slow);
  });

  it('admin: password then authenticator code, then /admin (or next)', async () => {
    const user = userEvent.setup();
    const adminLogin = vi.fn().mockResolvedValue({ kind: 'mfaRequired', mfaToken: 'm1' });
    const adminVerifyMfa = vi.fn().mockResolvedValue({ id: 'a1' });
    const router = renderAt('/signin?role=admin&next=%2Fadmin%2Faudit', makeAuth({ adminLogin, adminVerifyMfa }));
    await user.type(screen.getByLabelText(/work email/i), 'ops@thali.app');
    await user.type(screen.getByLabelText(/^password/i), 'secret-pass');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(adminLogin).toHaveBeenCalledWith('ops@thali.app', 'secret-pass');
    await user.type(await screen.findByLabelText('Authenticator code', {}, slow), '654321');
    expect(adminVerifyMfa).toHaveBeenCalledWith('m1', '654321');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/audit'), slow);
  });

  it('show/hide password toggle', async () => {
    const user = userEvent.setup();
    renderAt('/signin?role=admin', makeAuth());
    const pw = screen.getByLabelText(/^password/i);
    expect(pw).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(pw).toHaveAttribute('type', 'text');
  });

  it('already signed in → straight to the role destination', async () => {
    const router = renderAt('/signin?role=partner', makeAuth({ roles: ['CONSUMER'] }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/partner/onboarding'), slow);
  });
});

describe('admin password reset (IDN-1)', () => {
  it('forgot always confirms (no account probing)', async () => {
    const user = userEvent.setup();
    const m = respond('/api/v1/auth/admin/password/forgot', () => new Response(null, { status: 202 }));
    renderAt('/admin/forgot', makeAuth());
    await user.type(screen.getByLabelText(/work email/i), 'ops@thali.app');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/we’ve emailed a reset link/i, {}, slow)).toBeInTheDocument();
    expect(JSON.parse(String(m.calls()[0]![1].body))).toEqual({ email: 'ops@thali.app' });
  });

  it('reset strips the token from the URL, sets no-referrer and posts token + password + TOTP', async () => {
    const user = userEvent.setup();
    const m = respond('/api/v1/auth/admin/password/reset', () => new Response(null, { status: 204 }));
    const router = renderAt('/admin/reset-password?token=tok-123', makeAuth());
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
    await user.type(screen.getByLabelText(/^new password/i), 'n3w-password!');
    await user.type(screen.getByLabelText(/confirm new password/i), 'n3w-password!');
    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('heading', { name: 'Password changed' }, slow)).toBeInTheDocument();
    expect(JSON.parse(String(m.calls()[0]![1].body))).toEqual({ token: 'tok-123', newPassword: 'n3w-password!', totpCode: '123456' });
  });

  it('reset validates locally before calling the API', async () => {
    const user = userEvent.setup();
    const m = respond('/api/v1/auth/admin/password/reset', () => new Response(null, { status: 204 }));
    renderAt('/admin/reset-password?token=t', makeAuth());
    await user.type(screen.getByLabelText(/^new password/i), 'short');
    await user.type(screen.getByLabelText(/confirm new password/i), 'other');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByText(/at least 8 characters\./i, { selector: 'p span, span' })).toBeInTheDocument();
    expect(screen.getByText(/passwords don’t match/i)).toBeInTheDocument();
    expect(m.calls()).toHaveLength(0);
  });

  it('invalid token / TOTP shows a clear error', async () => {
    const user = userEvent.setup();
    respond(
      '/api/v1/auth/admin/password/reset',
      () => new Response(JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid' } }), { status: 401, headers: { 'content-type': 'application/json' } }),
    );
    renderAt('/admin/reset-password?token=t', makeAuth());
    await user.type(screen.getByLabelText(/^new password/i), 'n3w-password!');
    await user.type(screen.getByLabelText(/confirm new password/i), 'n3w-password!');
    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/invalid or has expired, or the authenticator code is wrong/i, {}, slow)).toBeInTheDocument();
  });
});
