import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OverviewPage, { healthRows, kpiMoney, statusSegments } from '../../src/features/admin/OverviewPage';
import { renderWithProviders } from '../utils';
import {
  adminAuth, checkoutRow, exceptionJob, healthReport, json, marketOverview, nearPartner, ntfSummary, ordersOverview, pendingPartner, pendingRestaurant,
  routeFetch, tmsOverview,
} from './fixtures';

afterEach(() => vi.unstubAllGlobals());

function setup(opts: { roles?: Parameters<typeof adminAuth>[0]; ordersStatus?: number } = {}) {
  const calls = routeFetch([
    ['/admin/orders/overview', () => (opts.ordersStatus ? json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'orders down', requestId: 'r1' } }, opts.ordersStatus) : json(ordersOverview))],
    ['/admin/delivery/overview', () => json(tmsOverview)],
    ['/admin/marketplace/overview', () => json(marketOverview)],
    ['/admin/health', () => json(healthReport)],
    ['/admin/notifications/summary', () => json(ntfSummary)],
    ['/admin/notifications/dead-letters/replay', () => json({ replayed: 3, failed: [] })],
    ['/admin/notifications/retry', (_u, init) => json({ queued: JSON.parse(String(init?.body)).status === 'FAILED' ? 5 : 6 })],
    ['/admin/delivery/jobs/job1aaaaaaaaaaaaaaaaaaaa/assign', () => json({ ...exceptionJob, partnerId: 'near1', status: 'ASSIGNED' })],
    ['/admin/delivery/jobs', () => json({ items: [exceptionJob], nextCursor: null })],
    ['nearJobId=', () => json({ items: [nearPartner], nextCursor: null })],
    ['/admin/delivery/partners', () => json({ items: [pendingPartner], nextCursor: null })],
    ['/admin/marketplace/restaurants', () => json({ items: [pendingRestaurant], nextCursor: null })],
    ['/admin/orders/checkouts', () => json({ items: [checkoutRow, { ...checkoutRow, id: 'chk2', code: 'TH-K7Z2MP4Q', attention: 'FINDING_PARTNER', refundPendingPaise: 0, customer: { name: 'Rohit', phoneMasked: '+91 ••••• •8812' } }], nextCursor: null })],
  ]);
  const view = renderWithProviders(<OverviewPage />, { route: '/admin', auth: adminAuth(opts.roles) });
  return { calls, ...view };
}

describe('Admin overview (board 40)', () => {
  it('groups child statuses into the five drawn segments plus Failed only when non-zero', () => {
    const seg = statusSegments(ordersOverview.today.byStatus);
    expect(seg.map((s) => [s.label, s.count])).toEqual([
      ['Delivered', 38], ['In progress', 7], ['Placed', 2], ['Rejected', 3], ['Cancelled', 1], ['Failed', 0],
    ]);
    expect(seg.find((s) => s.key === 'failed')?.hideWhenZero).toBe(true);
    expect(kpiMoney(2841600)).toBe('₹28,416');
    expect(kpiMoney(120420)).toBe('₹1,204.20');
  });

  it('renders the KPI strip, status bar and title from the live overviews', async () => {
    setup();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Today at a glance');
    const kpis = await screen.findByRole('region', { name: /today's key figures/i });
    await within(kpis).findByText('42');
    expect(within(kpis).getByText('51 child orders')).toBeInTheDocument();
    expect(within(kpis).getByText('₹28,416')).toBeInTheDocument();
    expect(within(kpis).getByText('₹1,204.20 refunded')).toBeInTheDocument();
    expect(within(kpis).getByText('1 on a delivery')).toBeInTheDocument();
    expect(within(kpis).getByRole('link', { name: /open deliveries/i })).toHaveAttribute('href', '/admin/tms?filter=unassigned');
    expect(within(kpis).getByText('2 restaurants')).toBeInTheDocument();
    expect(within(kpis).getByText('1 partner')).toBeInTheDocument();
    expect(within(kpis).getByText('Nothing to retry')).toBeInTheDocument();
    const bar = await screen.findByRole('img', { name: /child orders by status/i });
    expect(bar).toHaveAttribute('aria-label', expect.stringContaining('Delivered 38, In progress 7, Placed 2, Rejected 3, Cancelled 1'));
    expect(bar.getAttribute('aria-label')).not.toMatch(/Failed/);
    expect(screen.getByText(/IST · refreshed \d+s ago/)).toBeInTheDocument();
  });

  it('never shows zeros when a source is down: "Stats unavailable · Retry"', async () => {
    setup({ ordersStatus: 503 });
    const kpis = await screen.findByRole('region', { name: /today's key figures/i });
    await waitFor(() => expect(within(kpis).getAllByText(/stats unavailable/i).length).toBeGreaterThanOrEqual(3));
    expect(within(kpis).queryByText('42')).not.toBeInTheDocument();
    expect(within(kpis).getAllByRole('button', { name: /retry/i }).length).toBeGreaterThan(0);
  });

  it('needs attention: Assign opens the DLV-7 nearest-partner picker and assigns', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const list = await screen.findByRole('list', { name: /needs attention/i });
    await within(list).findByText('TH-K7Z2MP4Q');
    expect(within(list).getByText(/Spice Route · no partner after 3 rounds · 6 min/)).toBeInTheDocument();
    expect(within(list).getByText('Approve unlocks after business email is verified')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(within(list).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/admin/partners/part1');
    expect(within(list).getByText('ID, licence and RC uploaded')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Assign' }));
    const dialog = await screen.findByRole('dialog', { name: /assign a partner/i });
    await within(dialog).findByText('1.2 km');
    const picker = calls.find((c) => c.url.includes('nearJobId='))!;
    const qs = new URL(picker.url, 'http://x').searchParams;
    expect(qs.get('status')).toBe('APPROVED');
    expect(qs.get('online')).toBe('true');
    expect(qs.get('hasCapacity')).toBe('true');
    expect(qs.get('nearJobId')).toBe(exceptionJob.id);

    await user.click(within(dialog).getByRole('radio', { name: /ravi m\./i }));
    await user.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes(`/admin/delivery/jobs/${exceptionJob.id}/assign`))).toBe(true));
    expect(calls.find((c) => c.url.includes('/assign'))!.body).toEqual({ partnerId: 'near1' });
  });

  it('system health shows real reasons (failing provider = Degraded), then bulk replay (NTF-3) and bulk retry (NTF-2)', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const table = await screen.findByRole('table', { name: /service health/i });
    const rows = within(table).getAllByRole('row');
    expect(rows[0]).toHaveAttribute('data-status', 'down');
    expect(within(rows[0]!).getByText(/ECONNREFUSED 10\.0\.0\.9:4005/)).toBeInTheDocument();
    const notif = rows.find((r) => r.textContent?.startsWith('notifications'))!;
    expect(notif).toHaveAttribute('data-status', 'degraded');
    expect(within(notif).getByText('Degraded')).toBeInTheDocument();
    expect(within(notif).getByText(/SMTP connect ECONNREFUSED 10\.0\.3\.12:587/)).toBeInTheDocument();
    expect(within(table).getByText('identity · orders')).toBeInTheDocument();
    expect(screen.queryByText(/all systems healthy/i)).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: '3 dead letters · Replay' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /replay all/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/admin/notifications/dead-letters/replay'))).toBe(true));

    await user.click(screen.getByRole('button', { name: '12 failed notifications · Retry' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /retry all/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/admin/notifications/retry'))).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith('/admin/notifications/retry')).map((c) => (c.body as { status: string }).status)).toEqual(['FAILED', 'DEAD']);
    expect(await screen.findByText(/re-queued 11 notifications/i)).toBeInTheDocument();
  });

  it('recent orders come from ORD-1 with status + day filters and View all keeps them', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const card = (await screen.findByRole('heading', { name: 'Recent orders' })).closest('section')!;
    await within(card).findByText('TH-DEMOMULTI');
    expect(within(card).getByText('Prafful · ••3210')).toBeInTheDocument();
    expect(within(card).getAllByText('Spice Route, Green Leaf')).toHaveLength(2);
    expect(within(card).getByText('₹218.10 pending')).toBeInTheDocument();
    expect(within(card).getByText('Finding a partner')).toBeInTheDocument();
    const first = new URL(calls.find((c) => c.url.includes('/admin/orders/checkouts'))!.url, 'http://x').searchParams;
    expect(first.get('limit')).toBe('5');
    expect(first.get('from')).toMatch(/T18:30:00\.000Z$/);
    expect(first.get('status')).toBeNull();

    await user.selectOptions(within(card).getByLabelText('Order status'), 'COMPLETED');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/admin/orders/checkouts') && c.url.includes('status=COMPLETED'))).toBe(true));
    expect(within(card).getByRole('link', { name: /view all/i })).toHaveAttribute('href', '/admin/orders?status=COMPLETED&range=today');
    expect(within(card).getByRole('link', { name: 'TH-DEMOMULTI' })).toHaveAttribute('href', '/admin/orders/chk1');
  });

  it('gates Assign and Approve for sub-roles that cannot use them, with an explanation', async () => {
    setup({ roles: ['FINANCE'] });
    const list = await screen.findByRole('list', { name: /needs attention/i });
    await within(list).findByText('TH-K7Z2MP4Q');
    expect(within(list).getByRole('button', { name: 'Assign' })).toBeDisabled();
    expect(within(list).getByText("Your role can't assign deliveries")).toBeInTheDocument();
    expect(within(list).getByText("Your role can't approve restaurants")).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '3 dead letters · Replay' })).toBeDisabled();
  });

  it('healthRows keeps each problem service on its own row and groups the healthy ones', () => {
    const rows = healthRows(healthReport as never);
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ['delivery', 'down'], ['payments', 'degraded'], ['notifications', 'degraded'], ['identity · orders', 'up'], ['gateway · redis', 'up'],
    ]);
  });
});
