import '../setup';
import './slow';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocationPicker } from '../../src/features/consumer/LocationPicker';
import { getLocation } from '../../src/features/consumer/location';
import { renderWithProviders } from '../utils';
import { mockApi } from './fetchMock';

vi.mock('../../src/components/ui/Map', () => ({
  MapView: (p: { onPick?: (pt: { lat: number; lng: number }) => void; ariaLabel?: string }) => (
    <div data-testid="map" aria-label={p.ariaLabel}>
      <button type="button" onClick={() => p.onPick?.({ lat: 12.98, lng: 77.6 })}>
        Pin map centre
      </button>
    </div>
  ),
}));

function stubGeolocation(errorCode: number | null) {
  const getCurrentPosition = vi.fn((ok: PositionCallback, fail?: PositionErrorCallback) => {
    if (errorCode === null) {
      ok({ coords: { latitude: 12.97, longitude: 77.59, accuracy: 15 }, timestamp: Date.now() } as GeolocationPosition);
    } else {
      fail?.({ code: errorCode, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
    }
  });
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
  return getCurrentPosition;
}

describe('LocationPicker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('permission denied -> explains and points to the manual map pin', async () => {
    mockApi({ 'GET /discovery/serviceability': { serviceable: true, area: { id: 'a', name: 'Central', minOrderPaise: 0 } } });
    stubGeolocation(1);
    renderWithProviders(<LocationPicker onDone={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /use my current location/i }));
    expect(await screen.findByText(/location access is blocked/i)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/drop a pin on the map/i);
    expect(screen.getByText('Or drop a pin on the map')).toBeInTheDocument();
    expect(screen.getByTestId('map')).toBeInTheDocument();
  });

  it('manual pin -> confirms and persists the selection', async () => {
    mockApi({ 'GET /discovery/serviceability': { serviceable: true, area: { id: 'a', name: 'Central', minOrderPaise: 0 } } });
    stubGeolocation(1);
    const onDone = vi.fn();
    renderWithProviders(<LocationPicker onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: /pin map centre/i }));
    await userEvent.click(await screen.findByRole('button', { name: /deliver here/i }));
    expect(onDone).toHaveBeenCalled();
    expect(getLocation()).toMatchObject({ lat: 12.98, lng: 77.6, source: 'pin' });
  });

  it('warns when the pinned point is not serviceable', async () => {
    mockApi({ 'GET /discovery/serviceability': { serviceable: false, area: null } });
    stubGeolocation(null);
    renderWithProviders(<LocationPicker onDone={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /use my current location/i }));
    expect(await screen.findByText(/we don.t deliver here yet/i)).toBeInTheDocument();
  });
});
