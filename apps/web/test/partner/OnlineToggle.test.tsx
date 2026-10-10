import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnlineToggle } from '../../src/features/partner/OnlineToggle';
import type { LocationTracking } from '../../src/features/partner/useLocationTracking';
import { renderWithProviders } from '../utils';
import { apiError, bodyOf, json, profile, routeFetch } from './fixtures';

const off: LocationTracking = { status: 'off', lastSentAt: null, sendError: null, pausedReason: null };

function stubGeo(impl: (ok: PositionCallback, err: PositionErrorCallback) => void) {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: vi.fn(impl), watchPosition: vi.fn(), clearWatch: vi.fn() } });
}
afterEach(() => vi.unstubAllGlobals());

describe('OnlineToggle (online card)', () => {
  it('offline copy, then going online asks for location and posts the fix', async () => {
    stubGeo((ok) => ok({ coords: { latitude: 12.97, longitude: 77.64, accuracy: 10 }, timestamp: Date.now() } as GeolocationPosition));
    const fetchMock = routeFetch({ 'POST /partner/online': () => json(200, profile({ online: true })) });
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient } = renderWithProviders(<OnlineToggle partner={profile({ online: false })} tracking={off} activeCount={0} />);
    expect(screen.getByRole('heading', { name: 'You’re offline' })).toBeInTheDocument();
    expect(screen.getByText(/go online to receive offers\. we’ll ask for location permission/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Online' }));
    await waitFor(() => expect(bodyOf(fetchMock, 'POST /partner/online')).toEqual({ lat: 12.97, lng: 77.64 }));
    await waitFor(() => expect(queryClient.getQueryData(['partner', 'profile'])).toMatchObject({ online: true }));
  });

  it('cannot go online when location permission is denied, and explains why (no pin fallback)', async () => {
    stubGeo((_ok, err) => err({ code: 1, message: 'denied' } as GeolocationPositionError));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<OnlineToggle partner={profile({ online: false })} tracking={off} activeCount={0} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText(/can’t go online without sharing your location/i)).toBeInTheDocument();
    expect(screen.getByText(/allow location in your browser settings/i)).toBeInTheDocument();
    expect(screen.queryByText(/pin/i)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('online: "Location sharing active · last sent Ns ago"', () => {
    renderWithProviders(<OnlineToggle partner={profile()} tracking={{ ...off, status: 'active', lastSentAt: Date.now() - 12_000 }} activeCount={0} />);
    expect(screen.getByRole('heading', { name: 'You’re online' })).toBeInTheDocument();
    expect(screen.getByTestId('tracking-status')).toHaveTextContent(/Location sharing active · last sent 1\ds ago/);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('paused: "Location paused — keep Thali open" with the reason', () => {
    renderWithProviders(<OnlineToggle partner={profile()} tracking={{ ...off, status: 'paused', pausedReason: 'hidden', lastSentAt: Date.now() - 40_000 }} activeCount={0} />);
    expect(screen.getByTestId('tracking-status')).toHaveTextContent('Location paused — keep Thali open');
    expect(screen.getByText(/pauses location while this tab is in the background/i)).toBeInTheDocument();
  });

  it('going offline with a delivery: 409 PARTNER_HAS_ACTIVE_JOBS keeps the switch on with the explanation', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'POST /partner/offline': () => apiError(409, 'PARTNER_HAS_ACTIVE_JOBS', 'Complete active deliveries first') }));
    function Harness() {
      const [count, setCount] = useState(1);
      return (
        <>
          <button type="button" onClick={() => setCount(0)}>job delivered</button>
          <OnlineToggle partner={profile()} tracking={off} activeCount={count} />
        </>
      );
    }
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText(/complete it, or ask thali ops to reassign it/i)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'job delivered' }));
    await waitFor(() => expect(screen.queryByText(/complete it, or ask thali ops to reassign it/i)).not.toBeInTheDocument());
  });

  it('going offline posts /partner/offline', async () => {
    const fetchMock = routeFetch({ 'POST /partner/offline': () => json(200, profile({ online: false })) });
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient } = renderWithProviders(<OnlineToggle partner={profile()} tracking={off} activeCount={0} />);
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(queryClient.getQueryData(['partner', 'profile'])).toMatchObject({ online: false }));
  });
});
