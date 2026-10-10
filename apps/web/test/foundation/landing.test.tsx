import '../setup';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LandingPage from '../../src/features/public/LandingPage';
import { AuthContext } from '../../src/lib/auth';
import { __resetApiForTests } from '../../src/lib/api';
import { LOCATION_STORAGE_KEY } from '../../src/lib/location';
import { ToastProvider } from '../../src/components/ui/Toast';
import { makeAuth, makeQueryClient } from '../utils';

type Handler = (url: URL) => { status?: number; body: unknown } | undefined;

function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const res = handler(url) ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nope' } } };
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const SUGGESTIONS = {
  items: [
    { id: 'p1', primary: '12th Main Rd', secondary: 'Indiranagar, Bengaluru', locality: 'Indiranagar', city: 'Bengaluru', pincode: '560038', location: { lat: 12.97, lng: 77.64 }, source: 'DEMO_GAZETTEER' },
    { id: 'p2', primary: 'Indiranagar Metro', secondary: 'Indiranagar, Bengaluru', locality: 'Indiranagar', city: 'Bengaluru', pincode: null, location: null, source: 'DEMO_GAZETTEER' },
  ],
  source: 'DEMO_GAZETTEER',
};

function placeDetails(id: string, serviceable = true) {
  return {
    id,
    formattedAddress: '12th Main Rd, Indiranagar, Bengaluru 560038',
    locality: 'Indiranagar',
    city: 'Bengaluru',
    pincode: '560038',
    location: { lat: 12.9716, lng: 77.6412 },
    serviceable,
    serviceArea: serviceable ? { id: 'sa1', name: 'Bengaluru', minOrderPaise: 0 } : null,
    source: 'DEMO_GAZETTEER',
  };
}

function renderLanding(path = '/welcome') {
  const router = createMemoryRouter(
    [
      { path: '/welcome', element: <LandingPage /> },
      { path: '/', element: <p>DISCOVER</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <AuthContext.Provider value={makeAuth()}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return router;
}

const slow = { timeout: 4000 };

beforeEach(() => {
  localStorage.clear();
  __resetApiForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe('landing address autocomplete', () => {
  it('debounces the places search (one request for a burst of typing)', async () => {
    const user = userEvent.setup();
    const fetchFn = mockFetch((u) => (u.pathname === '/api/v1/discovery/places' ? { body: SUGGESTIONS } : undefined));
    renderLanding();
    const input = screen.getByRole('combobox', { name: /delivery address/i });
    await user.type(input, 'indi');
    const placeCalls = () => fetchFn.mock.calls.filter(([u]) => String(u).includes('/discovery/places'));
    expect(placeCalls()).toHaveLength(0);
    expect(await screen.findByRole('option', { name: /12th Main Rd/ }, slow)).toBeInTheDocument();
    expect(placeCalls()).toHaveLength(1);
    expect(String(placeCalls()[0]![0])).toContain('q=indi');
  });

  it('keyboard: ArrowDown highlights, Enter selects → place details → stores the location → discover', async () => {
    const user = userEvent.setup();
    mockFetch((u) => {
      if (u.pathname === '/api/v1/discovery/places') return { body: SUGGESTIONS };
      if (u.pathname === '/api/v1/discovery/places/p1') return { body: placeDetails('p1') };
      return undefined;
    });
    const router = renderLanding();
    const input = screen.getByRole('combobox', { name: /delivery address/i });
    await user.type(input, '12th');
    const listbox = await screen.findByRole('listbox', {}, slow);
    expect(await within(listbox).findAllByRole('option', {}, slow)).toHaveLength(2);
    await user.keyboard('{ArrowDown}');
    const first = within(listbox).getAllByRole('option')[0]!;
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'), slow);
    const stored = JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY)!);
    expect(stored).toMatchObject({ lat: 12.9716, lng: 77.6412, label: '12th Main Rd', source: 'address', placeId: 'p1' });
  });

  it('Escape closes the listbox', async () => {
    const user = userEvent.setup();
    mockFetch((u) => (u.pathname === '/api/v1/discovery/places' ? { body: SUGGESTIONS } : undefined));
    renderLanding();
    await user.type(screen.getByRole('combobox', { name: /delivery address/i }), 'indi');
    await screen.findByRole('listbox', {}, slow);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /delivery address/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows "We don\'t deliver here yet" and keeps no location when the place is not serviceable', async () => {
    const user = userEvent.setup();
    mockFetch((u) => {
      if (u.pathname === '/api/v1/discovery/places') return { body: SUGGESTIONS };
      if (u.pathname === '/api/v1/discovery/places/p1') return { body: placeDetails('p1', false) };
      return undefined;
    });
    const router = renderLanding();
    await user.type(screen.getByRole('combobox', { name: /delivery address/i }), '12th');
    await user.click(await screen.findByRole('option', { name: /12th Main Rd/ }, slow));
    expect(await screen.findByText(/we don.t deliver here yet/i, {}, slow)).toBeInTheDocument();
    expect(localStorage.getItem(LOCATION_STORAGE_KEY)).toBeNull();
    expect(router.state.location.pathname).toBe('/welcome');
  });

  it('"Use my location" → geolocation → reverse → stores and goes to discover', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('navigator', {
      ...navigator,
      geolocation: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: 12.97, longitude: 77.64, accuracy: 20 }, timestamp: Date.now() } as GeolocationPosition),
      },
    });
    const fetchFn = mockFetch((u) =>
      u.pathname === '/api/v1/discovery/reverse'
        ? { body: { label: '12th Main Rd, Indiranagar', locality: 'Indiranagar', city: 'Bengaluru', pincode: null, serviceable: true, serviceArea: null, source: 'DEMO_GAZETTEER' } }
        : undefined,
    );
    const router = renderLanding();
    await user.click(screen.getByRole('button', { name: /use my location/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'), slow);
    const reverse = fetchFn.mock.calls.find(([u]) => String(u).includes('/discovery/reverse'))!;
    expect(String(reverse[0])).toMatch(/lat=12\.97/);
    expect(JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY)!)).toMatchObject({ lat: 12.97, lng: 77.64, source: 'gps', label: '12th Main Rd' });
  });

  it('"Use my location" not serviceable → inline message, nothing stored', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('navigator', {
      ...navigator,
      geolocation: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: 19.07, longitude: 72.87, accuracy: 20 }, timestamp: Date.now() } as GeolocationPosition),
      },
    });
    mockFetch((u) =>
      u.pathname === '/api/v1/discovery/reverse'
        ? { body: { label: 'Bandra West', locality: 'Bandra', city: 'Mumbai', pincode: null, serviceable: false, serviceArea: null, source: 'GOOGLE' } }
        : undefined,
    );
    renderLanding();
    await user.click(screen.getByRole('button', { name: /use my location/i }));
    expect(await screen.findByText(/we don.t deliver here yet/i, {}, slow)).toBeInTheDocument();
    expect(localStorage.getItem(LOCATION_STORAGE_KEY)).toBeNull();
  });

  it('cuisine circles link to discover with ?cuisine=', async () => {
    mockFetch(() => undefined);
    renderLanding();
    expect(screen.getByRole('link', { name: 'Biryani' })).toHaveAttribute('href', '/?cuisine=biryani');
    expect(screen.getByRole('link', { name: 'Chai & Snacks' })).toHaveAttribute('href', '/?cuisine=chai-snacks');
  });

  it('role doors link to sign-in with the right role tab', () => {
    mockFetch(() => undefined);
    renderLanding();
    expect(screen.getByRole('link', { name: /restaurant sign in/i })).toHaveAttribute('href', '/signin?role=restaurant');
    expect(screen.getByRole('link', { name: /partner sign in/i })).toHaveAttribute('href', '/signin?role=partner');
    expect(screen.getByRole('link', { name: /admin sign in/i })).toHaveAttribute('href', '/signin?role=admin');
  });
});
