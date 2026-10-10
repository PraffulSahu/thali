import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CheckoutPage from '../../src/features/consumer/CheckoutPage';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { errorBody, mockApi } from './fetchMock';
import { address, checkoutView, preview, twoRestaurantCart } from './fixtures';

vi.mock('../../src/components/ui/Map', () => ({ MapView: () => <div data-testid="map" /> }));

const payment = { intentId: 'pi1', provider: 'mock', providerOrderId: 'order_mock_1', keyId: null, amountPaise: 81240, currency: 'INR', demoPayUrl: 'http://localhost:5173/demo-pay/pi1' };

function baseRoutes(extra: Record<string, unknown> = {}) {
  return {
    'GET /cart': twoRestaurantCart(),
    'GET /me/addresses': { items: [address] },
    'POST /cart/preview': preview(),
    'GET /coupons/available': { items: [] },
    'GET /memberships/me': { active: null, history: [] },
    ...extra,
  };
}

function render() {
  return renderWithProviders(<CheckoutPage />, { route: '/checkout', path: '/checkout', auth: makeAuth({ roles: ['CONSUMER'] }) });
}

describe('CheckoutPage', () => {
  beforeEach(() => {
    __resetApiForTests();
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('renders the per-restaurant breakdown and total from the server preview', async () => {
    const m = mockApi(baseRoutes());
    render();
    const spice = await screen.findByRole('region', { name: /spice route/i }, { timeout: 5000 });
    expect(within(spice).getByText(/delivered separately/i)).toBeInTheDocument();
    expect(within(spice).getByText(/^items$/i).parentElement).toHaveTextContent('₹480');
    expect(within(spice).getByText(/delivery fee/i).parentElement).toHaveTextContent('₹30');
    expect(within(spice).getByText(/restaurant total/i).parentElement).toHaveTextContent('₹565.30');
    expect(within(spice).getByText(/demo estimate/i)).toBeInTheDocument();
    const dosa = screen.getByRole('region', { name: /dosa corner/i });
    expect(within(dosa).getByText(/restaurant total/i).parentElement).toHaveTextContent('₹247.10');
    expect(screen.getByRole('button', { name: /pay ₹812\.40/i })).toBeEnabled();
    // preview was asked for the selected (default) saved address
    expect(m.callsTo('POST', '/cart/preview')[0]!.body).toMatchObject({ address: { line1: '12 MG Road', location: { lat: 12.97, lng: 77.59 } }, useMembership: false });
  });

  it('double-clicking Pay sends exactly one POST /checkouts; a retry after failure reuses the Idempotency-Key', async () => {
    let n = 0;
    const m = mockApi(
      baseRoutes({
        'POST /checkouts': async () => {
          n += 1;
          await new Promise((r) => setTimeout(r, 30));
          return n === 1 ? [503, errorBody('UPSTREAM_UNAVAILABLE', 'Try again')] : [201, { checkout: checkoutView({ status: 'AWAITING_PAYMENT' }), payment }];
        },
      }),
    );
    const { router } = render();
    const pay = await screen.findByRole('button', { name: /pay ₹812\.40/i });
    await userEvent.dblClick(pay);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t start payment/i));
    expect(m.callsTo('POST', '/checkouts')).toHaveLength(1);
    const firstKey = m.callsTo('POST', '/checkouts')[0]!.headers['idempotency-key'];
    expect(firstKey).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(m.callsTo('POST', '/checkouts')[0]!.body).toMatchObject({ expectedTotalPaise: 81240, useMembership: false });

    await userEvent.click(screen.getByRole('button', { name: /pay ₹812\.40/i }));
    await waitFor(() => expect(m.callsTo('POST', '/checkouts')).toHaveLength(2));
    expect(m.callsTo('POST', '/checkouts')[1]!.headers['idempotency-key']).toBe(firstKey);
    await waitFor(() => expect(router.state.location.pathname).toBe('/demo-pay/pi1'));
  });

  it('PRICE_CHANGED shows old vs new total and confirms with the new expected total', async () => {
    const changed = preview(83240);
    let n = 0;
    const m = mockApi(
      baseRoutes({
        'POST /checkouts': () => {
          n += 1;
          if (n === 1) {
            return [422, errorBody('PRICE_CHANGED', 'Prices changed since you last saw them; please review the new total', { expectedTotalPaise: 81240, pricing: changed.pricing, children: changed.children })];
          }
          return [201, { checkout: checkoutView({ status: 'AWAITING_PAYMENT' }), payment }];
        },
      }),
    );
    render();
    await userEvent.click(await screen.findByRole('button', { name: /pay ₹812\.40/i }));
    const dialog = await screen.findByRole('dialog', { name: /prices changed/i });
    expect(dialog).toHaveTextContent('₹812.40');
    expect(dialog).toHaveTextContent('₹832.40');
    expect(within(dialog).getByText(/dosa corner/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /pay ₹832\.40/i }));
    await waitFor(() => expect(m.callsTo('POST', '/checkouts')).toHaveLength(2));
    const [first, second] = m.callsTo('POST', '/checkouts');
    expect(second!.body).toMatchObject({ expectedTotalPaise: 83240 });
    expect(second!.headers['idempotency-key']).not.toBe(first!.headers['idempotency-key']);
  });

  it('lists cart problems with a link to fix the cart and blocks payment', async () => {
    const p = { ...preview(), canCheckout: false, problems: [{ code: 'ITEM_UNAVAILABLE', restaurantId: 'aaaaaaaaaaaaaaaaaaaaaaa2', itemId: 'i2', message: 'Masala Dosa is no longer available' }] };
    mockApi(baseRoutes({ 'POST /cart/preview': p }));
    render();
    expect(await screen.findByText(/masala dosa is no longer available/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /fix in cart/i })).toHaveAttribute('href', '/cart');
    expect(screen.getByRole('button', { name: /pay ₹812\.40/i })).toBeDisabled();
  });
});
