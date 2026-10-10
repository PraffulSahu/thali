import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrderInvestigation from '../../src/features/admin/OrderInvestigation';
import { makeAuth, renderWithProviders } from '../utils';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const detail = {
  checkout: {
    id: 'chk1',
    code: 'TH-1001',
    status: 'IN_PROGRESS',
    paymentStatus: 'CAPTURED',
    paymentIntentId: 'pi1',
    createdAt: '2026-10-10T08:00:00.000Z',
    pricing: { totalPaise: 90000 },
  },
  children: [
    { id: 'c1', code: 'TH-1001-A', restaurantName: 'Spice Route', status: 'ACCEPTED', breakdown: { totalPaise: 50000 }, refundedPaise: 10000, refundStatus: 'SUCCEEDED', lines: [{ name: 'Biryani', quantity: 2 }] },
    { id: 'c2', code: 'TH-1001-B', restaurantName: 'Dosa Corner', status: 'DELIVERED', breakdown: { totalPaise: 40000 }, refundedPaise: 0, refundStatus: 'NONE', lines: [] },
  ],
  timeline: [
    { id: 'e1', type: 'checkout.created', childOrderId: null, actor: 'CUSTOMER', actorId: 'u1', at: '2026-10-10T08:00:00.000Z', data: {} },
    { id: 'e2', type: 'child.accepted', childOrderId: 'c1', actor: 'RESTAURANT', actorId: 'r1', at: '2026-10-10T08:05:00.000Z', data: { prepMinutes: 20 } },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/cancel')) return Promise.resolve(json({ ok: true }));
      return Promise.resolve(json(detail));
    }),
  );
  renderWithProviders(<OrderInvestigation />, { route: '/admin/orders/chk1', path: '/admin/orders/:checkoutId', auth: makeAuth({ roles: ['ADMIN'], adminRoles: ['SUPPORT'] }) });
  return calls;
}

describe('OrderInvestigation', () => {
  it('renders the timeline from order_events', async () => {
    setup();
    expect(await screen.findByText('TH-1001')).toBeInTheDocument();
    const timeline = screen.getByRole('list', { name: /timeline/i });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(2);
    expect(within(timeline).getByText(/child\.accepted/i)).toBeInTheDocument();
  });

  it('refuses a refund above the remaining amount and submits a valid one', async () => {
    const user = userEvent.setup();
    const calls = setup();
    await screen.findByText('TH-1001');

    // Spice Route: total ₹500.00, already refunded ₹100.00 -> remaining ₹400.00. Delivered orders can't be cancelled.
    expect(screen.getAllByRole('button', { name: /cancel and refund/i })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /cancel and refund/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/remaining.*₹400\.00/i)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/describe the reason|reason/i), 'Kitchen flooded');
    const amount = within(dialog).getByLabelText(/refund amount/i);
    await user.clear(amount);
    await user.type(amount, '450');
    expect(within(dialog).getByText(/cannot exceed ₹400\.00/i)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: /cancel order/i });
    expect(confirm).toBeDisabled();
    expect(calls.some((c) => c.url.includes('/cancel'))).toBe(false);

    await user.clear(amount);
    await user.type(amount, '400');
    expect(within(dialog).queryByText(/cannot exceed/i)).not.toBeInTheDocument();
    await user.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/admin/orders/child/c1/cancel'))).toBe(true));
    const post = calls.find((c) => c.url.includes('/cancel'))!;
    expect(post.init?.method).toBe('POST');
    expect(JSON.parse(String(post.init?.body))).toEqual({ reason: 'Kitchen flooded', refundPaise: 40000 });
  });
});
