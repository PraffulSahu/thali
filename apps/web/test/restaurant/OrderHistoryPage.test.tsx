import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrderHistoryPage, { istDayBound } from '../../src/features/restaurant/OrderHistoryPage';
import { makeAuth, renderWithProviders } from '../utils';
import { makeOrder, makeRestaurant, mockApi, withRestaurant } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('istDayBound', () => {
  it('converts an IST calendar day to UTC instants', () => {
    expect(istDayBound('2026-10-10', false)).toBe('2026-10-09T18:30:00.000Z');
    expect(istDayBound('2026-10-10', true)).toBe('2026-10-10T18:29:59.999Z');
    expect(istDayBound('', false)).toBeUndefined();
  });
});

describe('OrderHistoryPage', () => {
  it('lists past orders and filters by status', async () => {
    const api = mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder({ status: 'DELIVERED', acceptBy: null }), makeOrder({ id: 'o2', code: 'TH-REJECTED1', status: 'REJECTED', rejectionReason: 'Out of stock', refundStatus: 'SUCCEEDED', refundedPaise: 99000, acceptBy: null })], nextCursor: null }]]);
    const user = userEvent.setup();
    renderWithProviders(withRestaurant(makeRestaurant(), <OrderHistoryPage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
    expect(await screen.findByText('TH-8K2M4Q7A')).toBeInTheDocument();
    expect(screen.getByText('TH-REJECTED1')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'REJECTED');
    await waitFor(() => expect(api.calls.some((c) => c.search.includes('status=REJECTED'))).toBe(true));
    expect(api.calls.at(-1)!.search).toContain('restaurantId=r1');
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
