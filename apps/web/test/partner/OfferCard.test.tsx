import '../setup';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OfferCard } from '../../src/features/partner/OfferCard';
import type { Offer } from '../../src/features/partner/api';
import { renderWithProviders } from '../utils';

const offer = (over: Partial<Offer> = {}): Offer => ({
  id: 'o1',
  jobId: 'j1',
  status: 'OFFERED',
  round: 1,
  expiresAt: new Date(Date.now() + 90_000).toISOString(),
  distanceToPickupKm: 0.8,
  batchEvaluation: {
    eligible: true,
    reasons: ['active 1 < max 2 ✓', 'pickup 0.8km ≤ 1.5km ✓', 'extra 14.0min ≤ 12min ✗'],
    extraMinutes: 7.8,
  },
  job: {
    childOrderId: 'co1',
    pickup: { name: 'Meghana Foods', address: '12 Koramangala', location: { lat: 12.93, lng: 77.62 } },
    drop: { name: 'Home', address: '5 Indiranagar', location: { lat: 12.97, lng: 77.64 } },
    distanceKm: 4.2,
    estimatedMinutes: 22,
    estimateSource: 'HAVERSINE_ESTIMATE',
    readyEta: null,
  },
  ...over,
});

describe('OfferCard', () => {
  it('renders the batch-eligibility reasons and a live countdown', () => {
    renderWithProviders(<OfferCard offer={offer()} onAccept={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText('active 1 < max 2 ✓')).toBeInTheDocument();
    expect(screen.getByText('pickup 0.8km ≤ 1.5km ✓')).toBeInTheDocument();
    expect(screen.getByText('extra 14.0min ≤ 12min ✗')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/1:[23]\d|1:30/);
    expect(screen.getByText('Meghana Foods')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept/i })).toBeEnabled();
  });

  it('calls onAccept / onReject with the offer', async () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    renderWithProviders(<OfferCard offer={offer()} onAccept={onAccept} onReject={onReject} />);
    await userEvent.click(screen.getByRole('button', { name: /accept/i }));
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }));
    await userEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }));
  });

  it('disables accept once the offer has expired', () => {
    renderWithProviders(<OfferCard offer={offer({ expiresAt: new Date(Date.now() - 5_000).toISOString() })} onAccept={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByRole('button', { name: /accept/i })).toBeDisabled();
    expect(screen.getAllByText(/offer expired/i).length).toBeGreaterThan(0);
  });

  it('shows the batching verdict badge only when the partner has an active delivery', () => {
    const { unmount } = renderWithProviders(<OfferCard offer={offer()} onAccept={vi.fn()} onReject={vi.fn()} />);
    expect(screen.queryByText(/can batch with your current run/i)).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<OfferCard offer={offer()} hasActiveJobs onAccept={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText(/can batch with your current run/i)).toBeInTheDocument();
  });
});
