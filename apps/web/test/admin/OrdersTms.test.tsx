import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrdersSearch from '../../src/features/admin/OrdersSearch';
import TmsPage from '../../src/features/admin/TmsPage';
import { renderWithProviders } from '../utils';
import { adminAuth, checkoutRow, exceptionJob, json, routeFetch, tmsOverview } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('Orders search (ORD-1)', () => {
  it('reads status + range from the URL (overview "View all") and searches by code or phone', async () => {
    const user = userEvent.setup();
    const calls = routeFetch([['/admin/orders/checkouts', () => json({ items: [checkoutRow], nextCursor: null })]]);
    renderWithProviders(<OrdersSearch />, { route: '/admin/orders?status=COMPLETED&range=today', auth: adminAuth() });
    expect(await screen.findByRole('link', { name: 'TH-DEMOMULTI' })).toHaveAttribute('href', '/admin/orders/chk1');
    const first = new URL(calls[0]!.url, 'http://x').searchParams;
    expect(first.get('status')).toBe('COMPLETED');
    expect(first.get('from')).toMatch(/T18:30:00\.000Z$/);

    await user.type(screen.getByRole('searchbox'), '98765 43210');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => new URL(c.url, 'http://x').searchParams.get('q') === '98765 43210')).toBe(true));
  });
});

describe('Orders search input follows the URL', () => {
  it('updates the search box when ?q changes while the page is open (⌘K "Search all orders")', async () => {
    routeFetch([['/admin/orders/checkouts', () => json({ items: [checkoutRow], nextCursor: null })]]);
    const { router } = renderWithProviders(<OrdersSearch />, { route: '/admin/orders?q=TH-OLD', auth: adminAuth() });
    expect(await screen.findByRole('searchbox')).toHaveValue('TH-OLD');
    await act(() => router.navigate('/admin/orders?q=TH-NEW'));
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue('TH-NEW'));
  });
});

describe('Deliveries (TMS)', () => {
  it('opens on ?filter=unassigned, switches to exceptions, and shows order codes', async () => {
    const user = userEvent.setup();
    const calls = routeFetch([
      ['/admin/delivery/overview', () => json(tmsOverview)],
      ['/admin/delivery/jobs', () => json({ items: [exceptionJob], nextCursor: null })],
      ['/admin/delivery/partners', () => json({ items: [], nextCursor: null })],
      ['/meta', () => json({ mode: 'demo', providers: {} })],
    ]);
    renderWithProviders(<TmsPage />, { route: '/admin/tms?filter=unassigned', auth: adminAuth(['OPS']) });
    const table = await screen.findByRole('region', { name: 'Deliveries' });
    await within(table).findByText('TH-K7Z2MP4Q');
    const first = new URL(calls.find((c) => c.url.includes('/admin/delivery/jobs'))!.url, 'http://x').searchParams;
    expect(first.get('status')).toBe('PENDING_ASSIGNMENT');

    await user.click(screen.getByRole('button', { name: /exceptions/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/admin/delivery/jobs') && c.url.includes('exception=true'))).toBe(true));
    expect(within(table).getByRole('button', { name: 'Assign' })).toBeEnabled();
  });

  it('explains why a non-Ops admin cannot assign', async () => {
    routeFetch([
      ['/admin/delivery/overview', () => json(tmsOverview)],
      ['/admin/delivery/jobs', () => json({ items: [exceptionJob], nextCursor: null })],
    ]);
    renderWithProviders(<TmsPage />, { route: '/admin/tms', auth: adminAuth(['SUPPORT']) });
    expect(await screen.findByText(/assigning, unassigning and failing need the ops role/i)).toBeInTheDocument();
    await screen.findByText('TH-K7Z2MP4Q');
    expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
  });
});
