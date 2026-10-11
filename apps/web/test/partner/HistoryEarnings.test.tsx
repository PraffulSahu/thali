import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EarningsPage from '../../src/features/partner/EarningsPage';
import HistoryPage from '../../src/features/partner/HistoryPage';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, job, json, payout, routeFetch, summary } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
const auth = makeAuth({ roles: ['CONSUMER', 'DELIVERY_PARTNER'] });

describe('HistoryPage', () => {
  it('lists finished deliveries with drop area + label only and loads more by cursor', async () => {
    const fetchMock = routeFetch({
      'GET /deliveries/history': (_i, url) =>
        url!.includes('cursor=c2')
          ? json(200, { items: [job({ id: 'h3', status: 'FAILED', failureReason: 'Customer unreachable', pickup: { name: 'Spice Route', address: 'x', location: { lat: 1, lng: 1 } } })], nextCursor: null })
          : json(200, { items: [job({ id: 'h1', status: 'DELIVERED', deliveredAt: '2026-10-10T10:00:00Z' })], nextCursor: 'c2' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<HistoryPage />, { auth });
    expect(await screen.findByRole('heading', { level: 1, name: 'Delivery history' })).toBeInTheDocument();
    const row = (await screen.findAllByTestId('history-row'))[0]!;
    expect(row).toHaveTextContent('Delivered');
    expect(row).toHaveTextContent('Green Leaf → HAL 2nd Stage · Home');
    expect(row).toHaveTextContent('TH-DEMOMULTI');
    expect(row).toHaveTextContent('3.2 km');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Reason: Customer unreachable')).toBeInTheDocument();
    expect(screen.getAllByTestId('history-row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('empty and error states', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'GET /deliveries/history': () => json(200, { items: [], nextCursor: null }) }));
    const { unmount } = renderWithProviders(<HistoryPage />, { auth });
    expect(await screen.findByText('No deliveries yet')).toBeInTheDocument();
    unmount();
    vi.stubGlobal('fetch', routeFetch({ 'GET /deliveries/history': () => apiError(500, 'INTERNAL', 'boom') }));
    renderWithProviders(<HistoryPage />, { auth });
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('EarningsPage', () => {
  it('Today + This week windows, all-time tiles, ledger, payouts with the UTR rule', async () => {
    const fetchMock = routeFetch({
      'GET /finance/partner/summary': (_i, url) =>
        json(200, url!.includes('from=') ? summary({ deliveries: 31, earningsPaise: 341500 }) : summary({ deliveries: 6, earningsPaise: 64200 })),
      'GET /finance/partner/ledger': () =>
        json(200, { items: [{ id: 'l1', entryType: 'DELIVERY_EARNING', amountPaise: 6500, childOrderId: 'co1', deliveryJobId: 'job1', payoutId: null, memo: 'TH-DEMOMULTI', createdAt: '2026-10-11T07:30:00Z' }], nextCursor: null }),
      'GET /finance/partner/payouts': () => json(200, { items: [payout(), payout({ id: 'po2', status: 'REQUESTED', utr: null, confirmedAt: null })], nextCursor: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<EarningsPage />, { auth });
    expect(await screen.findByRole('heading', { level: 1, name: 'Earnings' })).toBeInTheDocument();
    expect(await screen.findByText('₹642')).toBeInTheDocument();
    expect(screen.getByText('6 deliveries · earned')).toBeInTheDocument();
    expect(await screen.findByText('₹3,415')).toBeInTheDocument();
    expect(screen.getByText('31 deliveries · earned')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => /summary\?from=\d{4}-\d{2}-\d{2}T00%3A00%3A00%2B05%3A30/.test(String(c[0])))).toBe(true);
    expect(await screen.findAllByText('Delivery earning')).not.toHaveLength(0);

    await userEvent.click(screen.getByRole('tab', { name: 'Payouts' }));
    const panel = await screen.findByRole('tabpanel');
    await waitFor(() => expect(within(panel).getAllByText('4021 8833 1190').length).toBeGreaterThan(0));
    expect(within(panel).getAllByText('Paid').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('Requested').length).toBeGreaterThan(0);
  });

  it('available-for-payout hint: hold period in days, or "ready" when there is no hold', async () => {
    for (const [holdDays, text] of [
      [7, 'Earnings unlock after 7 days'],
      [0, 'Ready for the next payout'],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        routeFetch({
          'GET /finance/partner/summary': () => json(200, { ...summary({ deliveries: 1, earningsPaise: 3800 }), holdDays }),
          'GET /finance/partner/ledger': () => json(200, { items: [], nextCursor: null }),
          'GET /finance/partner/payouts': () => json(200, { items: [], nextCursor: null }),
        }),
      );
      const { unmount } = renderWithProviders(<EarningsPage />, { auth });
      expect(await screen.findByText(text)).toBeInTheDocument();
      unmount();
    }
  });

  it('a failed window shows "—" + Retry, never zeros', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        'GET /finance/partner/summary': () => apiError(503, 'UPSTREAM_UNAVAILABLE', 'Payments unavailable'),
        'GET /finance/partner/ledger': () => json(200, { items: [], nextCursor: null }),
      }),
    );
    renderWithProviders(<EarningsPage />, { auth });
    expect((await screen.findAllByText('Stats unavailable', { exact: false })).length).toBeGreaterThan(0);
    expect(screen.queryByText('₹0')).not.toBeInTheDocument();
  });
});
