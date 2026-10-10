import './setup';
import { act, render, screen } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNow } from '../src/hooks/useNow';

function busyWait(ms: number) {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin: simulate a slow render */
  }
}

let renders = 0;
function SlowClock({ interval }: { interval: number }) {
  const now = useNow(interval);
  renders++;
  busyWait(2);
  return <span data-testid="now">{now}</span>;
}

describe('useNow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    renders = 0;
  });

  it('a single slow subscriber renders without an update loop (stable subscribe, no snapshot reset on subscribe)', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => errors.push(args));
    // Distinct interval so this test owns a fresh ticker.
    const { unmount } = render(<SlowClock interval={60_000} />);
    // Let effects / passive re-subscriptions settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId('now')).toBeInTheDocument();
    expect(errors.filter((e) => String(e).includes('Maximum update depth'))).toEqual([]);
    expect(renders).toBeLessThan(5);
    unmount();
  });

  it('survives StrictMode double-mount and parent re-renders with a slow subscriber', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => errors.push(args));
    function Parent() {
      useEffect(() => {}, []);
      return <SlowClock interval={45_000} />;
    }
    const { rerender, unmount } = render(
      <StrictMode>
        <Parent />
      </StrictMode>,
    );
    for (let i = 0; i < 3; i++) {
      rerender(
        <StrictMode>
          <Parent />
        </StrictMode>,
      );
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(errors.filter((e) => String(e).includes('Maximum update depth'))).toEqual([]);
    unmount();
  });

  it('ticks: subscribers re-render with a new value each interval and share one timer', async () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      function Clock({ id }: { id: string }) {
        const now = useNow(1234);
        return <span data-testid={id}>{now}</span>;
      }
      const { unmount } = render(
        <>
          <Clock id="a" />
          <Clock id="b" />
        </>,
      );
      const first = Number(screen.getByTestId('a').textContent);
      expect(setIntervalSpy.mock.calls.filter((c) => c[1] === 1234)).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(1234);
      });
      const second = Number(screen.getByTestId('a').textContent);
      expect(second).toBeGreaterThan(first);
      expect(screen.getByTestId('b').textContent).toBe(String(second));
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
