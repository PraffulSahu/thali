import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RefundsPanel from '../../src/features/admin/RefundsPanel';
import { makeAuth, renderWithProviders } from '../utils';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pay = (id: string, ref: string, captured: number) => ({
  paymentIntentId: id, status: 'CAPTURED', purpose: 'CHECKOUT', referenceId: ref, amountPaise: captured, capturedPaise: captured,
  refundedPaise: 0, refundReservedPaise: 0, userId: 'u1', isDemo: false, createdAt: '2026-10-10T08:00:00.000Z',
});
afterEach(() => vi.unstubAllGlobals());

function setup(searchItems: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/finance/payments')) return Promise.resolve(json({ items: searchItems, nextCursor: null }));
    if (init?.method === 'POST') return Promise.resolve(json({ id: 'r1' }, 201));
    return Promise.resolve(json({ items: [], nextCursor: null }));
  }));
  renderWithProviders(<RefundsPanel />, { auth: makeAuth({ roles: ['ADMIN'], adminRoles: ['FINANCE'] }) });
  return calls;
}

describe('RefundsPanel manual refund lookup', () => {
  it('never guesses a payment: a non-exact match must be picked explicitly', async () => {
    const user = userEvent.setup();
    const calls = setup([pay('aaaaaaaaaaaaaaaaaaaaaaaa', 'chk-1', 50000), pay('bbbbbbbbbbbbbbbbbbbbbbbb', 'chk-2', 90000)]);
    await user.click(await screen.findByRole('button', { name: /manual refund/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/payment id/i), 'user-123');
    await user.click(within(dialog).getByRole('button', { name: /look up payment/i }));

    // candidates listed, typed text untouched, nothing selected, refund impossible
    expect(await within(dialog).findByText(/choose the payment to refund/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/payment id/i)).toHaveValue('user-123');
    expect(within(dialog).getByRole('button', { name: /issue refund/i })).toBeDisabled();
    expect(within(dialog).getByLabelText(/refund amount/i)).toBeDisabled();

    await user.click(within(dialog).getByRole('radio', { name: /bbbbbbbbbbbbbbbbbbbbbbbb/ }));
    expect(within(dialog).getByText(/selected payment bbbbbbbbbbbbbbbbbbbbbbbb \(reference chk-2\)/i)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/refund amount/i), '100');
    await user.type(within(dialog).getByLabelText(/note/i), 'Goodwill');
    await user.click(within(dialog).getByRole('button', { name: /issue refund/i }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init?.body))).toMatchObject({ paymentIntentId: 'bbbbbbbbbbbbbbbbbbbbbbbb', amountPaise: 10000 });
    expect((post.init?.headers as Record<string, string>)['Idempotency-Key'] ?? new Headers(post.init?.headers).get('idempotency-key')).toBeTruthy();
  });

  it('auto-selects only an exact payment id match', async () => {
    const user = userEvent.setup();
    setup([pay('aaaaaaaaaaaaaaaaaaaaaaaa', 'chk-1', 50000), pay('bbbbbbbbbbbbbbbbbbbbbbbb', 'chk-2', 90000)]);
    await user.click(await screen.findByRole('button', { name: /manual refund/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/payment id/i), 'aaaaaaaaaaaaaaaaaaaaaaaa');
    await user.click(within(dialog).getByRole('button', { name: /look up payment/i }));
    expect(await within(dialog).findByText(/selected payment aaaaaaaaaaaaaaaaaaaaaaaa/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/choose the payment/i)).not.toBeInTheDocument();
  });
});
