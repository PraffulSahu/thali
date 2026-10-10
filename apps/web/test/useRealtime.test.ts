import './setup';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtime } from '../src/hooks/useRealtime';
import { createRealtimeClient, RealtimeProvider, type RealtimeClient } from '../src/lib/realtime';

/** Minimal EventSource double: tests drive open / error / named events by hand. */
class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  constructor(public url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  fail() {
    this.readyState = 2;
    this.dispatchEvent(new Event('error'));
  }
  emit(type: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}
const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

let client: RealtimeClient;
const wrapper = ({ children }: { children: ReactNode }) => createElement(RealtimeProvider, { client }, children);

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
});
afterEach(() => {
  client?.dispose();
  vi.useRealTimers();
});

describe('useRealtime', () => {
  it('connects with a ticket, goes live and delivers named events', async () => {
    const fetchTicket = vi.fn().mockResolvedValue('t1');
    client = createRealtimeClient({ fetchTicket, EventSource: FakeEventSource, canConnect: () => true });
    const onEvent = vi.fn();
    const { result } = renderHook(() => useRealtime(['order.updated'], onEvent), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    expect(latest().url).toBe('/api/v1/realtime/stream?ticket=t1');

    act(() => latest().open());
    expect(result.current.status).toBe('live');

    act(() => latest().emit('order.updated', { checkoutId: 'c1', status: 'ACCEPTED' }));
    expect(onEvent).toHaveBeenCalledWith({ type: 'order.updated', data: { checkoutId: 'c1', status: 'ACCEPTED' } });

    act(() => latest().emit('partner.offer', { offerId: 'o1' }));
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('EventSource error -> status polling and fallbackRefetch runs every 10 s; reconnect -> live and polling stops', async () => {
    const fetchTicket = vi.fn().mockResolvedValueOnce('t1').mockRejectedValue(new Error('notifications down'));
    client = createRealtimeClient({ fetchTicket, EventSource: FakeEventSource, canConnect: () => true });
    const fallbackRefetch = vi.fn();
    const { result } = renderHook(() => useRealtime(['order.updated'], () => {}, { fallbackRefetch }), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => latest().open());
    expect(result.current.status).toBe('live');
    const first = latest();

    await act(async () => first.fail());
    expect(first.closed).toBe(true);
    expect(result.current.status).toBe('polling');
    const afterDrop = fallbackRefetch.mock.calls.length;
    expect(afterDrop).toBeGreaterThanOrEqual(1); // immediate resync on drop

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(fallbackRefetch.mock.calls.length).toBeGreaterThanOrEqual(afterDrop + 1);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(fallbackRefetch.mock.calls.length).toBeGreaterThanOrEqual(afterDrop + 2);
    expect(result.current.status).toBe('polling');

    // Service recovers: the next backoff attempt gets a fresh ticket.
    fetchTicket.mockResolvedValue('t2');
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(latest()).not.toBe(first);
    expect(latest().url).toBe('/api/v1/realtime/stream?ticket=t2');
    act(() => latest().open());
    expect(result.current.status).toBe('live');

    const whenLive = fallbackRefetch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fallbackRefetch.mock.calls.length).toBe(whenLive);
  });

  it('polls (without opening a stream) while signed out', async () => {
    const fetchTicket = vi.fn().mockResolvedValue('t1');
    client = createRealtimeClient({ fetchTicket, EventSource: FakeEventSource, canConnect: () => false });
    const fallbackRefetch = vi.fn();
    const { result } = renderHook(() => useRealtime(['order.updated'], () => {}, { fallbackRefetch }), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.status).toBe('polling');
    expect(fetchTicket).not.toHaveBeenCalled();
    expect(fallbackRefetch).toHaveBeenCalled();
  });

  it('closes the stream and stops polling when the last subscriber unmounts', async () => {
    const fetchTicket = vi.fn().mockResolvedValue('t1');
    client = createRealtimeClient({ fetchTicket, EventSource: FakeEventSource, canConnect: () => true });
    const fallbackRefetch = vi.fn();
    const { unmount } = renderHook(() => useRealtime(['order.updated'], () => {}, { fallbackRefetch }), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(0));
    const es = latest();
    unmount();
    expect(es.closed).toBe(true);
    const n = fallbackRefetch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fallbackRefetch.mock.calls.length).toBe(n);
  });

  it('shares one stream between subscribers', async () => {
    const fetchTicket = vi.fn().mockResolvedValue('t1');
    client = createRealtimeClient({ fetchTicket, EventSource: FakeEventSource, canConnect: () => true });
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() => useRealtime(['order.updated'], a), { wrapper });
    renderHook(() => useRealtime(['notification'], b), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => latest().open());
    act(() => latest().emit('notification', { id: 'n1', title: 'Hi', body: '' }));
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });
});
