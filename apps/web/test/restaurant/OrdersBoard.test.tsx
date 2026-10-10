import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrdersBoard from '../../src/features/restaurant/OrdersBoard';
import { playOrderChime, setSoundEnabled } from '../../src/features/restaurant/orderStream';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, json, makeOrder, makeRestaurant, mockApi, withRestaurant } from './fixtures';

const auth = () => makeAuth({ roles: ['RESTAURANT_OWNER'] });
const board = (restaurant = makeRestaurant()) => renderWithProviders(withRestaurant(restaurant, <OrdersBoard />), { route: '/restaurant/orders', auth: auth() });

afterEach(() => {
  setSoundEnabled(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OrdersBoard', () => {
  it('shows an incoming order with the accept countdown and requests only this restaurant', async () => {
    const api = mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder()], nextCursor: null }]]);
    board();

    const card = await screen.findByRole('listitem', { name: 'Order TH-8K2M4Q7A' });
    const timer = within(card).getByRole('timer');
    expect(timer).toHaveTextContent(/^(4:[5-9]\d|5:00)$/);
    expect(within(card).getByText(/Accept within/i)).toBeInTheDocument();
    expect(within(card).getByText(/Chicken Biryani/)).toBeInTheDocument();
    expect(within(card).getByText(/Note: Less spicy/)).toBeInTheDocument();
    const q = decodeURIComponent(api.find('GET', /^\/owner\/orders$/)[0]!.search);
    expect(q).toContain('restaurantId=r1');
    expect(q).toContain('status=PLACED,ACCEPTED,PREPARING,READY_FOR_PICKUP');
  });

  it('keeps "Reject order" disabled until a reason is chosen, then rejects with that reason', async () => {
    const api = mockApi([
      ['GET', /^\/owner\/orders$/, { items: [makeOrder()], nextCursor: null }],
      ['POST', /\/owner\/orders\/o1\/reject$/, () => json(makeOrder({ status: 'REJECTED' }))],
    ]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: /^reject$/i }));

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /reject order/i });
    expect(confirm).toBeDisabled();

    await user.selectOptions(within(dialog).getByLabelText(/reason/i), 'Kitchen is too busy');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(api.find('POST', /reject$/)).toHaveLength(1));
    expect(api.find('POST', /reject$/)[0]!.body).toEqual({ reason: 'Kitchen is too busy' });
  });

  it('requires text when the reason is "Other"', async () => {
    mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder()], nextCursor: null }]]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: /^reject$/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.selectOptions(within(dialog).getByLabelText(/^reason/i), 'Other');
    const confirm = within(dialog).getByRole('button', { name: /reject order/i });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/describe the reason/i), 'Gas cylinder ran out');
    expect(confirm).toBeEnabled();
  });

  it('accepts with the selected prep time', async () => {
    const api = mockApi([
      ['GET', /^\/owner\/orders$/, { items: [makeOrder()], nextCursor: null }],
      ['POST', /accept$/, () => json(makeOrder({ status: 'ACCEPTED', prepMinutes: 30 }))],
    ]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: /^accept$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const select = within(dialog).getByLabelText(/preparation time/i) as HTMLSelectElement;
    expect(select.value).toBe('20'); // the restaurant's average prep time
    await user.selectOptions(select, '30');
    await user.click(within(dialog).getByRole('button', { name: /accept order/i }));
    await waitFor(() => expect(api.find('POST', /accept$/)).toHaveLength(1));
    expect(api.find('POST', /accept$/)[0]!.body).toEqual({ prepMinutes: 30 });
  });

  it('shows the server error when the accept window has closed and keeps the dialog open', async () => {
    mockApi([
      ['GET', /^\/owner\/orders$/, { items: [makeOrder()], nextCursor: null }],
      ['POST', /accept$/, () => apiError(409, 'ORDER_ACCEPT_WINDOW_EXPIRED', 'The acceptance window for this order has closed.')],
    ]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: /^accept$/i }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /accept order/i }));
    expect(await within(dialog).findByText(/acceptance window for this order has closed/i)).toBeInTheDocument();
  });

  it('offers no accept/reject once the window has passed (the server returns no transitions)', async () => {
    mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder({ acceptBy: new Date(Date.now() - 5000).toISOString(), allowedTransitions: [] })], nextCursor: null }]]);
    board();
    const card = await screen.findByRole('listitem', { name: /Order TH-/ });
    expect(within(card).queryByRole('button', { name: /^accept$/i })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^reject$/i })).not.toBeInTheDocument();
    expect(within(card).getByText(/rejected automatically and refunded/i)).toBeInTheDocument();
  });

  it.each([
    ['PLACED', ['Accept', 'Reject'], ['Start preparing', 'Mark ready', 'Update prep time']],
    ['ACCEPTED', ['Start preparing', 'Mark ready', 'Update prep time'], ['Accept', 'Reject']],
    ['PREPARING', ['Mark ready', 'Update prep time'], ['Start preparing', 'Accept', 'Reject']],
    ['READY_FOR_PICKUP', [], ['Accept', 'Reject', 'Start preparing', 'Mark ready', 'Update prep time']],
  ] as const)('%s: shows exactly the allowed actions', async (status, shown, hidden) => {
    mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder({ status })], nextCursor: null }]]);
    board();
    const card = await screen.findByRole('listitem', { name: /Order TH-/ });
    for (const name of shown) expect(within(card).getByRole('button', { name })).toBeInTheDocument();
    for (const name of hidden) expect(within(card).queryByRole('button', { name })).not.toBeInTheDocument();
    if (status === 'READY_FOR_PICKUP') {
      expect(within(card).queryAllByRole('button')).toHaveLength(0);
      expect(within(card).getByText(/waiting for the delivery partner/i)).toBeInTheDocument();
    }
  });

  it('resolves customization names from the menu', async () => {
    const order = makeOrder({ lines: [{ itemId: 'i1', name: 'Chicken Biryani', quantity: 1, selections: [{ groupId: 'g1', optionIds: ['o2'] }] }] });
    mockApi([
      ['GET', /^\/owner\/orders$/, { items: [order], nextCursor: null }],
      ['GET', /items$/, { items: [{ id: 'i1', customizationGroups: [{ id: 'g1', options: [{ id: 'o1', name: 'Half' }, { id: 'o2', name: 'Full plate' }] }] }] }],
    ]);
    board();
    expect(await screen.findByText('Full plate')).toBeInTheDocument();
  });

  it('chimes for a new order that arrives after the first load, once sound is armed by a click', async () => {
    const starts = vi.fn();
    class FakeAudioContext {
      state = 'suspended';
      currentTime = 0;
      destination = {};
      resume() {
        this.state = 'running';
        return Promise.resolve();
      }
      createOscillator() {
        return { type: '', frequency: { value: 0 }, connect: (n: unknown) => n, start: starts, stop: vi.fn() };
      }
      createGain() {
        return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (n: unknown) => n };
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    let items = [makeOrder()];
    mockApi([['GET', /^\/owner\/orders$/, () => json({ items, nextCursor: null })]]);
    const user = userEvent.setup();
    const { queryClient } = board();

    await screen.findByRole('listitem', { name: 'Order TH-8K2M4Q7A' });
    expect(starts).not.toHaveBeenCalled(); // the order present at load is the baseline, not "new"

    await user.click(screen.getByRole('button', { name: /enable order sound/i }));
    expect(await screen.findByRole('button', { name: /order sound on/i })).toBeInTheDocument();

    items = [makeOrder(), makeOrder({ id: 'o2', code: 'TH-NEWORDER2', placedAt: new Date(Date.now() + 1000).toISOString() })];
    await queryClient.invalidateQueries({ queryKey: ['owner', 'orders', 'r1'] });
    const fresh = await screen.findByRole('listitem', { name: 'Order TH-NEWORDER2' });
    await waitFor(() => expect(starts).toHaveBeenCalledTimes(2)); // a two-note chime, once
    expect(within(fresh).getByText('New')).toBeInTheDocument();
    expect(screen.getByText(/new order: TH-NEWORDER2/i)).toBeInTheDocument();
  });

  it('does not chime when sound was never enabled', async () => {
    const starts = vi.fn();
    (window as unknown as { AudioContext: unknown }).AudioContext = class {
      state = 'running';
      createOscillator() { return { start: starts }; }
    };
    let items = [makeOrder()];
    mockApi([['GET', /^\/owner\/orders$/, () => json({ items, nextCursor: null })]]);
    const { queryClient } = board();
    await screen.findByRole('listitem', { name: 'Order TH-8K2M4Q7A' });
    items = [...items, makeOrder({ id: 'o2', code: 'TH-NEWORDER2' })];
    await queryClient.invalidateQueries({ queryKey: ['owner', 'orders', 'r1'] });
    await screen.findByRole('listitem', { name: 'Order TH-NEWORDER2' });
    expect(starts).not.toHaveBeenCalled();
  });

  it('falls back to polling every 10 s when the realtime stream is not live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder()], nextCursor: null }]]);
    board();
    await screen.findByRole('listitem', { name: /Order TH-/ });
    const count = () => api.find('GET', /^\/owner\/orders$/).length;
    const before = count();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(count()).toBe(before);
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(count()).toBeGreaterThan(before));
    expect(screen.getByText(/refreshing every 10 s/i)).toBeInTheDocument();
  });

  it('shows the pickup code for accepted orders and offers preparing / ready / prep-time actions', async () => {
    mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder({ status: 'ACCEPTED', acceptBy: null, prepMinutes: 20, readyEta: new Date(Date.now() + 20 * 60_000).toISOString() })], nextCursor: null }]]);
    board();
    const card = await screen.findByRole('listitem', { name: /Order TH-/ });
    expect(within(card).getByTestId('pickup-code')).toHaveTextContent('4821');
    expect(within(card).getByRole('button', { name: /start preparing/i })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /mark ready/i })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /update prep time/i })).toBeInTheDocument();
  });

  it('does not show the pickup code for a new, unaccepted order', async () => {
    mockApi([['GET', /^\/owner\/orders$/, { items: [makeOrder()], nextCursor: null }]]);
    board();
    await screen.findByRole('listitem', { name: /Order TH-/ });
    expect(screen.queryByTestId('pickup-code')).not.toBeInTheDocument();
  });

  it('marks an accepted order ready', async () => {
    const api = mockApi([
      ['GET', /^\/owner\/orders$/, { items: [makeOrder({ status: 'PREPARING', acceptBy: null })], nextCursor: null }],
      ['POST', /ready$/, () => json(makeOrder({ status: 'READY_FOR_PICKUP' }))],
    ]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: /mark ready/i }));
    await waitFor(() => expect(api.find('POST', /\/owner\/orders\/o1\/ready$/)).toHaveLength(1));
  });

  it('shows an empty state, and an error state with retry', async () => {
    mockApi([['GET', /^\/owner\/orders$/, { items: [], nextCursor: null }]]);
    const first = board();
    expect(await screen.findByText(/no active orders/i)).toBeInTheDocument();
    first.unmount();

    mockApi([['GET', /^\/owner\/orders$/, () => apiError(503, 'UPSTREAM_UNAVAILABLE', 'down')]]);
    board();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it("doesn't load orders for a restaurant that isn't approved yet", async () => {
    const api = mockApi([]);
    board(makeRestaurant({ status: 'APPROVAL_PENDING' }));
    expect(await screen.findByText(/orders start once you're approved/i)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('does not play sound before the owner has enabled it', () => {
    expect(playOrderChime()).toBe(false);
  });
});
