import './setup';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRouterConfig } from '../src/routes';
import { AuthContext, type AuthContextValue } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui/Toast';
import { OtpSignInForm } from '../src/components/auth/OtpSignInForm';
import { safeNext } from '../src/components/auth/SignInPage';
import { ApiError } from '../src/lib/errors';
import { makeAuth, makeQueryClient, renderWithProviders } from './utils';

function renderApp(path: string, auth: AuthContextValue) {
  const { routes, patchRoutesOnNavigation } = createAppRouterConfig();
  const router = createMemoryRouter(routes, { initialEntries: [path], patchRoutesOnNavigation });
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

/** Lazy area discovery + chunk import can be slow under parallel load. */
const slow = { timeout: 15_000 };
/** Per-test timeout above `slow` (the unit test kind defaults to 10 s). */
const SUITE = { timeout: 30_000 };

beforeEach(() => {
  // /meta is fetched by the mode banner; keep it offline.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});

// These assert only foundation behaviour (shell + guards). Area content is owned by the area tasks and changes.
const guardHeadings = /sign in to continue|verify to continue|you don.t have access|no restaurant on this account|not a delivery partner/i;
async function expectAreaShell(logoName: RegExp) {
  expect(await screen.findByRole('link', { name: logoName }, slow)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
}

describe('route tree', SUITE, () => {
  it('consumer area is public', async () => {
    renderApp('/', makeAuth());
    await expectAreaShell(/^Thali, home$/);
    expect(screen.queryByRole('heading', { name: guardHeadings })).not.toBeInTheDocument();
  });

  it('restaurant area asks guests to sign in and keeps the route', async () => {
    renderApp('/restaurant', makeAuth());
    expect(await screen.findByRole('heading', { name: /sign in to continue/i }, slow)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /^sign in$/i })[0]).toHaveAttribute('href', '/signin?next=%2Frestaurant');
  });

  it('restaurant area shows a forbidden state with an onboarding link for plain consumers', async () => {
    renderApp('/restaurant/orders', makeAuth({ roles: ['CONSUMER'] }));
    expect(await screen.findByRole('heading', { name: /no restaurant on this account yet/i }, slow)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register your restaurant' })).toHaveAttribute('href', '/restaurant/onboarding');
  });

  it('restaurant onboarding only needs a session (no role guard)', async () => {
    renderApp('/restaurant/onboarding', makeAuth({ roles: ['CONSUMER'] }));
    await expectAreaShell(/Thali for Restaurants, home/);
    expect(screen.queryByRole('heading', { name: guardHeadings })).not.toBeInTheDocument();
  });

  it('restaurant onboarding still needs sign-in', async () => {
    renderApp('/restaurant/onboarding', makeAuth());
    expect(await screen.findByRole('heading', { name: /sign in to continue/i }, slow)).toBeInTheDocument();
  });

  it('partner area: forbidden for consumers, open for partners, onboarding needs only a session', async () => {
    renderApp('/partner', makeAuth({ roles: ['CONSUMER'] }));
    expect(await screen.findByRole('heading', { name: /not a delivery partner yet/i }, slow)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Become a delivery partner' })).toHaveAttribute('href', '/partner/onboarding');
  });

  it('partner area renders for partners', async () => {
    renderApp('/partner', makeAuth({ roles: ['CONSUMER', 'DELIVERY_PARTNER'] }));
    await expectAreaShell(/Thali Partner, home/);
    expect(screen.queryByRole('heading', { name: guardHeadings })).not.toBeInTheDocument();
  });

  it('admin area: consumers are forbidden', async () => {
    renderApp('/admin', makeAuth({ roles: ['CONSUMER'] }));
    expect(await screen.findByRole('heading', { name: /you don.t have access/i }, slow)).toBeInTheDocument();
  });

  it('admin area: ADMIN without MFA is sent to verify at /admin/login', async () => {
    renderApp('/admin', makeAuth({ roles: ['CONSUMER', 'ADMIN'], hasMfa: false }));
    expect(await screen.findByRole('heading', { name: /verify to continue/i }, slow)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /verify/i })).toHaveAttribute('href', '/admin/login?next=%2Fadmin');
  });

  it('admin area: ADMIN with MFA passes the guard', async () => {
    renderApp('/admin', makeAuth({ roles: ['CONSUMER', 'ADMIN'], hasMfa: true, amr: ['pwd', 'mfa'] }));
    await expectAreaShell(/Thali Admin, home/);
    expect(screen.queryByRole('heading', { name: guardHeadings })).not.toBeInTheDocument();
  });

  it('/admin/login is public', async () => {
    renderApp('/admin/login', makeAuth());
    await expectAreaShell(/Thali Admin, home/);
    expect(screen.queryByRole('heading', { name: guardHeadings })).not.toBeInTheDocument();
  });

  it('/signin renders the OTP form', async () => {
    renderApp('/signin?next=%2Forders', makeAuth());
    expect(await screen.findByRole('heading', { name: 'Sign in to Thali' }, slow)).toBeInTheDocument();
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
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

describe('OtpSignInForm', SUITE, () => {
  it('normalizes the phone, shows the resend countdown and verifies the code', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn().mockResolvedValue({ resendAfterSec: 30, demo: true, raw: {} });
    const signInWithOtp = vi.fn().mockResolvedValue({ id: 'u1' });
    const onSuccess = vi.fn();
    renderWithProviders(<OtpSignInForm onSuccess={onSuccess} />, { auth: makeAuth({ requestOtp, signInWithOtp }) });

    await user.type(screen.getByLabelText(/mobile number/i), '098765 43210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(requestOtp).toHaveBeenCalledWith('+919876543210');
    expect(await screen.findByText(/sent a 6-digit code to \+91 98765 43210/i, {}, slow)).toBeInTheDocument();
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

  it('shows a generic "Incorrect code" on a wrong code', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn().mockResolvedValue({ resendAfterSec: 30, demo: false, raw: {} });
    const signInWithOtp = vi.fn().mockRejectedValue(new ApiError({ code: 'OTP_INVALID', status: 400, message: 'Invalid code' }));
    renderWithProviders(<OtpSignInForm />, { auth: makeAuth({ requestOtp, signInWithOtp }) });
    await user.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText(/6-digit code/i, {}, slow), '000000');
    expect(await screen.findByText(/incorrect code/i, {}, slow)).toBeInTheDocument();
    expect(screen.getByText(/resend code in/i)).toBeInTheDocument(); // cooldown still applies
  });

  it('asks for a new code and enables Resend after too many attempts', async () => {
    const user = userEvent.setup();
    const requestOtp = vi.fn().mockResolvedValue({ resendAfterSec: 30, demo: false, raw: {} });
    const signInWithOtp = vi.fn().mockRejectedValue(new ApiError({ code: 'OTP_ATTEMPTS_EXCEEDED', status: 429, message: 'Too many attempts' }));
    renderWithProviders(<OtpSignInForm />, { auth: makeAuth({ requestOtp, signInWithOtp }) });
    await user.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText(/6-digit code/i, {}, slow), '111111');
    expect(await screen.findByText(/too many incorrect attempts\. request a new code/i, {}, slow)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resend code' }));
    expect(requestOtp).toHaveBeenCalledTimes(2);
  });

  it('shows the cooldown when OTP requests are rate limited', async () => {
    const user = userEvent.setup();
    const requestOtp = vi
      .fn()
      .mockRejectedValue(new ApiError({ code: 'RATE_LIMITED', status: 429, message: 'Too many', retryAfterSec: 25 }));
    renderWithProviders(<OtpSignInForm />, { auth: makeAuth({ requestOtp }) });
    await user.type(screen.getByLabelText(/mobile number/i), '9876543210');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/wait 0:25 before requesting another code/i, {}, slow)).toBeInTheDocument();
  });
});
