import '../setup';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveDelivery } from '../../src/features/partner/ActiveDelivery';
import type { PartnerJob } from '../../src/features/partner/api';
import { renderWithProviders } from '../utils';

const job = (over: Partial<PartnerJob> = {}): PartnerJob => ({
  id: 'job1',
  childOrderId: 'co1',
  status: 'AT_PICKUP',
  pickup: { name: 'Meghana Foods', address: '12 Koramangala', location: { lat: 12.93, lng: 77.62 } },
  drop: { name: 'Asha', address: '5 Indiranagar', location: { lat: 12.97, lng: 77.64 }, phoneMasked: '+91 98XXXXX210' },
  distanceKm: 4.2,
  estimatedMinutes: 22,
  estimateSource: 'HAVERSINE_ESTIMATE',
  prepMinutes: 15,
  readyEta: null,
  readyAt: null,
  codeAttemptsRemaining: 5,
  navigation: { pickupUrl: '', dropUrl: '' },
  assignedAt: null,
  pickedUpAt: null,
  deliveredAt: null,
  failureReason: null,
  createdAt: null,
  ...over,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('ActiveDelivery', () => {
  it('shows pickup and drop cards with Google Maps navigation links', () => {
    renderWithProviders(<ActiveDelivery job={job()} />);
    const pickup = screen.getByRole('link', { name: /navigate to pickup/i });
    expect(pickup).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=12.93,77.62');
    const drop = screen.getByRole('link', { name: /navigate to drop/i });
    expect(drop).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=12.97,77.64');
    expect(screen.getByText('+91 98XXXXX210')).toBeInTheDocument();
  });

  it('a wrong pickup code shows the remaining attempts and keeps the dialog open', async () => {
    fetchMock.mockResolvedValue(json(400, { error: { code: 'DELIVERY_CODE_INVALID', message: 'Wrong pickup code', details: { attemptsRemaining: 2 }, requestId: 'r1' } }));
    renderWithProviders(<ActiveDelivery job={job()} />);
    await userEvent.click(screen.getByRole('button', { name: /enter pickup code/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/pickup code/i), '1234');
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm pickup/i }));

    expect(await within(dialog).findByText(/2 attempts remaining/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/deliveries/job1/pickup');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ code: '1234' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the remaining attempts after close/reopen and refreshes the active jobs', async () => {
    fetchMock.mockResolvedValue(json(400, { error: { code: 'DELIVERY_CODE_INVALID', message: 'Wrong pickup code', details: { attemptsRemaining: 2 }, requestId: 'r1' } }));
    const { queryClient } = renderWithProviders(<ActiveDelivery job={job()} />);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.click(screen.getByRole('button', { name: /enter pickup code/i }));
    let dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/pickup code/i), '1234');
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm pickup/i }));
    expect(await within(dialog).findByText(/2 attempts remaining/i)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['partner', 'active'] });

    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /enter pickup code/i }));
    dialog = await screen.findByRole('dialog');
    // job prop still says 5, but the server told us 2
    expect(within(dialog).getByText(/2 attempts remaining/i)).toBeInTheDocument();
  });

  it('locks code entry when the server answers 423', async () => {
    fetchMock.mockResolvedValue(json(423, { error: { code: 'DELIVERY_CODE_LOCKED', message: 'Too many wrong codes. Contact support to continue.', details: { attemptsRemaining: 0 }, requestId: 'r2' } }));
    renderWithProviders(<ActiveDelivery job={job({ status: 'OUT_FOR_DELIVERY' })} />);
    await userEvent.click(screen.getByRole('button', { name: /enter delivery code/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/delivery code/i), '9999');
    await userEvent.click(within(dialog).getByRole('button', { name: /confirm delivery/i }));
    expect(await within(dialog).findByText(/locked/i)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText(/delivery code/i)).toBeDisabled());
  });

  it('marks arrival via the API for an assigned job', async () => {
    fetchMock.mockResolvedValue(json(200, job({ status: 'AT_PICKUP' })));
    const onChanged = vi.fn();
    renderWithProviders(<ActiveDelivery job={job({ status: 'ASSIGNED' })} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: /i've arrived/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/deliveries/job1/arrived');
  });

  it('fails a delivery with a reason', async () => {
    fetchMock.mockResolvedValue(json(200, job({ status: 'FAILED', failureReason: 'Customer unreachable' })));
    renderWithProviders(<ActiveDelivery job={job({ status: 'OUT_FOR_DELIVERY' })} />);
    await userEvent.click(screen.getByRole('button', { name: /can't deliver/i }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.selectOptions(within(dialog).getByLabelText(/reason/i), 'Customer unreachable');
    await userEvent.click(within(dialog).getByRole('button', { name: /mark as failed/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/deliveries/job1/fail');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ reason: 'Customer unreachable' });
  });
});
