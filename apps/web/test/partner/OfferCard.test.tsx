import '../setup';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OfferCard } from '../../src/features/partner/OfferCard';
import { renderWithProviders } from '../utils';
import { batchedOffer, offer } from './fixtures';

const noop = () => undefined;

describe('OfferCard (board 30)', () => {
  it('shows distance, ~minutes (EST.), pickup and the drop AREA only with "Full address after pickup"', () => {
    renderWithProviders(<OfferCard offer={offer()} activeCount={0} onAccept={noop} onDecline={noop} />);
    const card = screen.getByTestId('offer-card');
    expect(within(card).getByText('New offer')).toBeInTheDocument();
    expect(within(card).getByText('3.2 km')).toBeInTheDocument();
    expect(within(card).getByText('~18 min')).toBeInTheDocument();
    expect(within(card).getByText('estimate')).toBeInTheDocument(); // EST. badge (sr text)
    expect(within(card).getByText('Pickup · Green Leaf')).toBeInTheDocument();
    expect(within(card).getByText('Drop · HAL 2nd Stage')).toBeInTheDocument();
    expect(within(card).getByText('Full address after pickup')).toBeInTheDocument();
    expect(within(card).getByText(/0\.8 km|800 m/)).toBeInTheDocument();
    // no fit box for an idle partner
    expect(screen.queryByTestId('fit-box')).not.toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveAccessibleName(/to accept the offer/);
  });

  it('as a 2nd delivery: "would be your 2nd delivery" + the fit list from reasons[]', () => {
    renderWithProviders(<OfferCard offer={batchedOffer()} activeCount={1} onAccept={noop} onDecline={noop} />);
    expect(screen.getByText('New offer · would be your 2nd delivery')).toBeInTheDocument();
    const fit = screen.getByTestId('fit-box');
    expect(within(fit).getByText('Fits with your current delivery')).toBeInTheDocument();
    expect(within(fit).getByText('pickup 0.8 km ≤ 1.5 km')).toBeInTheDocument();
    expect(within(fit).getByText('extra time 8 min ≤ 12 min')).toBeInTheDocument();
  });

  it('turns the ring red under 10 s', () => {
    renderWithProviders(<OfferCard offer={offer({ expiresAt: new Date(Date.now() + 8_000).toISOString() })} activeCount={0} onAccept={noop} onDecline={noop} />);
    expect(screen.getByRole('timer')).toHaveAttribute('data-danger', 'true');
  });

  it('accept / decline call back with the offer; a capacity reason disables accept', async () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    const { unmount } = renderWithProviders(<OfferCard offer={offer()} activeCount={0} onAccept={onAccept} onDecline={onDecline} />);
    await userEvent.click(screen.getByRole('button', { name: 'Accept offer' }));
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }));
    expect(onDecline).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }));
    unmount();
    renderWithProviders(<OfferCard offer={offer()} activeCount={2} acceptDisabledReason="You’re carrying 2 of 2 deliveries." onAccept={onAccept} onDecline={noop} />);
    expect(screen.getByRole('button', { name: 'Accept offer' })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('2 of 2');
  });

  it.each([
    ['expired', 'Offer expired'],
    ['declined', 'Declined'],
    ['taken', 'Taken by another partner'],
  ] as const)('closed (%s) shows the muted bar "%s" and no actions', (reason, label) => {
    renderWithProviders(<OfferCard offer={offer()} activeCount={0} closed={reason} onAccept={noop} onDecline={noop} />);
    expect(screen.getByText('Offer closed')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(label);
    expect(screen.queryByRole('button', { name: 'Accept offer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });
});
