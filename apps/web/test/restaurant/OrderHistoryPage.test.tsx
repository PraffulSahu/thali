import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrderHistoryPage from '../../src/features/restaurant/OrderHistoryPage';
import { makeAuth, renderWithProviders } from '../utils';
import { makeOrder, makeRestaurant, mockApi, withRestaurant } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('OrderHistoryPage', () => {
  it('lists past orders and filters by status', async () => {
    const api = mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder({ status: 'DELIVERED', acceptBy: null }), makeOrder({ id: 'o2', code: 'TH-REJECTED1', status: 'REJECTED', rejectionReason: 'Out of stock', refundStatus: 'SUCCEEDED', acceptBy: null })], nextCursor: null }]]);
    const user = userEvent.setup();
    renderWithProviders(withRestaurant(makeRestaurant(), <OrderHistoryPage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
    expect(await screen.findByText('TH-8K2M4Q7A')).toBeInTheDocument();
    expect(screen.getByText('TH-REJECTED1')).toBeInTheDocument();

    expect(api.calls[0]!.search).not.toContain('status=');
    await user.selectOptions(screen.getByLabelText('Status'), 'declined');
    await waitFor(() => expect(api.calls.some((c) => decodeURIComponent(c.search).includes('status=REJECTED,CANCELLED'))).toBe(true));
    expect(api.calls.at(-1)!.search).toContain('restaurantId=r1');
    // the API has no date filters, so none are offered
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
  });

  it('shows an empty state with filter hints', async () => {
    mockApi([['GET', /^\/owner\/orders$/, { items: [], nextCursor: null }]]);
    renderWithProviders(withRestaurant(makeRestaurant(), <OrderHistoryPage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
    expect(await screen.findByText(/no orders yet/i)).toBeInTheDocument();
  });

  it('opens order details with the rejection reason', async () => {
    mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder({ status: 'REJECTED', rejectionReason: 'Out of stock', acceptBy: null })], nextCursor: null }]]);
    const user = userEvent.setup();
    renderWithProviders(withRestaurant(makeRestaurant(), <OrderHistoryPage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
    await user.click(await screen.findByRole('button', { name: /view order TH-8K2M4Q7A/i }));
    expect(await screen.findByText(/Rejection reason:/)).toBeInTheDocument();
    expect(screen.getByText(/Out of stock/)).toBeInTheDocument();
  });
});
