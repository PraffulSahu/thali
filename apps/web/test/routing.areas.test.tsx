import './setup';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRouterConfig } from '../src/routes';
import { AuthContext, type AuthContextValue } from '../src/lib/auth';
import { ToastProvider } from '../src/components/ui/Toast';
import { makeAuth, makeQueryClient } from './utils';

/**
 * Mounts the REAL area route modules (features/<area>/routes.tsx) under the app router and checks that a
 * page renders in each area. Areas use both route-object `lazy` (restaurant, partner, admin) and
 * React.lazy elements (consumer); both must work.
 */
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

const slow = { timeout: 15_000 };
/** Per-test timeout above `slow` (the unit test kind defaults to 10 s). */
const SUITE = { timeout: 30_000 };

beforeEach(() => {
  // Pages fetch data; keep them offline (they must still render their headings / error states).
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
});

describe('area pages render under the app router', SUITE, () => {
  it('consumer (React.lazy element): /search', async () => {
    renderApp('/search', makeAuth());
    expect(await screen.findByRole('heading', { level: 1, name: 'Search' }, slow)).toBeInTheDocument();
  });

  it('restaurant (route lazy): /restaurant/onboarding', async () => {
    renderApp('/restaurant/onboarding', makeAuth({ roles: ['CONSUMER'] }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Register your restaurant' }, slow)).toBeInTheDocument();
  });

  it('partner (route lazy layout + child): /partner/earnings', async () => {
    renderApp('/partner/earnings', makeAuth({ roles: ['CONSUMER', 'DELIVERY_PARTNER'] }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Earnings' }, slow)).toBeInTheDocument();
  });

  it('admin (route lazy, public): /admin/login', async () => {
    renderApp('/admin/login', makeAuth());
    expect(await screen.findByRole('heading', { level: 1, name: 'Admin sign in' }, slow)).toBeInTheDocument();
  });

  it('admin (route lazy, guarded): /admin/audit', async () => {
    renderApp('/admin/audit', makeAuth({ roles: ['CONSUMER', 'ADMIN'], hasMfa: true, amr: ['pwd', 'mfa'] }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Audit log' }, slow)).toBeInTheDocument();
  });

  it('discovers a not-yet-loaded area after the consumer catch-all is active, and back again', async () => {
    const router = renderApp('/search', makeAuth({ roles: ['CONSUMER', 'DELIVERY_PARTNER'] }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Search' }, slow)).toBeInTheDocument();
    await act(() => router.navigate('/partner/earnings'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Earnings' }, slow)).toBeInTheDocument();
    await act(() => router.navigate('/admin/login'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Admin sign in' }, slow)).toBeInTheDocument();
    await act(() => router.navigate('/search'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Search' }, slow)).toBeInTheDocument();
  });

  it('unknown paths render the area NotFound inside the shell', async () => {
    renderApp('/restaurant/definitely/not/here', makeAuth({ roles: ['CONSUMER', 'RESTAURANT_OWNER'] }));
    expect(await screen.findByRole('heading', { name: /couldn.t find that page/i }, slow)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Thali for Restaurants, home/ })).toBeInTheDocument();
  });
});
