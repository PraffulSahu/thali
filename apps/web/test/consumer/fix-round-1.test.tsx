import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CheckoutPage from '../../src/features/consumer/CheckoutPage';
import { CartButton } from '../../src/features/consumer/ConsumerLayout';
import { childRefundAmount } from '../../src/features/consumer/OrderDetailPage';
import type { ChildOrder } from '../../src/features/consumer/api';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { GUEST_CART_STORAGE_KEY } from '../../src/lib/guest';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { errorBody, mockApi } from './fetchMock';
import { address, checkoutView, customerChild, preview, twoRestaurantCart } from './fixtures';

vi.mock('../../src/components/ui/Map', () => ({ MapView: () => <div data-testid="map" /> }));

const signIn = () => setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));

describe('Fix round 1', () => {
  beforeEach(() => __resetApiForTests());
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
    localStorage.clear();
  });

  it('guest: "Proceed to checkout" in the header cart drawer opens the sign-in dialog (drawer closing must not unmount it)', async () => {
    localStorage.setItem(GUEST_CART_STORAGE_KEY, 'guest-token-abc');
    mockApi({ 'GET /cart': { ...twoRestaurantCart(), ownerType: 'GUEST' } });
    renderWithProviders(<CartButton always />);
    await userEvent.click(await screen.findByRole('button', { name: /cart, 4 items/i }, { timeout: 4000 }));
    const drawer = await screen.findByRole('dialog', { name: /your cart/i });
    await userEvent.click(within(drawer).getByRole('button', { name: /proceed to checkout/i }));
    expect(await screen.findByRole('dialog', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /your cart/i })).not.toBeInTheDocument();
  });

  it('signed in: "Checkout only …" in the drawer goes straight to the per-restaurant checkout', async () => {
    signIn();
    mockApi({ 'GET /cart': twoRestaurantCart() });
    const { router } = renderWithProviders(<CartButton always />, { auth: makeAuth({ roles: ['CONSUMER'] }) });
    await userEvent.click(await screen.findByRole('button', { name: /cart, 4 items/i }, { timeout: 4000 }));
    const drawer = await screen.findByRole('dialog', { name: /your cart/i });
    await userEvent.click(within(drawer).getByRole('button', { name: /checkout only dosa corner/i }));
    await waitFor(() => expect(router.state.location.search).toBe('?restaurant=aaaaaaaaaaaaaaaaaaaaaaa2'));
  });

  function checkoutRoutes(extra: Record<string, unknown> = {}) {
    return {
      'GET /cart': twoRestaurantCart(),
      'GET /me/addresses': { items: [address] },
      'POST /cart/preview': preview(),
      'GET /coupons/available': { items: [] },
      'GET /memberships/me': { current: null, history: [] },
      ...extra,
    };
  }

  it('a stale ?restaurant= (not in the cart) says so and checks out the whole cart', async () => {
    signIn();
    const m = mockApi(checkoutRoutes());
    renderWithProviders(<CheckoutPage />, { route: '/checkout?restaurant=ffffffffffffffffffffffff', path: '/checkout', auth: makeAuth({ roles: ['CONSUMER'] }) });
    expect(await screen.findByText(/that restaurant isn.t in your cart — showing the whole cart/i, undefined, { timeout: 4000 })).toBeInTheDocument();
    await waitFor(() => expect(m.callsTo('POST', '/cart/preview').length).toBeGreaterThan(0));
    expect(m.callsTo('POST', '/cart/preview')[0]!.body).not.toHaveProperty('restaurantIds');
  });

  it('409 CART_CHANGED: warns, refetches cart + preview, and the next Pay uses a fresh Idempotency-Key', async () => {
    signIn();
    let n = 0;
    const payment = { intentId: 'pi1', provider: 'mock', providerOrderId: 'o1', keyId: null, amountPaise: 81240, currency: 'INR', demoPayUrl: null };
    const m = mockApi(
      checkoutRoutes({
        'POST /checkouts': () => {
          n += 1;
          return n === 1 ? [409, errorBody('CONFLICT', 'Your cart changed', { reason: 'CART_CHANGED' })] : [201, { checkout: checkoutView({ status: 'AWAITING_PAYMENT' }), payment }];
        },
      }),
    );
    const { router } = renderWithProviders(<CheckoutPage />, { route: '/checkout', path: '/checkout', auth: makeAuth({ roles: ['CONSUMER'] }) });
    await userEvent.click(await screen.findByRole('button', { name: /pay ₹812\.40/i }, { timeout: 4000 }));
    expect(await screen.findByText(/your cart changed while checking out/i)).toBeInTheDocument();
    const cartCalls = m.callsTo('GET', '/cart').length;
    const previewCalls = m.callsTo('POST', '/cart/preview').length;
    expect(cartCalls).toBeGreaterThanOrEqual(2);
    expect(previewCalls).toBeGreaterThanOrEqual(2);
    await userEvent.click(await screen.findByRole('button', { name: /pay ₹812\.40/i }));
    await waitFor(() => expect(m.callsTo('POST', '/checkouts')).toHaveLength(2));
    const [first, second] = m.callsTo('POST', '/checkouts');
    expect(second!.headers['idempotency-key']).not.toBe(first!.headers['idempotency-key']);
    await waitFor(() => expect(router.state.location.pathname).toBe('/demo-pay/pi1'));
  });

  it('childRefundAmount: remaining during a partial refund, total once refunded', () => {
    const base = customerChild({ refundRequestedPaise: 50000 }) as unknown as ChildOrder;
    expect(childRefundAmount({ ...base, refundStatus: 'PROCESSING', refundedPaise: 20000 })).toBe(30000);
    expect(childRefundAmount({ ...base, refundStatus: 'REQUESTED', refundedPaise: 0 })).toBe(50000);
    expect(childRefundAmount({ ...base, refundStatus: 'SUCCEEDED', refundedPaise: 50000 })).toBe(50000);
  });
});
