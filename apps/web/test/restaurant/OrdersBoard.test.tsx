import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrdersBoard from '../../src/features/restaurant/OrdersBoard';
import { playOrderChime, setSoundEnabled } from '../../src/features/restaurant/orderStream';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, json, makeDashboard, makeOrder, makeRestaurant, mockApi, withRestaurant } from './fixtures';

const auth = () => makeAuth({ roles: ['RESTAURANT_OWNER'] });
const board = (restaurant = makeRestaurant()) => renderWithProviders(withRestaurant(restaurant, <OrdersBoard />), { route: '/restaurant/orders', auth: auth() });
const ORDERS = /^\/owner\/orders$/;
const DASH: [string, RegExp, unknown] = ['GET', /\/dashboard$/, makeDashboard()];
const list = (...items: ReturnType<typeof makeOrder>[]) => ({ items, nextCursor: null });

class FakeAudioContext {
  static starts = vi.fn();
  state = 'suspended';
  currentTime = 0;
  destination = {};
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  createOscillator() {
    return { type: '', frequency: { value: 0 }, connect: (n: unknown) => n, start: FakeAudioContext.starts, stop: vi.fn() };
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (n: unknown) => n };
  }
}

afterEach(() => {
  setSoundEnabled(false);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeAudioContext.starts.mockReset();
});

describe('OrdersBoard (board 20)', () => {
  it('lays out the kanban: New = PLACED, Preparing = ACCEPTED + PREPARING, Ready = READY_FOR_PICKUP, for this restaurant only', async () => {
    const api = mockApi([
      ['GET', ORDERS, list(makeOrder(), makeOrder({ id: 'o2', code: 'TH-ACCEPTED', status: 'ACCEPTED' }), makeOrder({ id: 'o3', code: 'TH-PREPARIN', status: 'PREPARING' }), makeOrder({ id: 'o4', code: 'TH-READYYYY', status: 'READY_FOR_PICKUP' }))],
      DASH,
    ]);
    board();
    const newCol = await screen.findByRole('region', { name: 'New, 1' }, { timeout: 5000 });
    expect(within(newCol).getByRole('listitem', { name: 'New order TH-8K2M4Q7A' })).toBeInTheDocument();
    const prep = screen.getByRole('region', { name: 'Preparing, 2' });
    expect(within(prep).getByRole('listitem', { name: 'Order TH-ACCEPTED' })).toBeInTheDocument();
    expect(within(prep).getByRole('listitem', { name: 'Order TH-PREPARIN' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Ready for pickup, 1' })).getByRole('listitem', { name: 'Order TH-READYYYY' })).toBeInTheDocument();
    const q = decodeURIComponent(api.find('GET', ORDERS)[0]!.search);
    expect(q).toContain('restaurantId=r1');
    expect(q).toContain('status=PLACED,ACCEPTED,PREPARING,READY_FOR_PICKUP');
  });

  it('new card: countdown ring, items with option names, note, masked phone', async () => {
    const order = makeOrder({ lines: [{ itemId: 'i1', name: 'Chicken Dum Biryani', isVeg: false, quantity: 2, addOns: [{ name: 'Full' }, { name: 'Extra raita' }], note: 'less spicy please' }] });
    mockApi([['GET', ORDERS, list(order)], DASH]);
    board();
    const card = await screen.findByRole('listitem', { name: /New order/ });
    expect(within(card).getByRole('timer')).toHaveTextContent(/^(4:[5-9]\d|5:00)$/);
    expect(within(card).getByRole('timer')).toHaveAttribute('data-danger', 'false');
    expect(within(card).getByText('Chicken Dum Biryani')).toBeInTheDocument();
    expect(within(card).getByText('Full · Extra raita')).toBeInTheDocument();
    expect(within(card).getByText('Note: less spicy please')).toBeInTheDocument();
    expect(within(card).getByText(/Asha · \+91 ••••• •3210/)).toBeInTheDocument();
  });

  it('turns the ring red in the last 60 s', async () => {
    mockApi([['GET', ORDERS, list(makeOrder({ acceptBy: new Date(Date.now() + 45_000).toISOString() }))], DASH]);
    board();
    const timer = await screen.findByRole('timer');
    expect(timer).toHaveAttribute('data-danger', 'true');
  });

  it('accepts with the chosen prep pill (default = restaurant average) via POST accept {prepMinutes}', async () => {
    const api = mockApi([
      ['GET', ORDERS, list(makeOrder())],
      DASH,
      ['POST', /\/owner\/orders\/o1\/accept$/, () => json(makeOrder({ status: 'ACCEPTED', prepMinutes: 30 }))],
    ]);
    const user = userEvent.setup();
    board();
    const card = await screen.findByRole('listitem', { name: /New order/ });
    expect(within(card).getByRole('button', { name: '20 min' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(card).getByRole('button', { name: '30 min' }));
    await user.click(within(card).getByRole('button', { name: 'Accept · 30 min' }));
    await waitFor(() => expect(api.find('POST', /accept$/)).toHaveLength(1));
    expect(api.find('POST', /accept$/)[0]!.body).toEqual({ prepMinutes: 30 });
  });

  it('offers other prep times (25, 40, 45, 60, 90) from "Other…"', async () => {
    const api = mockApi([['GET', ORDERS, list(makeOrder())], DASH, ['POST', /accept$/, () => json(makeOrder({ status: 'ACCEPTED' }))]]);
    const user = userEvent.setup();
    board();
    const card = await screen.findByRole('listitem', { name: /New order/ });
    await user.selectOptions(within(card).getByLabelText('Other prep time'), '45');
    await user.click(within(card).getByRole('button', { name: 'Accept · 45 min' }));
    await waitFor(() => expect(api.find('POST', /accept$/)[0]?.body).toEqual({ prepMinutes: 45 }));
  });

  it('a failed accept (window closed / taken) toasts the server message and refetches', async () => {
    const api = mockApi([
      ['GET', ORDERS, list(makeOrder())],
      DASH,
      ['POST', /accept$/, () => apiError(409, 'ORDER_ACCEPT_WINDOW_EXPIRED', 'The accept window has passed.')],
    ]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: /^Accept · 20 min$/ }));
    expect(await screen.findByText('The accept window has passed.')).toBeInTheDocument();
    await waitFor(() => expect(api.find('GET', ORDERS).length).toBeGreaterThan(1));
  });

  it('reject → reason mode: a preset reason rejects immediately; Back returns', async () => {
    const api = mockApi([
      ['GET', ORDERS, list(makeOrder())],
      DASH,
      ['POST', /\/owner\/orders\/o1\/reject$/, () => json(makeOrder({ status: 'REJECTED' }))],
    ]);
    const user = userEvent.setup();
    board();
    const card = await screen.findByRole('listitem', { name: /New order/ });
    await user.click(within(card).getByRole('button', { name: 'Reject' }));
    expect(within(card).getByText('(required)')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Back' }));
    expect(within(card).getByRole('button', { name: /Accept · 20 min/ })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Reject' }));
    await user.click(within(card).getByRole('button', { name: 'Kitchen busy' }));
    await waitFor(() => expect(api.find('POST', /reject$/)).toHaveLength(1));
    expect(api.find('POST', /reject$/)[0]!.body).toEqual({ reason: 'Kitchen busy' });
  });

  it('"Other…" needs a typed reason before "Reject order"', async () => {
    const api = mockApi([['GET', ORDERS, list(makeOrder())], DASH, ['POST', /reject$/, () => json(makeOrder({ status: 'REJECTED' }))]]);
    const user = userEvent.setup();
    board();
    const card = await screen.findByRole('listitem', { name: /New order/ });
    await user.click(within(card).getByRole('button', { name: 'Reject' }));
    await user.click(within(card).getByRole('button', { name: 'Other…' }));
    const confirm = within(card).getByRole('button', { name: 'Reject order' });
    expect(confirm).toBeDisabled();
    await user.type(within(card).getByLabelText(/tell the customer what happened/i), 'Gas cylinder ran out');
    await user.click(confirm);
    await waitFor(() => expect(api.find('POST', /reject$/)[0]?.body).toEqual({ reason: 'Gas cylinder ran out' }));
  });

  it('shows "Rejected · the customer is being refunded" after a rejection removes the order', async () => {
    let items = [makeOrder()];
    mockApi([
      ['GET', ORDERS, () => json(list(...items))],
      DASH,
      ['POST', /reject$/, () => {
        items = [];
        return json(makeOrder({ status: 'REJECTED' }));
      }],
    ]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Out of stock' }));
    expect(await screen.findByText('Rejected · the customer is being refunded')).toBeInTheDocument();
  });

  it('once the accept window has passed the card becomes "Auto-rejected" with no actions', async () => {
    mockApi([['GET', ORDERS, list(makeOrder({ acceptBy: new Date(Date.now() - 5000).toISOString(), allowedTransitions: [] }))], DASH]);
    board();
    expect(await screen.findByText('Auto-rejected — the accept window passed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Accept/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('preparing card (ACCEPTED): progress from acceptedAt + readyEta, "Finding partner", primary Start preparing, Skip to ready', async () => {
    const acceptedAt = new Date(Date.now() - 13 * 60_000 - 30_000).toISOString();
    const api = mockApi([
      ['GET', ORDERS, list(makeOrder({ status: 'ACCEPTED', acceptBy: null, acceptedAt, prepMinutes: 20, readyEta: new Date(Date.parse(acceptedAt) + 20 * 60_000).toISOString() }))],
      DASH,
      ['POST', /\/owner\/orders\/o1\/ready$/, () => json(makeOrder({ status: 'READY_FOR_PICKUP' }))],
      ['POST', /\/owner\/orders\/o1\/preparing$/, () => json(makeOrder({ status: 'PREPARING' }))],
    ]);
    const user = userEvent.setup();
    board();
    const card = await screen.findByRole('listitem', { name: 'Order TH-8K2M4Q7A' });
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '13');
    expect(within(card).getByText('13 of 20 min')).toBeInTheDocument();
    expect(within(card).getByText('Finding partner')).toBeInTheDocument();
    expect(within(card).getByText('2× Chicken Biryani · 1× Paneer Tikka')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Mark ready' })).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Start preparing' }));
    await waitFor(() => expect(api.find('POST', /preparing$/)).toHaveLength(1));
    await user.click(within(card).getByRole('button', { name: 'Skip to ready' }));
    await waitFor(() => expect(api.find('POST', /ready$/)).toHaveLength(1));
  });

  it('PREPARING: the primary action is Mark ready', async () => {
    const api = mockApi([
      ['GET', ORDERS, list(makeOrder({ status: 'PREPARING', acceptBy: null }))],
      DASH,
      ['POST', /\/owner\/orders\/o1\/ready$/, () => json(makeOrder({ status: 'READY_FOR_PICKUP' }))],
    ]);
    const user = userEvent.setup();
    board();
    const card = await screen.findByRole('listitem', { name: 'Order TH-8K2M4Q7A' });
    expect(within(card).queryByRole('button', { name: 'Start preparing' })).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Mark ready' }));
    await waitFor(() => expect(api.find('POST', /ready$/)).toHaveLength(1));
  });

  it('the New card has the accent border and other cards the hairline (no class-order reliance)', async () => {
    mockApi([['GET', ORDERS, list(makeOrder(), makeOrder({ id: 'o2', code: 'TH-PREPARIN', status: 'PREPARING' }))], DASH]);
    board();
    const fresh = await screen.findByRole('listitem', { name: /New order/ });
    expect(fresh.className).toContain('border-acc');
    expect(fresh.className).not.toContain('border-line');
    const prep = screen.getByRole('listitem', { name: 'Order TH-PREPARIN' });
    expect(prep.className).toContain('border-line');
    expect(prep.className).not.toContain('border-acc');
  });

  it('shows only "Start preparing" when the server only allows PREPARING, and the partner name once assigned', async () => {
    mockApi([
      ['GET', ORDERS, list(makeOrder({ status: 'ACCEPTED', acceptBy: null, allowedTransitions: ['PREPARING'], deliveryStatus: 'ASSIGNED', partner: { name: 'Imran Khan', vehicleType: 'BIKE' } }))],
      DASH,
    ]);
    board();
    const card = await screen.findByRole('listitem', { name: 'Order TH-8K2M4Q7A' });
    expect(within(card).getByRole('button', { name: 'Start preparing' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Mark ready' })).not.toBeInTheDocument();
    expect(within(card).getByText('Imran assigned')).toBeInTheDocument();
  });

  it('changes the prep time with PATCH prep-time {prepMinutes}', async () => {
    const api = mockApi([
      ['GET', ORDERS, list(makeOrder({ status: 'PREPARING', acceptBy: null, prepMinutes: 20 }))],
      DASH,
      ['PATCH', /\/owner\/orders\/o1\/prep-time$/, () => json(makeOrder({ status: 'PREPARING' }))],
    ]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: 'Change time' }));
    const panel = screen.getByRole('dialog', { name: /change prep time/i });
    await user.click(within(panel).getByRole('button', { name: '30 min' }));
    await user.click(within(panel).getByRole('button', { name: 'Update · 30 min' }));
    await waitFor(() => expect(api.find('PATCH', /prep-time$/)[0]?.body).toEqual({ prepMinutes: 30 }));
  });

  it('ready card: pickup code boxes and "Ravi · at restaurant" when deliveryStatus is AT_PICKUP', async () => {
    mockApi([
      ['GET', ORDERS, list(makeOrder({ status: 'READY_FOR_PICKUP', acceptBy: null, deliveryStatus: 'AT_PICKUP', partner: { name: 'Ravi', vehicleType: 'BIKE' } }))],
      DASH,
    ]);
    board();
    const card = await screen.findByRole('listitem', { name: 'Order TH-8K2M4Q7A' });
    expect(within(card).getByRole('group', { name: 'Pickup code 4 8 2 1' })).toBeInTheDocument();
    // the rider enters the restaurant's code in the partner app (ActiveDelivery), so the owner gives it to them
    expect(within(card).getByText(/give this code to the rider/i)).toBeInTheDocument();
    expect(within(card).queryByText(/rider tells you/i)).not.toBeInTheDocument();
    expect(within(card).getByText('Ravi · at restaurant')).toBeInTheDocument();
    expect(within(card).getByText('Partner assigned')).toBeInTheDocument();
    expect(within(card).queryAllByRole('button').map((b) => b.textContent)).toEqual(['TH-8K2M4Q7A']);
  });

  it('never shows the pickup code on a new order', async () => {
    mockApi([['GET', ORDERS, list(makeOrder())], DASH]);
    board();
    await screen.findByRole('listitem', { name: /New order/ });
    expect(screen.queryByRole('group', { name: /Pickup code/ })).not.toBeInTheDocument();
  });

  it('opens the order detail dialog from the card (GET /owner/orders/:id)', async () => {
    const api = mockApi([
      ['GET', ORDERS, list(makeOrder({ status: 'PREPARING', acceptBy: null }))],
      DASH,
      ['GET', /^\/owner\/orders\/o1$/, () => json(makeOrder({ status: 'PREPARING', statusHistory: [{ from: null, to: 'PLACED', actor: 'SYSTEM', reason: null, at: new Date().toISOString() }] }))],
    ]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: 'Order TH-8K2M4Q7A, view details' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(api.find('GET', /^\/owner\/orders\/o1$/)).toHaveLength(1));
    expect(await within(dialog).findByText('Timeline')).toBeInTheDocument();
    expect(within(dialog).getByText('Paneer Tikka')).toBeInTheDocument();
  });

  it('header: KPIs from the dashboard, open-state chip, Chime toggle and Pause', async () => {
    mockApi([['GET', ORDERS, list()], DASH]);
    board();
    expect(await screen.findByText('Open · accepting')).toBeInTheDocument();
    expect(screen.getByText('87.5%')).toBeInTheDocument();
    expect(screen.getByText('1m 35s')).toBeInTheDocument();
    expect(screen.getByText('₹6,400')).toBeInTheDocument();
    expect(screen.getByText('/ ₹5,120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /chime off/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Pause orders' })).toBeInTheDocument();
  });

  it('KPIs say "Stats unavailable · Retry" (never zeros) when the orders service is down', async () => {
    const api = mockApi([['GET', ORDERS, list()], ['GET', /\/dashboard$/, makeDashboard({ orders: null, ordersAvailable: false })]]);
    const user = userEvent.setup();
    board();
    expect(await screen.findAllByText(/stats unavailable/i)).toHaveLength(4);
    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    await waitFor(() => expect(api.find('GET', /dashboard$/).length).toBeGreaterThan(1));
  });

  it('pauses for the chosen minutes from the Pause popover', async () => {
    const api = mockApi([
      ['GET', ORDERS, list()],
      DASH,
      ['POST', /\/owner\/restaurants\/r1\/pause$/, () => json(makeRestaurant({ pausedUntil: new Date(Date.now() + 15 * 60_000).toISOString() }))],
    ]);
    const user = userEvent.setup();
    board();
    await user.click(await screen.findByRole('button', { name: 'Pause orders' }));
    await user.click(screen.getByRole('button', { name: '15 min' }));
    await user.click(screen.getByRole('button', { name: 'Pause for 15 min' }));
    await waitFor(() => expect(api.find('POST', /pause$/)[0]?.body).toEqual({ minutes: 15 }));
  });

  it('when paused the action is "Resume orders" (POST resume) and the chip says until when', async () => {
    const api = mockApi([['GET', ORDERS, list()], DASH, ['POST', /resume$/, () => json(makeRestaurant())]]);
    const user = userEvent.setup();
    board(makeRestaurant({ pausedUntil: new Date(Date.now() + 30 * 60_000).toISOString() }));
    expect(await screen.findByText(/^Paused until/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume orders' }));
    await waitFor(() => expect(api.find('POST', /resume$/)).toHaveLength(1));
  });

  it('Chime on: a click unlocks audio and plays a test chime; a new order afterwards chimes and is announced', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    let items = [makeOrder()];
    mockApi([['GET', ORDERS, () => json(list(...items))], DASH]);
    const user = userEvent.setup();
    const { queryClient } = board();
    await screen.findByRole('listitem', { name: 'New order TH-8K2M4Q7A' });
    expect(FakeAudioContext.starts).not.toHaveBeenCalled(); // the order present at load is the baseline

    await user.click(screen.getByRole('button', { name: /chime off/i }));
    expect(await screen.findByRole('button', { name: /chime on/i })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(FakeAudioContext.starts).toHaveBeenCalledTimes(2)); // test chime (two notes)
    expect(localStorage.getItem('thali.restaurant.sound')).toBe('1');

    items = [makeOrder(), makeOrder({ id: 'o2', code: 'TH-NEWORDER2', placedAt: new Date(Date.now() + 1000).toISOString() })];
    await queryClient.invalidateQueries({ queryKey: ['owner', 'orders', 'r1'] });
    await screen.findByRole('listitem', { name: 'New order TH-NEWORDER2' });
    await waitFor(() => expect(FakeAudioContext.starts).toHaveBeenCalledTimes(4));
    expect(screen.getByText(/new order: TH-NEWORDER2/i)).toBeInTheDocument();
  });

  it('does not chime when the chime is off', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    let items = [makeOrder()];
    mockApi([['GET', ORDERS, () => json(list(...items))], DASH]);
    const { queryClient } = board();
    await screen.findByRole('listitem', { name: /New order/ });
    items = [...items, makeOrder({ id: 'o2', code: 'TH-NEWORDER2' })];
    await queryClient.invalidateQueries({ queryKey: ['owner', 'orders', 'r1'] });
    await screen.findByRole('listitem', { name: 'New order TH-NEWORDER2' });
    expect(FakeAudioContext.starts).not.toHaveBeenCalled();
    expect(playOrderChime()).toBe(false);
  });

  it('falls back to polling every 10 s when the realtime stream is not live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi([['GET', ORDERS, list(makeOrder())], DASH]);
    board();
    await screen.findByRole('listitem', { name: /New order/ });
    const count = () => api.find('GET', ORDERS).length;
    const before = count();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(count()).toBe(before);
    await vi.advanceTimersByTimeAsync(2_500);
    await waitFor(() => expect(count()).toBeGreaterThan(before));
    expect(screen.getByText(/refreshing every 10 s/i)).toBeInTheDocument();
  });

  it('empty columns explain themselves; a load failure offers retry', async () => {
    mockApi([['GET', ORDERS, list()], DASH]);
    const first = board();
    expect(await screen.findByText('No new orders')).toBeInTheDocument();
    expect(screen.getByText('New orders appear here with a chime.')).toBeInTheDocument();
    first.unmount();

    mockApi([['GET', ORDERS, () => apiError(503, 'UPSTREAM_UNAVAILABLE', 'down')], DASH]);
    board();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('phones: the kanban becomes segmented tabs', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
    mockApi([['GET', ORDERS, list(makeOrder(), makeOrder({ id: 'o4', code: 'TH-READYYYY', status: 'READY_FOR_PICKUP' }))], DASH]);
    const user = userEvent.setup();
    board();
    const tabs = await screen.findByRole('tablist', { name: 'Order status' });
    expect(within(tabs).getByRole('tab', { name: /New/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('listitem', { name: /New order/ })).toBeInTheDocument();
    await user.click(within(tabs).getByRole('tab', { name: /Ready/ }));
    expect(screen.getByRole('listitem', { name: 'Order TH-READYYYY' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: /New order/ })).not.toBeInTheDocument();
  });

  it("doesn't load orders for a restaurant that isn't approved yet", async () => {
    const api = mockApi([]);
    board(makeRestaurant({ status: 'APPROVAL_PENDING' }));
    expect(await screen.findByText(/orders start once you're approved/i)).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
});
