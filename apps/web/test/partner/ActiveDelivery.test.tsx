import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveDelivery } from '../../src/features/partner/ActiveDelivery';
import { renderWithProviders } from '../utils';
import { apiError, bodyOf, job, json, revealed, routeFetch } from './fixtures';

const dial = vi.hoisted(() => vi.fn());
vi.mock('../../src/features/partner/dial', () => ({ openDialer: dial }));

let fetchMock: ReturnType<typeof routeFetch>;
function stub(routes: Parameters<typeof routeFetch>[0]) {
  fetchMock = routeFetch(routes);
  vi.stubGlobal('fetch', fetchMock);
}
beforeEach(() => dial.mockReset());
afterEach(() => vi.unstubAllGlobals());

function Harness() {
  const [left, setLeft] = useState(5);
  return (
    <>
      <button type="button" onClick={() => setLeft(1)}>refetch</button>
      <button type="button" onClick={() => setLeft(5)}>stale</button>
      <ActiveDelivery job={job({ status: 'AT_PICKUP', codeAttemptsRemaining: left })} />
    </>
  );
}

const typeCode = async (code: string) => {
  const boxes = screen.getAllByRole('textbox', { name: /digit/i });
  await userEvent.click(boxes[0]!);
  await userEvent.keyboard(code);
};

describe('ActiveDelivery (board 30)', () => {
  it('before pickup: restaurant destination, drop area + label only, Navigate to the pickup, no drop address', () => {
    renderWithProviders(<ActiveDelivery job={job()} index={1} total={2} />);
    expect(screen.getByRole('heading', { name: 'Active delivery 1 of 2' })).toBeInTheDocument();
    expect(screen.getByText('TH-DEMOMULTI')).toBeInTheDocument();
    expect(screen.getByText('Green Leaf')).toBeInTheDocument();
    expect(screen.getByText(/Then drop · HAL 2nd Stage · Home · full address after pickup/)).toBeInTheDocument();
    expect(screen.queryByText(/12th Main/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /navigate to green leaf/i })).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=12.97,77.64');
    // step bar: "At restaurant" is current
    expect(screen.getByRole('list', { name: 'Delivery progress' }).querySelector('[aria-current="step"]')).toHaveTextContent('At restaurant');
    expect(screen.queryByRole('button', { name: /can.t deliver/i })).not.toBeInTheDocument();
  });

  it('"I\'ve arrived" posts /arrived', async () => {
    stub({ 'POST /deliveries/job1/arrived': () => json(200, job({ status: 'AT_PICKUP' })) });
    const onChanged = vi.fn();
    renderWithProviders(<ActiveDelivery job={job()} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'I’ve arrived' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'AT_PICKUP' })));
  });

  it('pickup: "Restaurant\'s pickup code" — Confirm pickup is disabled until 4 digits, then posts the code', async () => {
    stub({ 'POST /deliveries/job1/pickup': () => json(200, job({ status: 'PICKED_UP' })) });
    renderWithProviders(<ActiveDelivery job={job({ status: 'AT_PICKUP' })} />);
    expect(screen.getByRole('group', { name: 'Restaurant’s pickup code' })).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm pickup' });
    expect(confirm).toBeDisabled();
    await typeCode('4821');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(bodyOf(fetchMock, 'POST /deliveries/job1/pickup')).toEqual({ code: '4821' }));
  });

  it('a wrong code shows "Wrong code · N attempts left" from the server and clears the boxes', async () => {
    stub({ 'POST /deliveries/job1/pickup': () => apiError(400, 'DELIVERY_CODE_INVALID', 'Wrong pickup code', { attemptsRemaining: 2 }) });
    const { queryClient } = renderWithProviders(<ActiveDelivery job={job({ status: 'AT_PICKUP' })} />);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await typeCode('1234');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm pickup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong code · 2 attempts left');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['partner', 'active'] });
    expect(screen.getAllByRole('textbox', { name: /digit/i }).every((b) => (b as HTMLInputElement).value === '')).toBe(true);
  });

  it('the wrong-code message survives the refetch that lowers codeAttemptsRemaining', async () => {
    stub({ 'POST /deliveries/job1/pickup': () => apiError(400, 'DELIVERY_CODE_INVALID', 'Wrong pickup code', { attemptsRemaining: 1 }) });
    renderWithProviders(<Harness />);
    await typeCode('1234');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm pickup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong code · 1 attempt left');
    await userEvent.click(screen.getByRole('button', { name: 'refetch' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong code · 1 attempt left');
    // a stale refetch (still 5) never raises the count shown
    await userEvent.click(screen.getByRole('button', { name: 'stale' }));
    expect(screen.getByRole('alert')).toHaveTextContent('1 attempt left');
  });

  it('423 locks code entry with a support message', async () => {
    stub({ 'POST /deliveries/job1/deliver': () => apiError(423, 'DELIVERY_CODE_LOCKED', 'Too many wrong codes. Contact support to continue.', { attemptsRemaining: 0 }) });
    renderWithProviders(<ActiveDelivery job={revealed()} />);
    await typeCode('9999');
    await userEvent.click(screen.getByRole('button', { name: 'Mark delivered' }));
    expect(await screen.findByText(/locked after too many wrong tries/i)).toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: /digit/i })[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeDisabled();
  });

  it('after pickup: the address is revealed, Navigate goes to the drop, attempts hint shows', () => {
    renderWithProviders(<ActiveDelivery job={revealed()} />);
    expect(screen.getByText('Prafful · Home')).toBeInTheDocument();
    expect(screen.getByText(/#402, 12th Main/)).toBeInTheDocument();
    expect(screen.getByText('+91 ••••• •3210')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /navigate to the customer/i })).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=12.96,77.65');
    expect(screen.getByRole('group', { name: 'Customer’s delivery code' })).toBeInTheDocument();
    expect(screen.getByText('5 attempts left · locks after 5 wrong tries')).toBeInTheDocument();
  });

  it('PICKED_UP: Start delivery posts /start', async () => {
    stub({ 'POST /deliveries/job1/start': () => json(200, revealed()) });
    renderWithProviders(<ActiveDelivery job={revealed({ status: 'PICKED_UP' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start delivery' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/v1/deliveries/job1/start')).toBe(true));
  });

  it('Mark delivered posts the customer code', async () => {
    stub({ 'POST /deliveries/job1/deliver': () => json(200, revealed({ status: 'DELIVERED' })) });
    renderWithProviders(<ActiveDelivery job={revealed()} />);
    await typeCode('4719');
    await userEvent.click(screen.getByRole('button', { name: 'Mark delivered' }));
    await waitFor(() => expect(bodyOf(fetchMock, 'POST /deliveries/job1/deliver')).toEqual({ code: '4719' }));
  });

  it("Can't deliver asks for a reason and posts /fail", async () => {
    stub({ 'POST /deliveries/job1/fail': () => json(200, revealed({ status: 'FAILED', failureReason: 'Customer unreachable' })) });
    renderWithProviders(<ActiveDelivery job={revealed()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Can’t deliver' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.selectOptions(within(dialog).getByLabelText(/reason/i), 'Customer unreachable');
    await userEvent.click(within(dialog).getByRole('button', { name: /mark as failed/i }));
    await waitFor(() => expect(bodyOf(fetchMock, 'POST /deliveries/job1/fail')).toEqual({ reason: 'Customer unreachable' }));
  });

  it('Call in DEMO mode shows "Calling is simulated in demo" and never dials', async () => {
    stub({
      'POST /deliveries/job1/contact': () =>
        json(200, { target: 'CUSTOMER', mode: 'DEMO', telUrl: null, displayNumber: '+91 ••••• •3210', expiresAt: '2026-10-11T08:10:00Z', note: 'Calling is simulated in demo' }),
    });
    renderWithProviders(<ActiveDelivery job={revealed()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Call customer' }));
    expect(await screen.findByTestId('contact-note')).toHaveTextContent('Calling is simulated in demo');
    expect(bodyOf(fetchMock, 'POST /deliveries/job1/contact')).toEqual({ target: 'CUSTOMER' });
    expect(dial).not.toHaveBeenCalled();
  });

  it('Call in DIRECT mode opens the dialer with telUrl; before pickup it calls the restaurant', async () => {
    stub({
      'POST /deliveries/job1/contact': () =>
        json(200, { target: 'RESTAURANT', mode: 'DIRECT', telUrl: 'tel:+918041234567', displayNumber: '+91 ••••• •4567', expiresAt: '2026-10-11T08:10:00Z', note: null }),
    });
    renderWithProviders(<ActiveDelivery job={job()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Call restaurant' }));
    await waitFor(() => expect(dial).toHaveBeenCalledWith('tel:+918041234567'));
    expect(bodyOf(fetchMock, 'POST /deliveries/job1/contact')).toEqual({ target: 'RESTAURANT' });
  });

  it('at the restaurant both calls are offered; a 409 NOT_CALLABLE_NOW is explained', async () => {
    stub({ 'POST /deliveries/job1/contact': () => apiError(409, 'CONFLICT', 'You can’t call the customer while the delivery is ASSIGNED', { reason: 'NOT_CALLABLE_NOW' }) });
    renderWithProviders(<ActiveDelivery job={job({ status: 'AT_PICKUP' })} />);
    expect(screen.getByRole('button', { name: 'Call restaurant' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Call customer' }));
    expect(await screen.findByText(/can’t call the customer/i)).toBeInTheDocument();
    expect(dial).not.toHaveBeenCalled();
  });
});
