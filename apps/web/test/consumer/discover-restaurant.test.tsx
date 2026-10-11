import '../setup';
import './slow';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomePage from '../../src/features/consumer/HomePage';
import RestaurantPage from '../../src/features/consumer/RestaurantPage';
import SearchPage from '../../src/features/consumer/SearchPage';
import { CartDock } from '../../src/features/consumer/CartDock';
import { LOCATION_STORAGE_KEY } from '../../src/features/consumer/location';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { mockApi } from './fetchMock';
import { IDS, twoRestaurantCart } from './fixtures';

vi.mock('../../src/components/ui/Map', () => ({ MapView: () => <div data-testid="map" /> }));

const today = new Date();
const sixPm = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 30)).toISOString(); // 6:00 PM IST

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'r1', slug: 'spice-route', name: 'Spice Route', cuisines: ['biryani', 'mughlai'], locality: 'Indiranagar', imageUrl: null, isVeg: 'MIXED',
    open: true, closedReason: null, pausedUntil: null, acceptingOrders: true, closesAt: null, distanceKm: 2.1, deliveryFeePaise: 2900, etaMinutes: 32,
    etaSource: 'DEMO_HAVERSINE', rating: { average: 4.3, count: 126 }, priceBand: 2, isDemo: true, offer: null, ...over,
  };
}

const cuisines = { items: [{ id: 'c1', name: 'Biryani', slug: 'biryani', imageUrl: null, sortOrder: 0 }, { id: 'c2', name: 'Mughlai', slug: 'mughlai', imageUrl: null, sortOrder: 1 }] };

describe('Discover (board 10)', () => {
  beforeEach(() => {
    __resetApiForTests();
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ lat: 12.97, lng: 77.64, label: 'Home', source: 'pin' }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders counts, paused / closed state badges, offers, rating "New" and the EST. legend', async () => {
    mockApi({
      'GET /cuisines': cuisines,
      'GET /banners': { items: [] },
      'GET /discovery/restaurants': {
        items: [
          item({ offer: { label: '20% OFF', code: 'SPICE20' } }),
          item({ id: 'r2', slug: 'kettle', name: 'Kettle & Bun', open: false, closedReason: 'PAUSED', acceptingOrders: false, rating: null, isVeg: 'PURE_VEG' }),
          item({ id: 'r3', slug: 'tandoor', name: 'Tandoor Tales', open: false, closedReason: 'OUTSIDE_HOURS', nextOpenAt: sixPm }),
        ],
        nextCursor: null, serviceable: true, serviceArea: { id: 'a', name: 'Central', minOrderPaise: 0 },
        counts: { total: 6, open: 4 }, facets: { cuisines: [{ slug: 'biryani', count: 3 }] },
      },
    });
    renderWithProviders(<HomePage />);
    expect(await screen.findByText('4 open now · 6 restaurants deliver here')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Delivering to Home');
    expect(screen.getByText('20% OFF')).toBeInTheDocument();
    expect(screen.getByText('Not accepting orders')).toBeInTheDocument();
    expect(screen.getByText('Opens at 6:00 PM')).toBeInTheDocument();
    expect(screen.getAllByText('Closed now').length).toBe(2);
    expect(screen.getByText('Pure veg')).toBeInTheDocument();
    expect(screen.getByText(/times are demo estimates/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /spice route/i })).toHaveAttribute('href', '/restaurants/spice-route');
    expect(screen.getByRole('link', { name: /spice route/i })).toHaveTextContent('Biryani · Mughlai · ₹₹');
  });

  it('cuisine, veg and price filters refetch with the right query; empty state clears them', async () => {
    const m = mockApi({
      'GET /cuisines': cuisines,
      'GET /banners': { items: [] },
      'GET /discovery/restaurants': { items: [], nextCursor: null, serviceable: true, serviceArea: null, counts: { total: 0, open: 0 }, facets: { cuisines: [] } },
    });
    const { router } = renderWithProviders(<HomePage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Biryani' }));
    expect(await screen.findByText('No Biryani restaurants deliver to Home right now.')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /veg only/i })[0]!);
    await userEvent.click(screen.getAllByRole('button', { name: 'Price band ₹₹' })[0]!);
    await waitFor(() => {
      const url = new URL(m.callsTo('GET', '/discovery/restaurants').at(-1)!.url, 'http://x');
      expect(url.searchParams.get('cuisine')).toBe('biryani');
      expect(url.searchParams.get('veg')).toBe('true');
      expect(url.searchParams.get('priceBand')).toBe('2');
    });
    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('not serviceable shows "We don\'t deliver here yet" with Try another location', async () => {
    mockApi({ 'GET /cuisines': cuisines, 'GET /discovery/restaurants': { items: [], nextCursor: null, serviceable: false, serviceArea: null } });
    renderWithProviders(<HomePage />);
    expect(await screen.findByRole('heading', { name: /we don.t deliver here yet/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try another location/i })).toBeInTheDocument();
  });

  it('search lists restaurants with their matched dishes', async () => {
    mockApi({
      'GET /cuisines': cuisines,
      'GET /discovery/search': {
        serviceable: true,
        restaurants: [item({ matchedItems: [{ id: 'd1', name: 'Chicken Dum Biryani', pricePaise: 27900, isVeg: false, imageUrl: null }] })],
        items: [{ id: 'd1', name: 'Chicken Dum Biryani', pricePaise: 27900, isVeg: false, imageUrl: null, restaurantId: 'r1', restaurantName: 'Spice Route' }],
      },
    });
    renderWithProviders(<SearchPage />, { route: '/search?q=biry' });
    expect(await screen.findByText(/Chicken Dum Biryani · ₹279/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Results for “biry”');
  });
});

const groups = [
  { id: 'g1', name: 'Size', minSelect: 1, maxSelect: 1, options: [{ id: 'half', name: 'Half · serves 1', pricePaise: 0, isVeg: false, available: true }, { id: 'full', name: 'Full · serves 2', pricePaise: 15000, isVeg: false, available: true }] },
];
function menuItem(over: Record<string, unknown> = {}) {
  return { id: 'i1', restaurantId: IDS.R1, categoryId: 'cat1', name: 'Double ka Meetha', description: 'Bread pudding', pricePaise: 9900, isVeg: true, imageUrl: null, available: true, unavailableReason: null, stockLeft: null, featured: false, customizationGroups: [], tags: [], ...over };
}
function restaurantPage(over: Record<string, unknown> = {}, delivery: Record<string, unknown> | null = { deliverable: true, distanceKm: 2.1, deliveryFeePaise: 2900, etaMinutes: 32, etaSource: 'DEMO_HAVERSINE' }) {
  const biryani = menuItem({ id: 'i2', name: 'Hyderabadi Chicken Dum Biryani', isVeg: false, pricePaise: 24900, customizationGroups: groups, featured: true });
  return {
    restaurant: {
      id: IDS.R1, slug: 'spice-route', name: 'Spice Route', description: '', cuisines: ['biryani', 'mughlai'], imageUrl: null, logoUrl: null, address: null, locality: 'Indiranagar',
      location: null, hours: [], timezone: 'Asia/Kolkata', open: true, pausedUntil: null, acceptingOrders: true, closesAt: null, isVeg: 'MIXED', pureVeg: false, priceBand: 2,
      rating: { average: 4.3, count: 126 }, packagingFeePaise: 2000, avgPrepMinutes: 20, isDemo: false, ...over,
    },
    delivery,
    recommended: [biryani],
    menu: [
      { id: 'cat1', name: 'Biryani', sortOrder: 0, items: [biryani, menuItem({ id: 'i3', name: 'Paneer Tikka Biryani', available: false, unavailableReason: 'SOLD_OUT' })] },
      { id: 'cat2', name: 'Desserts', sortOrder: 1, items: [menuItem()] },
    ],
  };
}

describe('Restaurant page (board 11)', () => {
  beforeEach(() => {
    __resetApiForTests();
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ lat: 12.97, lng: 77.64, label: 'Home', source: 'pin' }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('hero, stat cards, Recommended (MKT-9), "from ₹249", sold out (MKT-6) and adding a simple dish', async () => {
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
    let added = false;
    const cart = twoRestaurantCart();
    const m = mockApi({
      'GET /cuisines': cuisines,
      'GET /restaurants/spice-route': restaurantPage(),
      'GET /cart': { ...twoRestaurantCart(), groups: [], restaurantCount: 0, itemCount: 0, subtotalPaise: 0 },
      'POST /cart/items': () => {
        added = true;
        return [201, { lineId: IDS.L1, cart }];
      },
    });
    renderWithProviders(<RestaurantPage />, { route: '/restaurants/spice-route', path: '/restaurants/:idOrSlug', auth: makeAuth({ roles: ['CONSUMER'] }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Spice Route' })).toBeInTheDocument();
    expect(screen.getByText('Biryani · Mughlai · Indiranagar · Open now')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /menu categories/i })).toHaveTextContent('Recommended1');
    expect(screen.getAllByText('from ₹249').length).toBeGreaterThan(0);
    expect(screen.getByText('Sold out today')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unavailable' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Add Double ka Meetha' }));
    await waitFor(() => expect(added).toBe(true));
    expect(m.callsTo('POST', '/cart/items')[0]!.body).toEqual({ restaurantId: IDS.R1, itemId: 'i1', quantity: 1, selections: [] });
  });

  it('customizable dish opens the customizer; CTA says "Choose a size" until a size is picked', async () => {
    mockApi({ 'GET /cuisines': cuisines, 'GET /restaurants/spice-route': restaurantPage() });
    renderWithProviders(<RestaurantPage />, { route: '/restaurants/spice-route', path: '/restaurants/:idOrSlug' });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Add Hyderabadi Chicken Dum Biryani' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /hyderabadi chicken dum biryani/i });
    expect(within(dialog).getByText('REQUIRED · PICK 1')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /choose a size/i })).toBeDisabled();
    expect(within(dialog).getByText('₹399')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: /full/i }));
    expect(within(dialog).getByText('DONE')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /add to cart, ₹399\.00/i })).toBeEnabled();
  });

  it('not deliverable: notice with Change location and every Add disabled', async () => {
    mockApi({ 'GET /cuisines': cuisines, 'GET /restaurants/spice-route': restaurantPage({}, { deliverable: false, reason: 'Too far', distanceKm: 12 }) });
    renderWithProviders(<RestaurantPage />, { route: '/restaurants/spice-route', path: '/restaurants/:idOrSlug' });
    expect(await screen.findByText(/spice route doesn.t deliver to home \(too far\)\. you can still browse\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change location/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Double ka Meetha' })).toBeDisabled();
  });

  it('paused restaurant shows "Temporarily not accepting orders"', async () => {
    mockApi({ 'GET /cuisines': cuisines, 'GET /restaurants/spice-route': restaurantPage({ open: false, closedReason: 'PAUSED', acceptingOrders: false }) });
    renderWithProviders(<RestaurantPage />, { route: '/restaurants/spice-route', path: '/restaurants/:idOrSlug' });
    expect(await screen.findByText(/Indiranagar · Temporarily not accepting orders/)).toBeInTheDocument();
  });
});

describe('Cart dock (10-33…10-41)', () => {
  beforeEach(() => {
    __resetApiForTests();
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('summary, chips open the tray on that cart, optimistic + and per-restaurant checkout', async () => {
    const cart = twoRestaurantCart();
    const after = twoRestaurantCart();
    after.groups[0]!.lines[0]!.quantity = 3;
    after.groups[0]!.lines[0]!.lineTotalPaise = 72000;
    after.groups[0]!.itemCount = 3;
    after.groups[0]!.subtotalPaise = 72000;
    after.itemCount = 5;
    after.subtotalPaise = 92000;
    const m = mockApi({ 'GET /cart': cart, [`PATCH /cart/items/${IDS.L1}`]: () => new Promise((r) => setTimeout(() => r(after), 50)) });
    const { router } = renderWithProviders(<CartDock />, { auth: makeAuth({ roles: ['CONSUMER'] }) });
    expect(await screen.findByText('2 carts · 4 items')).toBeInTheDocument();
    expect(screen.getByText('2 deliveries, one payment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /checkout · ₹680/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /dosa corner · ₹200/i }));
    const tray = await screen.findByRole('region', { name: /your carts/i });
    expect(within(tray).getByRole('button', { name: /^dosa corner/i, pressed: true })).toBeInTheDocument();
    await userEvent.click(within(tray).getByRole('button', { name: /^all/i }));
    await userEvent.click(within(tray).getByRole('button', { name: 'Add one Paneer Tikka' }));
    expect(await screen.findByText('2 carts · 5 items')).toBeInTheDocument(); // optimistic, then confirmed by the server cart
    expect(m.callsTo('PATCH', `/cart/items/${IDS.L1}`)[0]!.body).toEqual({ quantity: 3 });
    await userEvent.click(within(tray).getByRole('button', { name: /checkout only spice route/i }));
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(`/checkout?restaurant=${IDS.R1}`));
  });

  it('guests are asked to sign in before checkout', async () => {
    __resetApiForTests();
    localStorage.setItem('thali.guestCart', 'guest-1');
    mockApi({ 'GET /cart': { ...twoRestaurantCart(), ownerType: 'GUEST' } });
    renderWithProviders(<CartDock />);
    await userEvent.click(await screen.findByRole('button', { name: /checkout · ₹680/i }));
    expect(await screen.findByRole('dialog', { name: /sign in/i })).toBeInTheDocument();
    localStorage.clear();
  });
});
