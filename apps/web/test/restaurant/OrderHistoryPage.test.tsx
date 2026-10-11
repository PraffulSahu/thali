import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrderHistoryPage from '../../src/features/restaurant/OrderHistoryPage';
import { makeAuth, renderWithProviders } from '../utils';
import { json, makeOrder, makeRestaurant, mockApi, withRestaurant } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
const render = (route = '/restaurant/orders/history') =>
  renderWithProviders(withRestaurant(makeRestaurant(), <OrderHistoryPage />), { route, auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });

describe('OrderHistoryPage', () => {
  it('lists past orders and filters by status with pills (kept in the URL)', async () => {
    const api = mockApi([
      ['GET', /^\/owner\/orders$/, { items: [makeOrder({ status: 'DELIVERED', acceptBy: null }), makeOrder({ id: 'o2', code: 'TH-REJECTED1', status: 'REJECTED', rejectionReason: 'Out of stock', refundStatus: 'SUCCEEDED', acceptBy: null })], nextCursor: null }],
    ]);
    const user = userEvent.setup();
    const { router } = render();
    expect(await screen.findByRole('button', { name: 'TH-8K2M4Q7A' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TH-REJECTED1' })).toBeInTheDocument();
    expect(screen.getByText('Refunded')).toBeInTheDocument();

    expect(api.calls[0]!.search).not.toContain('status=');
    const pills = screen.getByRole('group', { name: 'Filter by status' });
    expect(within(pills).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(pills).getByRole('button', { name: 'Rejected or cancelled' }));
    await waitFor(() => expect(api.calls.some((c) => decodeURIComponent(c.search).includes('status=REJECTED,CANCELLED'))).toBe(true));
    expect(api.calls.at(-1)!.search).toContain('restaurantId=r1');
    expect(router.state.location.search).toBe('?status=declined');
    // the API has no date filters, so none are offered
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
  });

  it('reads the filter from the URL', async () => {
    const api = mockApi([['GET', /^\/owner\/orders$/, { items: [], nextCursor: null }]]);
    render('/restaurant/orders/history?status=failed');
    expect(await screen.findByText(/no orders match this filter/i)).toBeInTheDocument();
    expect(decodeURIComponent(api.calls[0]!.search)).toContain('status=DELIVERY_FAILED');
  });

  it('shows an empty state', async () => {
    mockApi([['GET', /^\/owner\/orders$/, { items: [], nextCursor: null }]]);
    render();
    expect(await screen.findByText(/no orders yet/i)).toBeInTheDocument();
  });

  it('opens order details with the rejection reason', async () => {
    const o = makeOrder({ status: 'REJECTED', rejectionReason: 'Out of stock', acceptBy: null });
    mockApi([
      ['GET', /^\/owner\/orders$/, { items: [o], nextCursor: null }],
      ['GET', /^\/owner\/orders\/o1$/, () => json(o)],
    ]);
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: /view order TH-8K2M4Q7A/i }));
    expect(await screen.findByText('Rejection reason: Out of stock')).toBeInTheDocument();
  });
});
