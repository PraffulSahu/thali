import '../setup';
import './slow';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrderDetailPage from '../../src/features/consumer/OrderDetailPage';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { mockApi } from './fetchMock';
import { breakdown, customerChild, orderDetail } from './fixtures';

vi.mock('../../src/components/ui/Map', () => ({
  MapView: (p: { markers?: { id: string; kind: string }[] }) => <div data-testid="map">{p.markers?.map((m) => <span key={m.id}>marker:{m.kind}</span>)}</div>,
}));

const accepted = customerChild({ id: 'c1', restaurantName: 'Dosa Corner', status: 'OUT_FOR_DELIVERY', deliveryStatus: 'OUT_FOR_DELIVERY' });
const rejected = customerChild({
  id: 'c2',
  restaurantId: 'aaaaaaaaaaaaaaaaaaaaaaa2',
  restaurantName: 'Spice Route',
  status: 'REJECTED',
  refundStatus: 'REQUESTED',
  refundedPaise: 0,
  refundRequestedPaise: 53696,
  rejectionReason: 'Out of stock',
  breakdown: breakdown({ itemsSubtotalPaise: 48000, totalPaise: 53696 }),
});
const rejectedExplanation = {
  childOrderId: 'c2',
  restaurantName: 'Spice Route',
  kind: 'REJECTED',
  reason: 'Out of stock',
  refundPaise: 53696,
  refundStatus: 'REQUESTED',
  message: 'Spice Route declined your order (Out of stock). ₹536.96 refund initiated.',
};

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
      'GET /orders/ck1': orderDetail([accepted, rejected], [rejectedExplanation]),
      'GET /deliveries/tracking/c1': { childOrderId: 'c1', status: 'OUT_FOR_DELIVERY', partner: { firstName: 'Arjun', vehicleType: 'BIKE' }, location: { lat: 12.97, lng: 77.6 }, lastLocationAt: new Date().toISOString(), stale: false, simulated: true, estimatedMinutes: 30, estimateSource: 'DEMO_HAVERSINE', remaining: { minutes: 9, distanceKm: 1.8, source: 'DEMO_HAVERSINE', computedAt: new Date().toISOString() } },
    });
    render();
    const card = await screen.findByRole('article', { name: /spice route/i });
    expect(within(card).getByText(/declined your order \(out of stock\)/i)).toBeInTheDocument();
    expect(within(card).getByText(/^refund ₹536\.96$/i)).toBeInTheDocument();
    expect(within(card).getByRole('list', { name: /refund ₹536\.96/i })).toHaveTextContent(/processing \(current\)/i);
    expect(within(card).getByText(/your dosa corner order isn.t affected/i)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    const totals = screen.getByRole('region', { name: /^payment$/i });
    expect(within(totals).getByText(/refund pending/i).parentElement).toHaveTextContent('₹536.96');
    // server netPaise = paid − refunded (pending excluded); the UI also shows the net after the pending refund
    expect(within(totals).getByText(/^net paid$/i).parentElement).toHaveTextContent('₹812.40');
    expect(within(totals).getByText(/net after pending refund/i).parentElement).toHaveTextContent('₹275.44');
    // the other child continues independently, delivered separately, with simulated tracking
    const dosa = screen.getByRole('article', { name: /dosa corner/i });
    // DLV-3 remaining ETA wins over the static child estimate (32 min)
    await waitFor(() => expect(within(dosa).getByText(/on the way/i, { selector: 'p' })).toHaveTextContent('On the way — about 9 min'));
    expect(within(dosa).getByText('Arrival time is a demo estimate')).toBeInTheDocument();
    expect(within(dosa).getByRole('group', { name: 'Delivery code 4 8 2 1' })).toBeInTheDocument();
    expect(await within(dosa).findByText(/simulated/i)).toBeInTheDocument();
    expect(await within(dosa).findByText('marker:partner')).toBeInTheDocument();
  });

  it('distinguishes "Refunded" (SUCCEEDED) from "Refund initiated"', async () => {
    const refunded = { ...rejected, refundStatus: 'SUCCEEDED', refundedPaise: 53696 };
    mockApi({
      'GET /orders/ck1': orderDetail([refunded], [{ ...rejectedExplanation, refundStatus: 'SUCCEEDED', message: 'Spice Route declined your order (Out of stock). ₹536.96 refunded.' }], { status: 'CANCELLED' }),
    });
    render();
    const card = await screen.findByRole('article', { name: /spice route/i });
    expect(within(card).getByText(/spice route declined your order/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /^payment$/i })).toHaveTextContent('Refunded');
    expect(within(card).getByRole('list', { name: /refund ₹536\.96/i })).toHaveTextContent(/refunded \(done\)/i);
  });

  it('warns when the partner location is older than 60 s', async () => {
    mockApi({
      'GET /orders/ck1': orderDetail([accepted]),
      'GET /deliveries/tracking/c1': { childOrderId: 'c1', status: 'OUT_FOR_DELIVERY', partner: { firstName: 'Arjun', vehicleType: 'BIKE' }, location: { lat: 12.97, lng: 77.6 }, lastLocationAt: new Date(Date.now() - 95_000).toISOString(), stale: false, simulated: false, estimatedMinutes: 9, estimateSource: 'GOOGLE' },
    });
    render();
    expect(await screen.findByText(/location may be out of date/i)).toBeInTheDocument();
    expect(screen.getByText(/updated 1m ago|updated 95s ago|updated 1 min ago/i)).toBeInTheDocument();
  });

  it('offers cancel only when the server says canCancel and calls the cancel endpoint', async () => {
    const placed = customerChild({ id: 'c3', status: 'PLACED', canCancel: true });
    const blocked = customerChild({ id: 'c4', restaurantId: 'aaaaaaaaaaaaaaaaaaaaaaa2', restaurantName: 'Dosa Corner', status: 'PLACED', canCancel: false });
    const m = mockApi({ 'GET /orders/ck1': orderDetail([placed, blocked], [], { status: 'PAID_PLACED' }), 'POST /orders/child/c3/cancel': customerChild({ id: 'c3', status: 'CANCELLED' }) });
    render();
    await userEvent.click(await screen.findByRole('button', { name: /cancel spice route order/i }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /yes, cancel/i }));
    expect(m.callsTo('POST', '/orders/child/c3/cancel')).toHaveLength(1);
    expect(m.callsTo('POST', '/orders/child/c3/cancel')[0]!.body).toEqual({});
    expect(screen.queryByRole('button', { name: /cancel dosa corner order/i })).not.toBeInTheDocument();
  });

  it('reorder reports server changes with the added count', async () => {
    const m = mockApi({
      'GET /orders/ck1': orderDetail([accepted]),
      'POST /orders/ck1/reorder': {
        cart: {},
        addedCount: 1,
        changes: [{ kind: 'PRICE_CHANGED', restaurantId: 'r', restaurantName: 'Dosa Corner', itemId: 'i2', name: 'Masala Dosa', quantity: 1, added: true, oldUnitPricePaise: 12000, newUnitPricePaise: 13000, message: 'Masala Dosa now costs ₹130.00 (was ₹120.00).' }],
      },
    });
    render();
    await userEvent.click(await screen.findByRole('button', { name: /reorder/i }));
    const dialog = await screen.findByRole('dialog', { name: /some things changed/i });
    expect(dialog).toHaveTextContent('1 item added to your cart');
    expect(dialog).toHaveTextContent('Masala Dosa now costs ₹130.00 (was ₹120.00).');
    expect(m.callsTo('POST', '/orders/ck1/reorder')).toHaveLength(1);
  });
});
