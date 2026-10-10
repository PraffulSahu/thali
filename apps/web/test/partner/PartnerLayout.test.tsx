import '../setup';
import { act, screen, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PartnerLayout from '../../src/features/partner/PartnerLayout';
import { makeQueryClient } from '../utils';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const profile = { id: 'p1', userId: 'u1', name: 'R', phone: null, vehicle: { type: 'BIKE', registrationNumber: 'KA05MN4321' }, status: 'APPROVED', statusReason: null, documents: [], online: true, lastLocation: null, lastLocationAt: null, activeJobIds: [], maxActive: 2, isDemo: false, createdAt: null };
const watchPosition = vi.fn(() => 7);
const clearWatch = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  watchPosition.mockClear();
  clearWatch.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json(200, profile));
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition, clearWatch, getCurrentPosition: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

describe('PartnerLayout', () => {
  it('keeps one location watch alive across partner pages while online', async () => {
    const router = createMemoryRouter(
      [{ path: '/partner', element: <PartnerLayout />, children: [
        { index: true, element: <Link to="/partner/history">go history</Link> },
        { path: 'history', element: <p>history page</p> },
      ] }],
      { initialEntries: ['/partner'] },
    );
    render(<QueryClientProvider client={makeQueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(watchPosition).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('link', { name: /go history/i }));
    expect(await screen.findByText('history page')).toBeInTheDocument();
    expect(watchPosition).toHaveBeenCalledTimes(1);
    expect(clearWatch).not.toHaveBeenCalled();
    expect(await screen.findByTestId('tracking-strip')).toHaveTextContent(/location sharing starting/i);
  });

  it('does not watch when the partner is offline', async () => {
    fetchMock.mockResolvedValue(json(200, { ...profile, online: false }));
    const router = createMemoryRouter([{ path: '/partner', element: <PartnerLayout />, children: [{ index: true, element: <p>home</p> }] }], { initialEntries: ['/partner'] });
    render(<QueryClientProvider client={makeQueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
    await screen.findByText('home');
    await act(async () => {});
    expect(watchPosition).not.toHaveBeenCalled();
  });
});
