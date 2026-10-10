import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OffersList } from '../../src/features/partner/OffersList';
import { renderWithProviders } from '../utils';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const offer = {
  id: 'o1', jobId: 'j1', status: 'OFFERED', round: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), distanceToPickupKm: 1,
  batchEvaluation: { eligible: true, reasons: ['idle partner ✓'], extraMinutes: 0 },
  job: { childOrderId: 'co1', pickup: { name: 'Meghana Foods', address: 'A', location: { lat: 1, lng: 1 } }, drop: { name: 'H', address: 'B', location: { lat: 2, lng: 2 } }, distanceKm: 3, estimatedMinutes: 15, estimateSource: 'GOOGLE', readyEta: null },
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('OffersList', () => {
  it('toasts "Taken by another partner" on a 409 accept and refreshes the offers', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/accept')) return json(409, { error: { code: 'ASSIGNMENT_TAKEN', message: 'Another partner already accepted this delivery', requestId: 'r' } });
      if (String(url).endsWith('/partner/offers')) return json(200, { items: [offer] });
      return json(200, {});
    });
    renderWithProviders(<OffersList enabled />);
    await userEvent.click(await screen.findByRole('button', { name: /accept delivery/i }));
    expect(await screen.findByText('Taken by another partner')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/partner/offers')).length).toBeGreaterThan(1));
  });

  it('shows an empty state when there are no offers', async () => {
    fetchMock.mockResolvedValue(json(200, { items: [] }));
    renderWithProviders(<OffersList enabled />);
    expect(await screen.findByText('No offers right now')).toBeInTheDocument();
  });
});
