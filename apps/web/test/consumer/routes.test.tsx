import '../setup';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRoutes } from '../../src/routes';
import { AuthContext } from '../../src/lib/auth';
import { __resetApiForTests } from '../../src/lib/api';
import { ToastProvider } from '../../src/components/ui/Toast';
import { LOCATION_STORAGE_KEY } from '../../src/features/consumer/location';
import { makeAuth, makeQueryClient } from '../utils';
import { mockApi } from './fetchMock';

vi.mock('../../src/components/ui/Map', () => ({ MapView: () => <div data-testid="map" /> }));

function renderApp(path: string, auth = makeAuth()) {
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

describe('consumer routes', () => {
  beforeEach(() => __resetApiForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('home without a location asks where to deliver', async () => {
    mockApi({});
    renderApp('/');
    expect(await screen.findByRole('heading', { name: /where should we deliver/i }, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose delivery location/i })).toBeInTheDocument();
  });

  it('home with a non-serviceable location shows the clear empty state', async () => {
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ lat: 19.07, lng: 72.87, label: 'Pinned location', source: 'pin' }));
    const m = mockApi({ 'GET /discovery/restaurants': { items: [], nextCursor: null, serviceable: false, serviceArea: null } });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: /we don.t deliver here yet/i }, { timeout: 8000 })).toBeInTheDocument();
    const url = new URL(m.callsTo('GET', '/discovery/restaurants')[0]!.url, 'http://x');
    expect(url.searchParams.get('lat')).toBe('19.07');
    expect(url.searchParams.get('lng')).toBe('72.87');
  });

  it('lazy pages render inside the area (cart, private pages ask to sign in)', async () => {
    mockApi({});
    renderApp('/cart');
    expect(await screen.findByRole('heading', { name: /your cart/i, level: 1 }, { timeout: 8000 })).toBeInTheDocument();
  });

  it('orders asks guests to sign in', async () => {
    mockApi({});
    renderApp('/orders');
    expect(await screen.findByRole('heading', { name: /sign in to continue/i }, { timeout: 8000 })).toBeInTheDocument();
  });
});
