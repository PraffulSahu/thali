import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PayoutsPanel from '../../src/features/admin/PayoutsPanel';
import { makeAuth, renderWithProviders } from '../utils';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const payout = {
  id: 'p1', accountType: 'RESTAURANT', accountId: 'rest1', amountPaise: 125000, status: 'REQUESTED', method: 'MANUAL_BANK_TRANSFER',
  utr: null, requestedBy: 'a1', confirmedBy: null, confirmedAt: null, failureReason: null, notes: null,
  createdAt: '2026-10-10T08:00:00.000Z', updatedAt: '2026-10-10T08:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('PayoutsPanel', () => {
  it('will not confirm a payout without a valid UTR', async () => {
    const user = userEvent.setup();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes('/confirm')) return Promise.resolve(json({ ...payout, status: 'PAID', utr: 'UTR123456789' }));
        return Promise.resolve(json({ items: [payout], nextCursor: null }));
      }),
    );
    renderWithProviders(<PayoutsPanel />, { auth: makeAuth({ roles: ['ADMIN'], adminRoles: ['FINANCE'] }) });

    await user.click(await screen.findByRole('button', { name: /confirm payout/i }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: /record payment/i });
    expect(confirm).toBeDisabled();

    const utr = within(dialog).getByLabelText(/utr/i);
    await user.type(utr, 'ab1');
    expect(within(dialog).getByText(/6.{1,3}32 letters or digits/i)).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    expect(calls.some((c) => c.url.includes('/confirm'))).toBe(false);

    await user.clear(utr);
    await user.type(utr, 'UTR123456789');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.url.includes('/admin/finance/payouts/p1/confirm'))).toBe(true));
    const post = calls.find((c) => c.url.includes('/confirm'))!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ utr: 'UTR123456789' });
  });
});
