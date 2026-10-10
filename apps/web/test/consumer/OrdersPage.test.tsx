import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrdersPage from '../../src/features/consumer/OrdersPage';
import { __resetApiForTests, setAccessToken } from '../../src/lib/api';
import { makeAuth, makeJwt, renderWithProviders } from '../utils';
import { mockApi } from './fetchMock';

/** Exactly `orderSummary()` from services/orders/src/domain/order-views.ts. */
const summary = {
  id: 'ck1',
  code: 'TH-GROUP001',
  status: 'IN_PROGRESS',
  createdAt: '2026-10-10T07:58:00.000Z',
  placedAt: '2026-10-10T08:00:00.000Z',
  totalPaise: 81240,
  adjustedTotals: { paidPaise: 81240, refundedPaise: 0, refundPendingPaise: 53696, netPaise: 81240 },
  children: [
    { id: 'c1', code: 'TH-AAAA1111', restaurantId: 'r1', restaurantName: 'Dosa Corner', status: 'ACCEPTED', itemCount: 2, totalPaise: 27544, refundStatus: 'NONE' },
    { id: 'c2', code: 'TH-BBBB2222', restaurantId: 'r2', restaurantName: 'Spice Route', status: 'REJECTED', itemCount: 2, totalPaise: 53696, refundStatus: 'REQUESTED' },
  ],
};

describe('OrdersPage', () => {
  beforeEach(() => {
    __resetApiForTests();
    setAccessToken(makeJwt({ sub: 'u1', roles: ['CONSUMER'], exp: Math.floor(Date.now() / 1000) + 600 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetApiForTests();
  });

  it('renders the real order summary shape (total, per-restaurant parts, refund state)', async () => {
    mockApi({ 'GET /orders': { items: [summary], nextCursor: null } });
    renderWithProviders(<OrdersPage />, { route: '/orders', path: '/orders', auth: makeAuth({ roles: ['CONSUMER'] }) });
    const row = (await screen.findByRole('link', { name: 'Order TH-GROUP001' })).closest('li')!;
    expect(row).toHaveTextContent('₹812.40');
    expect(row).toHaveTextContent('₹536.96 refund pending');
    expect(within(row).getByText(/dosa corner/i)).toHaveTextContent('2 items · ₹275.44');
    expect(within(row).getByText('Refund initiated')).toBeInTheDocument();
    expect(within(row).getByText('Rejected by restaurant')).toBeInTheDocument();
  });

  it('?child=<id> opens the checkout that contains that child order', async () => {
    mockApi({ 'GET /orders': { items: [summary], nextCursor: null } });
    const { router } = renderWithProviders(<OrdersPage />, { route: '/orders?child=c2', path: '/orders', auth: makeAuth({ roles: ['CONSUMER'] }) });
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders/ck1'));
  });
});
