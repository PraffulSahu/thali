import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CheckoutPage from '../../src/features/consumer/CheckoutPage';
import OrderDetailPage from '../../src/features/consumer/OrderDetailPage';
import OffersPage from '../../src/features/consumer/OffersPage';
import { ConsumerLayout } from '../../src/features/consumer/ConsumerLayout';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { errorBody, mockApi } from './fetchMock';
import { address, customerChild, IDS, orderDetail, preview, twoRestaurantCart } from './fixtures';

vi.mock('../../src/components/ui/Map', () => ({ MapView: () => <div data-testid="map" /> }));

const signIn = () => setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));

describe('Checkout extras (ORD-3)', () => {
  beforeEach(() => {
    __resetApiForTests();
    signIn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('?restaurant=<id> prices and pays only that restaurant (restaurantIds) and says so', async () => {
    const one = preview();
    const subset = { ...one, children: [one.children[0]!], pricing: one.children[0]!.breakdown };
    const m = mockApi({
      'GET /cart': twoRestaurantCart(),
      'GET /me/addresses': { items: [address] },
      'POST /cart/preview': subset,
      'GET /coupons/available': { items: [] },
      'GET /memberships/me': { current: null, history: [] },
      'POST /checkouts': [409, errorBody('CONFLICT', 'Already paid', { reason: 'CHECKOUT_ALREADY_PAID', checkoutId: 'ckPaid' })],
    });
    renderWithProviders(<CheckoutPage />, { route: `/checkout?restaurant=${IDS.R1}`, path: '/checkout', auth: makeAuth({ roles: ['CONSUMER'] }) });
    expect(await screen.findByRole('heading', { level: 1, name: /one kitchen, one payment/i })).toBeInTheDocument();
    expect(screen.getByText(/checking out only spice route/i)).toBeInTheDocument();
    await waitFor(() => expect(m.callsTo('POST', '/cart/preview')[0]?.body).toMatchObject({ restaurantIds: [IDS.R1] }));
    await userEvent.click(await screen.findByRole('button', { name: /pay ₹565\.30/i }));
    await waitFor(() => expect(m.callsTo('POST', '/checkouts')).toHaveLength(1));
    expect(m.callsTo('POST', '/checkouts')[0]!.body).toMatchObject({ restaurantIds: [IDS.R1], expectedTotalPaise: 56530 });
    expect(await screen.findByText(/you already paid for an order with these items/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /track that order/i })).toHaveAttribute('href', '/orders/ckPaid');
  });

  it('applies a coupon from "View offers" and shows the applied row with Remove', async () => {
    const withCoupon = { ...preview(), coupon: { code: 'WELCOME45', valid: true, discountPaise: 4500 } };
    const m = mockApi({
      'GET /cart': twoRestaurantCart(),
      'GET /me/addresses': { items: [address] },
      'POST /cart/preview': (c: { body: unknown }) => ((c.body as { couponCode?: string }).couponCode ? withCoupon : preview()),
      'PUT /cart/coupon': twoRestaurantCart(),
      'GET /coupons/available': { items: [{ code: 'WELCOME45', description: '₹45 off', offerHeadline: '₹45 off your order', eligibility: 'ELIGIBLE', restaurantIds: [] }] },
      'GET /memberships/me': { current: null, history: [] },
    });
    renderWithProviders(<CheckoutPage />, { route: '/checkout', path: '/checkout', auth: makeAuth({ roles: ['CONSUMER'] }) });
    await userEvent.click(await screen.findByRole('button', { name: /view offers/i }));
    const list = await screen.findByRole('list', { name: /available offers/i });
    await userEvent.click(within(list).getByRole('button', { name: /apply/i }));
    expect(await screen.findByText(/applied · −₹45\.00, split across both restaurants/i)).toBeInTheDocument();
    expect(m.callsTo('PUT', '/cart/coupon')[0]!.body).toEqual({ couponCode: 'WELCOME45' });
    expect(screen.getByRole('button', { name: /^remove$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get thali plus/i })).toHaveAttribute('href', '/membership');
  });
});

describe('Tracking extras', () => {
  beforeEach(() => {
    __resetApiForTests();
    signIn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('rates only delivered, unrated parts (MKT-14) and hints for the others; Get help links to a prefilled ticket', async () => {
    const delivered = customerChild({ id: 'c1', status: 'DELIVERED', deliveredAt: '2026-10-10T08:41:00.000Z' });
    const rated = customerChild({ id: 'c2', restaurantId: IDS.R2, restaurantName: 'Dosa Corner', status: 'DELIVERED' });
    const cooking = customerChild({ id: 'c3', restaurantId: 'r3', restaurantName: 'Green Leaf', status: 'PREPARING', prepMinutes: 15 });
    const m = mockApi({
      'GET /orders/ck1': orderDetail([delivered, rated, cooking]),
      'GET /restaurants/ratings/mine': { items: [{ childOrderId: 'c2', restaurantId: IDS.R2, stars: 4, createdAt: null }] },
      [`POST /restaurants/${IDS.R1}/ratings`]: [201, { id: 'rt1' }],
    });
    renderWithProviders(<OrderDetailPage />, { route: '/orders/ck1', path: '/orders/:checkoutId', auth: makeAuth({ roles: ['CONSUMER'] }) });
    expect(await screen.findByText('You rated Dosa Corner 4 ★', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(new URL(m.callsTo('GET', '/restaurants/ratings/mine')[0]!.url, 'http://x').searchParams.get('childOrderIds')).toBe('c1,c2');
    expect(screen.getByText(/you can rate green leaf once it.s delivered/i)).toBeInTheDocument();
    expect(screen.getByText(/delivered at 2:11 PM/i)).toBeInTheDocument();
    expect(screen.getByText(/being prepared/i)).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('group', { name: 'Rate Spice Route' })).getByRole('button', { name: 'Rate 5 of 5' }));
    expect(await screen.findByText('You rated Spice Route 5 ★', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(m.callsTo('POST', `/restaurants/${IDS.R1}/ratings`)[0]!.body).toEqual({ childOrderId: 'c1', stars: 5 });
    expect(screen.getByRole('link', { name: /get help/i })).toHaveAttribute('href', '/support?new=1&orderId=ck1');
  });

  it('rider at the restaurant (ORD-5 AT_PICKUP) shows the rider row and the delivery code', async () => {
    const atPickup = customerChild({ id: 'c1', status: 'READY_FOR_PICKUP', deliveryStatus: 'AT_PICKUP', partner: { name: 'Ravi', vehicleType: 'SCOOTER' } });
    mockApi({
      'GET /orders/ck1': orderDetail([atPickup]),
      'GET /deliveries/tracking/c1': { childOrderId: 'c1', status: 'AT_PICKUP', partner: { firstName: 'Ravi', vehicleType: 'SCOOTER' }, location: null, lastLocationAt: null, stale: false, simulated: true, estimatedMinutes: 20, estimateSource: 'DEMO_HAVERSINE', remaining: null },
    });
    renderWithProviders(<OrderDetailPage />, { route: '/orders/ck1', path: '/orders/:checkoutId', auth: makeAuth({ roles: ['CONSUMER'] }) });
    expect(await screen.findByText('Ready — waiting for pickup')).toBeInTheDocument();
    expect(screen.getByText('At restaurant')).toBeInTheDocument();
    expect(await screen.findByText('Ravi · Scooter')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Delivery code 4 8 2 1' })).toBeInTheDocument();
    expect(screen.getByText(/tell ravi at the door/i)).toBeInTheDocument();
  });
});

describe('Offers (MKT-7) and consumer chrome', () => {
  beforeEach(() => __resetApiForTests());
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('guests see every live coupon without sending a token, marked "Sign in to check"', async () => {
    const m = mockApi({
      'GET /coupons/available': { items: [{ code: 'FEAST50', description: 'Weekend feast', offerHeadline: '50% off up to ₹100', eligibility: 'SIGN_IN_TO_CHECK', minOrderPaise: 29900, restaurantIds: ['r1', 'r2'], badgeLabel: '50% OFF', firstOrderOnly: false, remainingUses: null }] },
    });
    renderWithProviders(<OffersPage />, { route: '/offers' });
    expect(await screen.findByRole('heading', { name: '50% off up to ₹100' })).toBeInTheDocument();
    expect(screen.getByText(/min order ₹299 · at 2 restaurants/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in to check/i })).toBeInTheDocument();
    expect(m.callsTo('GET', '/coupons/available')[0]!.headers.authorization).toBeUndefined();
  });

  it('header: bell announces the unread count; account menu has Addresses, Thali Plus and Support', async () => {
    signIn();
    localStorage.setItem('thali.location', JSON.stringify({ lat: 12.97, lng: 77.64, label: 'Home', source: 'address', address: '12th Main, Indiranagar' }));
    mockApi({ 'GET /notifications': { items: [], nextCursor: null, unreadCount: 3 }, 'GET /cart': twoRestaurantCart() });
    renderWithProviders(<ConsumerLayout variant="discover" />, { auth: makeAuth({ roles: ['CONSUMER'] }) });
    expect(await screen.findByRole('link', { name: 'Notifications, 3 unread' })).toHaveAttribute('href', '/notifications');
    expect(screen.getByRole('button', { name: 'Delivery location: Home, 12th Main, Indiranagar. Change' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /account menu/i }));
    for (const name of ['Addresses', 'Thali Plus', 'Support']) expect(screen.getByRole('link', { name })).toBeInTheDocument();
    localStorage.clear();
  });
});
