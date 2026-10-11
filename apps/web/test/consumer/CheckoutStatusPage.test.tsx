import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CheckoutStatusPage from '../../src/features/consumer/CheckoutStatusPage';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { mockApi } from './fetchMock';
import { checkoutView, childOrder } from './fixtures';

const payment = { intentId: 'pi1', provider: 'mock', providerOrderId: 'order_mock_1', keyId: null, amountPaise: 81240, currency: 'INR', demoPayUrl: 'http://x/demo-pay/pi1' };
const awaiting = (over: Record<string, unknown> = {}) =>
  checkoutView({ status: 'AWAITING_PAYMENT', paymentStatus: 'CREATED', placedAt: null, expiresAt: new Date(Date.now() + 600_000).toISOString(), children: [childOrder({ status: 'AWAITING_PAYMENT' })], ...over });

function render() {
  return renderWithProviders(<CheckoutStatusPage />, { route: '/checkout/status/ck1', path: '/checkout/status/:checkoutId', auth: makeAuth({ roles: ['CONSUMER'] }) });
}

describe('CheckoutStatusPage', () => {
  beforeEach(() => {
    __resetApiForTests();
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('shows "Confirming payment…" and waits (polling) until the server reports the order placed', async () => {
    let n = 0;
    mockApi({
      'GET /checkouts/ck1': () => {
        n += 1;
        return n < 2 ? { checkout: awaiting(), payment } : { checkout: checkoutView({ status: 'PAID_PLACED', children: [childOrder({ status: 'PLACED' })] }), payment };
      },
    });
    render();
    expect(await screen.findByText(/confirming your payment/i)).toBeInTheDocument();
    expect(screen.queryByText(/order placed/i)).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /order placed/i }, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /track order/i })).toHaveAttribute('href', '/orders/ck1');
    expect(n).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it('a failed attempt (still AWAITING_PAYMENT) offers "Try again" on the same intent', async () => {
    mockApi({ 'GET /checkouts/ck1': { checkout: awaiting({ paymentStatus: 'FAILED' }), payment } });
    const { router } = render();
    expect(await screen.findByText(/payment failed — try again/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try payment again/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/demo-pay/pi1'));
    expect(router.state.location.search).toContain(encodeURIComponent('/checkout/status/ck1'));
  });

  it('EXPIRED is terminal: cart is kept, no pay button', async () => {
    mockApi({ 'GET /checkouts/ck1': { checkout: awaiting({ status: 'EXPIRED' }), payment } });
    render();
    expect(await screen.findByRole('heading', { name: /this checkout expired/i })).toBeInTheDocument();
    expect(screen.getByText(/your cart is still saved/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to cart/i })).toHaveAttribute('href', '/cart');
    expect(screen.queryByRole('button', { name: /pay|try again/i })).not.toBeInTheDocument();
  });

  it('CANCELLED after payment uses neutral copy, not "Order placed"', async () => {
    mockApi({ 'GET /checkouts/ck1': { checkout: checkoutView({ status: 'CANCELLED', children: [childOrder({ status: 'REJECTED', refundStatus: 'REQUESTED' })] }), payment } });
    render();
    expect(await screen.findByRole('heading', { name: /this order was cancelled/i })).toBeInTheDocument();
    expect(screen.queryByText(/order placed/i)).not.toBeInTheDocument();
  });
});
