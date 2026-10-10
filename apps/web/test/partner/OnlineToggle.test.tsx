import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerProfile } from '../../src/features/partner/api';
import { OnlineToggle } from '../../src/features/partner/OnlineToggle';
import { renderWithProviders } from '../utils';

const partner = (over: Partial<PartnerProfile> = {}): PartnerProfile => ({
  id: 'p1', userId: 'u1', name: 'Ravi', phone: null, vehicle: { type: 'BIKE', registrationNumber: 'KA05MN4321' }, status: 'APPROVED',
  statusReason: null, documents: [], online: false, lastLocation: null, lastLocationAt: null, activeJobIds: [], maxActive: 2, isDemo: false, createdAt: null, ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();
const tracking = { status: 'off', lastSentAt: null, sendError: null, pausedReason: null } as const;

function stubGeo(impl: (ok: PositionCallback, err: PositionErrorCallback) => void) {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: vi.fn(impl), watchPosition: vi.fn(), clearWatch: vi.fn() } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('OnlineToggle', () => {
  it('cannot go online when location permission is denied, and explains why', async () => {
    stubGeo((_ok, err) => err({ code: 1, message: 'denied' } as GeolocationPositionError));
    renderWithProviders(<OnlineToggle partner={partner()} tracking={tracking} activeCount={0} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText(/can't go online without sharing your location/i)).toBeInTheDocument();
    expect(screen.getByText(/allow location in your browser settings/i)).toBeInTheDocument();
    expect(screen.queryByText(/pin/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the real fix to /partner/online once permission is granted', async () => {
    stubGeo((ok) => ok({ coords: { latitude: 12.9, longitude: 77.6, accuracy: 10 }, timestamp: Date.now() } as GeolocationPosition));
    fetchMock.mockResolvedValue(json(200, partner({ online: true })));
    renderWithProviders(<OnlineToggle partner={partner()} tracking={tracking} activeCount={0} />);
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/partner/online');
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ lat: 12.9, lng: 77.6 });
  });

  it('shows sharing active / paused and the last sent time while online', () => {
    const { unmount } = renderWithProviders(<OnlineToggle partner={partner({ online: true })} tracking={{ status: 'active', lastSentAt: Date.now() - 4000, sendError: null, pausedReason: null }} activeCount={0} />);
    expect(screen.getByText('Location sharing active')).toBeInTheDocument();
    expect(screen.getByText(/last sent/i)).toBeInTheDocument();
    unmount();
    renderWithProviders(<OnlineToggle partner={partner({ online: true })} tracking={{ status: 'paused', lastSentAt: null, sendError: null, pausedReason: 'hidden' }} activeCount={0} />);
    expect(screen.getByText('Location sharing paused')).toBeInTheDocument();
    expect(screen.getByText(/background or the screen is locked/i)).toBeInTheDocument();
  });

  it('does not offer going offline during an active delivery and explains why', async () => {
    renderWithProviders(<OnlineToggle partner={partner({ online: true })} tracking={tracking} activeCount={1} />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText(/complete it, or ask thali ops to reassign it/i)).toBeInTheDocument();
  });

  it('maps 409 PARTNER_HAS_ACTIVE_JOBS from /partner/offline to the same explanation', async () => {
    fetchMock.mockResolvedValue(json(409, { error: { code: 'PARTNER_HAS_ACTIVE_JOBS', message: 'x', requestId: 'r' } }));
    renderWithProviders(<OnlineToggle partner={partner({ online: true })} tracking={tracking} activeCount={0} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText(/complete it, or ask thali ops to reassign it/i)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('re-enables the switch once the active deliveries finish after a 409 PARTNER_HAS_ACTIVE_JOBS', async () => {
    fetchMock.mockResolvedValue(json(409, { error: { code: 'PARTNER_HAS_ACTIVE_JOBS', message: 'x', requestId: 'r' } }));
    function Harness() {
      const [count, setCount] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setCount(1)}>job appears</button>
          <button type="button" onClick={() => setCount(0)}>job delivered</button>
          <OnlineToggle partner={partner({ online: true })} tracking={tracking} activeCount={count} />
        </>
      );
    }
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText(/complete it, or ask thali ops to reassign it/i)).toBeInTheDocument();
    // The refetch after the 409 shows the job, then it is delivered.
    await userEvent.click(screen.getByRole('button', { name: 'job appears' }));
    expect(screen.getByRole('switch')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'job delivered' }));
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    expect(screen.queryByText(/complete it, or ask thali ops to reassign it/i)).not.toBeInTheDocument();
    expect(screen.getByText(/switch off to stop receiving offers/i)).toBeInTheDocument();
  });
});
