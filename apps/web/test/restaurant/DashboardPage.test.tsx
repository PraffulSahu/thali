import '../setup';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '../../src/features/restaurant/DashboardPage';
import { makeAuth, renderWithProviders } from '../utils';
import { makeDashboard, makeRestaurant, mockApi, withRestaurant } from './fixtures';

const render = (r = makeRestaurant()) => renderWithProviders(withRestaurant(r, <DashboardPage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
afterEach(() => vi.unstubAllGlobals());

describe('DashboardPage', () => {
  it("shows today's numbers from the real dashboard shape and asks for IST today", async () => {
    const api = mockApi([['GET', /\/dashboard$/, makeDashboard()]]);
    render();
    expect(await screen.findByText('Orders today')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('87.5%')).toBeInTheDocument(); // acceptanceRate is a 0..1 fraction
    expect(screen.getByText('₹5,120.00')).toBeInTheDocument(); // net revenue
    expect(screen.getByText('1:35')).toBeInTheDocument(); // 95 s to accept
    expect(screen.getByText(/8 delivered, 2 rejected or cancelled/)).toBeInTheDocument();
    expect(screen.getByText('Gulab Jamun')).toBeInTheDocument();
    expect(screen.getByText(/rating 4.4 from 31 ratings/i)).toBeInTheDocument();

    const q = new URLSearchParams(api.calls[0]!.search);
    const from = Date.parse(q.get('from')!);
    const to = Date.parse(q.get('to')!);
    expect(to - from).toBe(86_400_000 - 1); // one IST day
    expect((from + 330 * 60_000) % 86_400_000).toBe(0); // starts at IST midnight
  });

  it('says order stats are unavailable (not zeros) when the orders service was unreachable', async () => {
    mockApi([['GET', /\/dashboard$/, makeDashboard({ orders: null, ordersAvailable: false })]]);
    render();
    expect(await screen.findByText('Order stats unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Orders today')).not.toBeInTheDocument();
    expect(screen.getByText(/menu health/i)).toBeInTheDocument(); // menu data still shown
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows a dash for acceptance rate and accept time when nothing has been decided', async () => {
    const base = makeDashboard();
    mockApi([['GET', /\/dashboard$/, makeDashboard({ orders: { ...base.orders!, ordersTotal: 0, byStatus: {}, acceptanceRate: null, avgAcceptSeconds: null, grossPaise: 0, netRevenuePaise: 0 } })]]);
    render();
    expect(await screen.findByText('No orders decided yet')).toBeInTheDocument();
    expect(screen.getAllByLabelText('not available')).toHaveLength(2);
  });

  it("doesn't call the dashboard until the restaurant is approved", async () => {
    const api = mockApi([]);
    render(makeRestaurant({ status: 'APPROVAL_PENDING' }));
    expect(await screen.findByText(/once spice route is approved/i)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
});
