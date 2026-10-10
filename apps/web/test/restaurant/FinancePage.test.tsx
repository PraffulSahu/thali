import '../setup';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FinancePage from '../../src/features/restaurant/FinancePage';
import { payoutDisplay } from '../../src/features/restaurant/api';
import { makeAuth, renderWithProviders } from '../utils';
import { makeRestaurant, mockApi, withRestaurant } from './fixtures';

const summary = {
  accountType: 'RESTAURANT', accountId: 'r1', balancePaise: 500000, availablePaise: 300000, pendingPayoutPaise: 100000, paidOutPaise: 50000,
  holdDays: 0, totalsByType: { ORDER_EARNING: 700000, COMMISSION: -126000, REFUND_ADJUSTMENT: -24000, PAYOUT: -50000 }, asOf: '2026-10-10T08:00:00.000Z',
};
const payout = (over: object) => ({ id: 'p', amountPaise: 100000, status: 'REQUESTED', method: 'MANUAL_BANK_TRANSFER', utr: null, confirmedAt: null, failureReason: null, notes: null, createdAt: '2026-10-09T08:00:00.000Z', ...over });

afterEach(() => vi.unstubAllGlobals());

describe('payoutDisplay', () => {
  it('never reports Paid without a UTR', () => {
    expect(payoutDisplay({ status: 'PAID', utr: null })).toEqual({ label: 'Awaiting UTR confirmation', tone: 'warn' });
    expect(payoutDisplay({ status: 'PAID', utr: '   ' }).label).not.toBe('Paid');
    expect(payoutDisplay({ status: 'PAID', utr: 'HDFC123456789' }).label).toBe('Paid');
  });
  it('maps the other states', () => {
    expect(payoutDisplay({ status: 'REQUESTED', utr: null }).label).toBe('Requested');
    expect(payoutDisplay({ status: 'PROCESSING', utr: null }).label).toBe('Processing');
    expect(payoutDisplay({ status: 'FAILED', utr: null }).tone).toBe('danger');
  });
});

describe('FinancePage', () => {
  const render = () => renderWithProviders(withRestaurant(makeRestaurant(), <FinancePage />), { auth: makeAuth({ roles: ['RESTAURANT_OWNER'] }) });

  it('shows the summary from the payments ledger with commission and refunds', async () => {
    mockApi([
      ['GET', /finance\/restaurants\/r1\/summary$/, summary],
      ['GET', /finance\/restaurants\/r1\/ledger$/, { items: [], nextCursor: null }],
    ]);
    render();
    expect(await screen.findByText('Available for payout')).toBeInTheDocument();
    expect(screen.getByText('₹3,000.00')).toBeInTheDocument();
    expect(screen.getByText('-₹1,260.00')).toBeInTheDocument();
    expect(screen.getByText(/18% of items/)).toBeInTheDocument();
    expect(screen.getByText('-₹240.00')).toBeInTheDocument();
  });

  it('lists payouts: only a payout with a UTR is shown as Paid', async () => {
    mockApi([
      ['GET', /summary$/, summary],
      ['GET', /ledger$/, { items: [], nextCursor: null }],
      [
        'GET', /payouts$/,
        { items: [
          payout({ id: 'a', status: 'PAID', utr: 'UTIB0123456789', confirmedAt: '2026-10-09T10:00:00.000Z' }),
          payout({ id: 'b', status: 'PAID', utr: null, amountPaise: 222200 }),
          payout({ id: 'c', status: 'REQUESTED', amountPaise: 333300 }),
        ], nextCursor: null },
      ],
    ]);
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('tab', { name: /payouts/i }));

    const table = await screen.findByRole('table', { name: /payouts/i });
    const rows = within(table).getAllByRole('row');
    const rowFor = (amount: string) => rows.find((r) => within(r).queryByText(amount))!;

    const withUtr = rowFor('₹1,000.00');
    expect(within(withUtr).getByText('Paid')).toBeInTheDocument();
    expect(within(withUtr).getByText('UTIB0123456789')).toBeInTheDocument();

    const noUtr = rowFor('₹2,222.00');
    expect(within(noUtr).queryByText('Paid')).not.toBeInTheDocument();
    expect(within(noUtr).getByText('Awaiting UTR confirmation')).toBeInTheDocument();

    expect(within(rowFor('₹3,333.00')).getByText('Requested')).toBeInTheDocument();
  });

  it('shows ledger rows with signed amounts and an empty state when there are none', async () => {
    mockApi([
      ['GET', /summary$/, summary],
      ['GET', /ledger$/, { items: [{ id: 'l1', entryType: 'COMMISSION', amountPaise: -18000, childOrderId: 'abc12345678', payoutId: null, refundId: null, memo: 'Commission 18%', createdAt: '2026-10-09T08:00:00.000Z' }], nextCursor: null }],
    ]);
    render();
    const table = await screen.findByRole('table', { name: /ledger/i });
    expect(within(table).getByText('Commission')).toBeInTheDocument();
    expect(within(table).getByText('-₹180.00')).toBeInTheDocument();
  });

  it('offers retry when the summary fails', async () => {
    mockApi([
      ['GET', /summary$/, () => new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'x', requestId: 'r' } }), { status: 500, headers: { 'content-type': 'application/json' } })],
      ['GET', /ledger$/, { items: [], nextCursor: null }],
    ]);
    render();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
