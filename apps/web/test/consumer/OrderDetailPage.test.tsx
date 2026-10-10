import '../setup';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrderDetailPage from '../../src/features/consumer/OrderDetailPage';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { mockApi } from './fetchMock';
import { breakdown, checkoutView, childOrder } from './fixtures';

vi.mock('../../src/components/ui/Map', () => ({
  MapView: (p: { markers?: { id: string; kind: string }[] }) => <div data-testid="map">{p.markers?.map((m) => <span key={m.id}>marker:{m.kind}</span>)}</div>,
}));

const accepted = childOrder({ id: 'c1', restaurantName: 'Dosa Corner', status: 'OUT_FOR_DELIVERY', deliveryStatus: 'OUT_FOR_DELIVERY' });
const rejected = childOrder({
  id: 'c2',
  restaurantId: 'aaaaaaaaaaaaaaaaaaaaaaa2',
  restaurantName: 'Spice Route',
  status: 'REJECTED',
  refundStatus: 'REQUESTED',
  refundedPaise: 0,
  breakdown: breakdown({ itemsSubtotalPaise: 48000, totalPaise: 53696 }),
});

function render() {
  return renderWithProviders(<OrderDetailPage />, { route: '/orders/ck1', path: '/orders/:checkoutId', auth: makeAuth({ roles: ['CONSUMER'] }) });
}

describe('OrderDetailPage', () => {
  beforeEach(() => {
    __resetApiForTests();
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    __resetApiForTests();
  });

  it('rejected child shows the explanation, "Refund initiated ₹…" and adjusted totals', async () => {
    mockApi({
      'GET /orders/ck1': {
        ...checkoutView({ children: [accepted, rejected] }),
        explanations: [{ childOrderId: 'c2', kind: 'REJECTED', message: 'Spice Route declined your order (Out of stock). ₹536.96 refund initiated.', refundStatus: 'REQUESTED' }],
        adjustedTotals: { paidPaise: 81240, refundedPaise: 0, refundPendingPaise: 53696, netPaise: 27544 },
      },
      'GET /deliveries/tracking/c1': { childOrderId: 'c1', status: 'OUT_FOR_DELIVERY', partner: { firstName: 'Arjun', vehicleType: 'BIKE' }, location: { lat: 12.97, lng: 77.6 }, lastLocationAt: new Date().toISOString(), stale: false, simulated: true, estimatedMinutes: 9, estimateSource: 'DEMO_HAVERSINE' },
    });
    render();
    const card = await screen.findByRole('region', { name: /spice route/i });
    expect(within(card).getByText(/declined your order \(out of stock\)/i)).toBeInTheDocument();
    expect(within(card).getByText(/^refund initiated/i)).toHaveTextContent('Refund initiated ₹536.96');
    expect(within(card).queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    const totals = screen.getByRole('region', { name: /payment summary/i });
    expect(within(totals).getByText(/refund pending/i).parentElement).toHaveTextContent('₹536.96');
    expect(within(totals).getByText(/^net paid$/i).parentElement).toHaveTextContent('₹275.44');
    // the other child continues independently, delivered separately, with simulated tracking
    const dosa = screen.getByRole('region', { name: /dosa corner/i });
    expect(within(dosa).getByText(/delivered separately/i)).toBeInTheDocument();
    expect(await within(dosa).findByText(/simulated/i)).toBeInTheDocument();
    expect(await within(dosa).findByText('marker:partner')).toBeInTheDocument();
  });

  it('distinguishes "Refunded" (SUCCEEDED) and falls back to a local explanation without server explanations', async () => {
    mockApi({ 'GET /orders/ck1': checkoutView({ status: 'CANCELLED', children: [{ ...rejected, refundStatus: 'SUCCEEDED', refundedPaise: 53696 }] }) });
    render();
    const card = await screen.findByRole('region', { name: /spice route/i });
    expect(within(card).getByText(/spice route declined your order/i)).toBeInTheDocument();
    expect(within(card).getByText(/^refunded/i)).toHaveTextContent('Refunded ₹536.96');
    expect(within(card).queryByText(/refund initiated/i)).not.toBeInTheDocument();
  });

  it('warns when the partner location is older than 60 s', async () => {
    mockApi({
      'GET /orders/ck1': checkoutView({ children: [accepted] }),
      'GET /deliveries/tracking/c1': { childOrderId: 'c1', status: 'OUT_FOR_DELIVERY', partner: { firstName: 'Arjun', vehicleType: 'BIKE' }, location: { lat: 12.97, lng: 77.6 }, lastLocationAt: new Date(Date.now() - 95_000).toISOString(), stale: false, simulated: false, estimatedMinutes: 9, estimateSource: 'GOOGLE' },
    });
    render();
    expect(await screen.findByText(/location may be out of date/i)).toBeInTheDocument();
    expect(screen.getByText(/updated 1m ago|updated 95s ago|updated 1 min ago/i)).toBeInTheDocument();
  });

  it('offers cancel only while PLACED and calls the cancel endpoint', async () => {
    const placed = childOrder({ id: 'c3', status: 'PLACED' });
    const m = mockApi({ 'GET /orders/ck1': checkoutView({ status: 'PAID_PLACED', children: [placed] }), 'POST /orders/child/c3/cancel': { ok: true } });
    render();
    await userEvent.click(await screen.findByRole('button', { name: /cancel spice route order/i }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /yes, cancel/i }));
    expect(m.callsTo('POST', '/orders/child/c3/cancel')).toHaveLength(1);
  });
});
