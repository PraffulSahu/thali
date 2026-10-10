import '../setup';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocationTracking } from '../../src/features/partner/useLocationTracking';

type PosCb = (p: GeolocationPosition) => void;
type ErrCb = (e: GeolocationPositionError) => void;

let onPos: PosCb;
let onErr: ErrCb;
const watchPosition = vi.fn((ok: PosCb, err: ErrCb) => {
  onPos = ok;
  onErr = err;
  return 42;
});
const clearWatch = vi.fn();
const fetchMock = vi.fn();

const fix = (lat = 12.9, lng = 77.6): GeolocationPosition =>
  ({ coords: { latitude: lat, longitude: lng, accuracy: 12 }, timestamp: Date.now() }) as GeolocationPosition;

const ok = () => new Response(JSON.stringify({ at: new Date().toISOString(), jobsUpdated: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
const posts = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T10:00:00Z'));
  watchPosition.mockClear();
  clearWatch.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ok());
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { watchPosition, clearWatch, getCurrentPosition: vi.fn() } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = async (ms: number) => {
  vi.setSystemTime(Date.now() + ms);
  await act(async () => {
    onPos(fix());
  });
};

describe('useLocationTracking', () => {
  it('does not watch while offline', () => {
    renderHook(() => useLocationTracking({ enabled: false }));
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it('throttles to one POST /partner/location per 5 s', async () => {
    const { result } = renderHook(() => useLocationTracking({ enabled: true }));
    expect(watchPosition).toHaveBeenCalledTimes(1);

    await act(async () => {
      onPos(fix());
    });
    expect(posts()).toEqual(['/api/v1/partner/location']);
    expect(result.current.status).toBe('active');
    expect(result.current.lastSentAt).not.toBeNull();

    await tick(1_000);
    await tick(2_000); // 3 s since the last send
    await tick(1_900); // 4.9 s
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tick(200); // 5.1 s
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops watching and sending when switched offline or unmounted', async () => {
    const { rerender, result, unmount } = renderHook((p: { enabled: boolean }) => useLocationTracking(p), { initialProps: { enabled: true } });
    await act(async () => {
      onPos(fix());
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    expect(clearWatch).toHaveBeenCalledWith(42);
    expect(result.current.status).toBe('off');

    await tick(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ enabled: true });
    expect(watchPosition).toHaveBeenCalledTimes(2);
    unmount();
    expect(clearWatch).toHaveBeenCalledTimes(2);
  });

  it('reports denied permission and a paused state on position errors', async () => {
    const { result } = renderHook(() => useLocationTracking({ enabled: true }));
    await act(async () => {
      onErr({ code: 2, message: 'unavailable' } as GeolocationPositionError);
    });
    expect(result.current.status).toBe('paused');
    await act(async () => {
      onErr({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    expect(result.current.status).toBe('denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
