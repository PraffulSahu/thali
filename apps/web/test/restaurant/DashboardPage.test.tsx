import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '../../src/features/restaurant/DashboardPage';
import { makeAuth, renderWithProviders } from '../utils';
import { json, makeDashboard, makeRestaurant, mockApi, withRestaurant } from './fixtures';

const render = (r = makeRestaurant()) => renderWithProviders(withRestaurant(r, <DashboardPage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });
afterEach(() => vi.unstubAllGlobals());

describe('DashboardPage', () => {
  it("shows today's KPIs from the real dashboard shape and asks for IST today", async () => {
    const api = mockApi([['GET', /\/dashboard$/, makeDashboard()]]);
    render();
    expect(await screen.findByRole('heading', { level: 1, name: 'Today at Spice Route' })).toBeInTheDocument();
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('87.5%')).toBeInTheDocument(); // acceptanceRate is a 0..1 fraction
    expect(screen.getByText('1m 35s')).toBeInTheDocument(); // 95 s to accept
    expect(screen.getByText('₹6,400')).toBeInTheDocument(); // gross
    expect(screen.getByText('/ ₹5,120')).toBeInTheDocument(); // net
    expect(screen.getByText('Open · accepting')).toBeInTheDocument();
    expect(screen.getByText('From 31 ratings')).toBeInTheDocument();

    const q = new URLSearchParams(api.calls[0]!.search);
    const from = Date.parse(q.get('from')!);
    const to = Date.parse(q.get('to')!);
    expect(to - from).toBe(86_400_000 - 1); // one IST day
    expect((from + 330 * 60_000) % 86_400_000).toBe(0); // starts at IST midnight
  });

  it('menu health lists low-stock items with an "Update stock" link into the menu', async () => {
    mockApi([['GET', /\/dashboard$/, makeDashboard()]]);
    render();
    expect(await screen.findByText('Gulab Jamun')).toBeInTheDocument();
    expect(screen.getByText('3 left')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Update stock' })).toHaveAttribute('href', '/restaurant/menu?item=i9');
  });

  it('says stats are unavailable (not zeros) when the orders service was unreachable, and retries', async () => {
    const api = mockApi([['GET', /\/dashboard$/, makeDashboard({ orders: null, ordersAvailable: false })]]);
    const user = userEvent.setup();
    render();
    expect(await screen.findAllByText(/stats unavailable/i)).toHaveLength(4);
    expect(screen.queryByText('12')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Menu health' })).toBeInTheDocument(); // menu data still shown
    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(1));
  });

  it('shows a dash for acceptance rate and accept time when nothing has been decided', async () => {
    const base = makeDashboard();
    mockApi([['GET', /\/dashboard$/, makeDashboard({ orders: { ...base.orders!, ordersTotal: 0, byStatus: {}, acceptanceRate: null, avgAcceptSeconds: null, grossPaise: 0, netRevenuePaise: 0 } })]]);
    render();
    expect(await screen.findByText('No orders decided yet')).toBeInTheDocument();
    expect(screen.getByText('No accepted orders yet')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('shows "New" instead of a rating under 5 ratings', async () => {
    mockApi([['GET', /\/dashboard$/, makeDashboard({ rating: null, ratingCount: 3 })]]);
    render();
    expect(await screen.findByText(/after 5 ratings \(3 so far\)/)).toBeInTheDocument();
  });

  it('pauses from the open-state card', async () => {
    const api = mockApi([
      ['GET', /\/dashboard$/, makeDashboard()],
      ['POST', /\/owner\/restaurants\/r1\/pause$/, () => json(makeRestaurant({ pausedUntil: new Date(Date.now() + 60 * 60_000).toISOString() }))],
    ]);
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: '60 min' }));
    await user.click(screen.getByRole('button', { name: 'Pause for 60 min' }));
    await waitFor(() => expect(api.find('POST', /pause$/)[0]?.body).toEqual({ minutes: 60 }));
  });

  it("doesn't call the dashboard until the restaurant is approved", async () => {
    const api = mockApi([]);
    render(makeRestaurant({ status: 'APPROVAL_PENDING' }));
    expect(await screen.findByText(/when spice route is approved/i)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
});
