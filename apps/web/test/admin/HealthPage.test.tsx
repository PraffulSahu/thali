import '../setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HealthPage from '../../src/features/admin/HealthPage';
import { renderWithProviders } from '../utils';
import { adminAuth, healthReport, json, ntfSummary, routeFetch } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

const deadLetter = {
  id: 'dl1', stream: 'events.orders', entryId: '1-0', service: 'payments', envelope: { type: 'order.cancelled' }, error: 'refund provider timeout',
  attempts: 5, failedAt: '2026-10-11T07:00:00.000Z', replayedAt: null, replayCount: 0,
};

function setup(health: () => Response = () => json(healthReport)) {
  const calls = routeFetch([
    ['/admin/health', health],
    ['/admin/notifications/summary', () => json(ntfSummary)],
    ['/admin/notifications/dead-letters/replay', () => json({ replayed: 1, failed: [] })],
    ['/admin/notifications/dead-letters', () => json({ items: [deadLetter], errors: [], sources: ['payments', 'orders'] })],
    ['/admin/notifications/retry', () => json({ queued: 7 })],
    ['/admin/notifications', () => json({ items: [], nextCursor: null })],
  ]);
  renderWithProviders(<HealthPage />, { route: '/admin/health', auth: adminAuth(['OPS']) });
  return calls;
}

describe('HealthPage', () => {
  it('shows each service with its real reason: down = unreachable, failing provider = degraded (never down)', async () => {
    setup();
    const down = await screen.findByRole('row', { name: /delivery service/i });
    expect(down).toHaveAttribute('data-status', 'down');
    expect(within(down).getByText('Down')).toBeInTheDocument();
    expect(within(down).getByText(/ECONNREFUSED 10\.0\.0\.9:4005/)).toBeInTheDocument();
    expect(within(down).getByText(/UPSTREAM_UNAVAILABLE/)).toBeInTheDocument();

    const notif = screen.getByRole('row', { name: /notifications service/i });
    expect(notif).toHaveAttribute('data-status', 'degraded');
    expect(within(notif).getByText('Degraded')).toBeInTheDocument();
    expect(within(notif).getByText(/Email provider failing: SMTP connect/)).toBeInTheDocument();
    expect(within(notif).getByText('email failing')).toBeInTheDocument();

    expect(screen.getByText(/last checked \d+s ago/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
    // NTF-1 counts + last provider error
    expect(await screen.findByText('Failed, last 24 h')).toBeInTheDocument();
    expect(screen.getByText('SMS 2 · email 7')).toBeInTheDocument();
  });

  it('replays every dead letter (NTF-3) and retries every given-up notification (NTF-2)', async () => {
    const user = userEvent.setup();
    const calls = setup();
    await screen.findByText('order.cancelled');
    await user.click(screen.getByRole('button', { name: /replay all \(1\)/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /replay all/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/admin/notifications/dead-letters/replay'))).toBe(true));

    await user.click(screen.getByRole('button', { name: /retry all given up \(7\)/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /retry all/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/admin/notifications/retry'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/admin/notifications/retry'))!.body).toEqual({ status: 'DEAD' });
  });

  it('shows an error state with retry (not a green card) when the health call itself fails', async () => {
    setup(() => json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Gateway cannot reach upstream', requestId: 'req-9' } }, 503));
    expect(await screen.findByText(/reference: req-9/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /try again|retry/i }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument();
  });
});
