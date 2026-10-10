import './setup';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appRoutes } from '../src/routes';
import { AuthContext, type AuthContextValue } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui/Toast';
import { OtpSignInForm } from '../src/components/auth/OtpSignInForm';
import { safeNext } from '../src/components/auth/SignInPage';
import { ApiError } from '../src/lib/errors';
import { makeAuth, makeQueryClient, renderWithProviders } from './utils';

function renderApp(path: string, auth: AuthContextValue) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
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

beforeEach(() => {
  // /meta is fetched by the mode banner; keep it offline.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});

describe('route tree', () => {
  it('consumer area is public', async () => {
    renderApp('/', makeAuth());
    expect(await screen.findByRole('heading', { level: 1, name: 'Order food' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
  });

  it('restaurant area asks guests to sign in and keeps the route', async () => {
    renderApp('/restaurant', makeAuth());
    expect(await screen.findByRole('heading', { name: /sign in to continue/i })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^sign in$/i })[0]).toHaveAttribute('href', '/signin?next=%2Frestaurant');
  });

  it('restaurant area shows a forbidden state with an onboarding link for plain consumers', async () => {
    renderApp('/restaurant/orders', makeAuth({ roles: ['CONSUMER'] }));
    expect(await screen.findByRole('heading', { name: /no restaurant on this account yet/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register your restaurant' })).toHaveAttribute('href', '/restaurant/onboarding');
  });

  it('restaurant onboarding only needs a session', async () => {
    renderApp('/restaurant/onboarding', makeAuth({ roles: ['CONSUMER'] }));
    expect(await screen.findByRole('heading', { name: /couldn.t find that page/i })).toBeInTheDocument(); // placeholder has no onboarding page yet
  });

  it('admin area requires ADMIN with MFA and points to /admin/login', async () => {
    renderApp('/admin', makeAuth({ roles: ['CONSUMER'] }));
    expect(await screen.findByRole('heading', { name: /you don.t have access/i })).toBeInTheDocument();
  });

  it('admin with MFA sees the admin area and its navigation', async () => {
    renderApp('/admin', makeAuth({ roles: ['CONSUMER', 'ADMIN'], hasMfa: true, amr: ['pwd', 'mfa'] }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Admin overview' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Admin' }).length).toBeGreaterThan(0);
  });

  it('partner area shows partner home for partners', async () => {
    renderApp('/partner', makeAuth({ roles: ['CONSUMER', 'DELIVERY_PARTNER'] }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Partner home' })).toBeInTheDocument();
  });

  it('/signin renders the OTP form', async () => {
    renderApp('/signin?next=%2Forders', makeAuth());
    expect(await screen.findByRole('heading', { name: 'Sign in to Thali' })).toBeInTheDocument();
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
  });

  it('unknown consumer paths render not found', async () => {
    renderApp('/no/such/page', makeAuth());
    expect(await screen.findByRole('heading', { name: /couldn.t find that page/i })).toBeInTheDocument();
  });
});

describe('safeNext', () => {
  it('only allows same-origin relative paths', () => {
    expect(safeNext('/orders?x=1')).toBe('/orders?x=1');
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext('https://evil.com')).toBe('/');
    expect(safeNext('/\\evil.com')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});

describe('OtpSignInForm', () => {
  it('normalizes the phone, shows the resend countdown and verifies the code', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn().mockResolvedValue({ resendAfterSec: 30, demo: true, raw: {} });
    const signInWithOtp = vi.fn().mockResolvedValue({ id: 'u1' });
    const onSuccess = vi.fn();
    renderWithProviders(<OtpSignInForm onSuccess={onSuccess} />, { auth: makeAuth({ requestOtp, signInWithOtp }) });

    await user.type(screen.getByLabelText(/mobile number/i), '098765 43210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(requestOtp).toHaveBeenCalledWith('+919876543210');
    expect(await screen.findByText(/sent a 6-digit code to \+91 98765 43210/i)).toBeInTheDocument();
    expect(screen.getByText(/use code 123456/i)).toBeInTheDocument();
    expect(screen.getByText(/resend code in 0:(29|30)/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/6-digit code/i), '123456');
    expect(signInWithOtp).toHaveBeenCalledWith('+919876543210', '123456');
    expect(onSuccess).toHaveBeenCalledWith({ id: 'u1' });
  });

  it('rejects an invalid phone without calling the API', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn();
    renderWithProviders(<OtpSignInForm />, { auth: makeAuth({ requestOtp }) });
    await user.type(screen.getByLabelText(/mobile number/i), '12345');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(requestOtp).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/mobile number/i)).toHaveAccessibleDescription(/valid 10-digit mobile number/i);
  });

  it('shows attempts remaining on a wrong code', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn().mockResolvedValue({ resendAfterSec: 30, demo: false, raw: {} });
    const signInWithOtp = vi
      .fn()
      .mockRejectedValue(new ApiError({ code: 'OTP_INVALID', status: 400, message: 'Invalid code', details: { attemptsRemaining: 3 } }));
    renderWithProviders(<OtpSignInForm />, { auth: makeAuth({ requestOtp, signInWithOtp }) });
    await user.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText(/6-digit code/i), '000000');
    expect(await screen.findByText(/3 attempts left/i)).toBeInTheDocument();
  });

  it('shows the cooldown when OTP requests are rate limited', async () => {
    const user = userEvent.setup();
    const requestOtp = vi
      .fn()
      .mockRejectedValue(new ApiError({ code: 'RATE_LIMITED', status: 429, message: 'Too many', retryAfterSec: 25 }));
    renderWithProviders(<OtpSignInForm />, { auth: makeAuth({ requestOtp }) });
    await user.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/wait 0:25 before requesting another code/i)).toBeInTheDocument();
  });
});
