import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import HealthPage from '../../src/features/admin/HealthPage';
import { makeAuth, renderWithProviders } from '../utils';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const report = {
  checkedAt: '2026-10-10T09:30:00.000Z',
  overall: 'degraded',
  gateway: { status: 'up', mode: 'demo', redis: 'up' },
  services: {
    identity: {
      status: 'up',
      latencyMs: 12,
      details: { service: 'identity', mongo: 'up', redis: 'up', outboxPending: 0, outboxOldestAgeSec: null, consumerLag: {}, deadLetters: 0, providerErrorsLastHour: 0, providerErrorsByProvider: {} },
    },
    delivery: {
      status: 'degraded',
      latencyMs: 40,
      details: { service: 'delivery', mongo: 'up', redis: 'down', outboxPending: 7, outboxOldestAgeSec: 95, consumerLag: { 'order.events': 3 }, deadLetters: 2, providerErrorsLastHour: 4, providerErrorsByProvider: { 'google-routes': 4 } },
    },
    notifications: { status: 'down', latencyMs: 3001, error: 'connect ECONNREFUSED 10.0.0.9:4006', errorCode: 'UPSTREAM_UNAVAILABLE' },
  },
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('HealthPage', () => {
  it('renders a down service in the danger state with the real error and never says healthy', async () => {
    mockFetch((url) => {
      if (url.includes('/admin/health')) return json(report);
      if (url.includes('/dead-letters')) return json({ items: [], errors: [], sources: ['identity'] });
      return json({ items: [], nextCursor: null });
    });
    renderWithProviders(<HealthPage />, { route: '/admin/health', auth: makeAuth({ roles: ['ADMIN'] }) });

    const card = (await screen.findByRole('article', { name: /notifications/i })) as HTMLElement;
    expect(card).toHaveAttribute('data-status', 'down');
    expect(within(card).getByText(/^down$/i)).toBeInTheDocument();
    expect(within(card).getByText(/ECONNREFUSED 10\.0\.0\.9:4006/)).toBeInTheDocument();
    expect(within(card).getByText(/UPSTREAM_UNAVAILABLE/)).toBeInTheDocument();

    // honest details for a degraded service
    const delivery = screen.getByRole('article', { name: /delivery/i });
    expect(delivery).toHaveAttribute('data-status', 'degraded');
    expect(within(delivery).getByText(/redis/i)).toBeInTheDocument();
    expect(within(delivery).getByText(/google-routes/)).toBeInTheDocument();

    expect(screen.getByText(/last checked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
  });

  it('shows an error state with retry (not a green card) when the health call itself fails', async () => {
    mockFetch((url) =>
      url.includes('/admin/health')
        ? json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Gateway cannot reach upstream', requestId: 'req-9' } }, 503)
        : json({ items: [], errors: [], sources: [] }),
    );
    renderWithProviders(<HealthPage />, { route: '/admin/health', auth: makeAuth({ roles: ['ADMIN'] }) });
    expect(await screen.findByText(/reference: req-9/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /try again/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
  });
});
