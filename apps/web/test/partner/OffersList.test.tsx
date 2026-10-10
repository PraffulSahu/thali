import '../setup';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OffersList } from '../../src/features/partner/OffersList';
import { renderWithProviders } from '../utils';
import { apiError, job, json, offer, routeFetch } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

function setup(routes: Parameters<typeof routeFetch>[0], props: Partial<React.ComponentProps<typeof OffersList>> = {}) {
  const fetchMock = routeFetch({ 'GET /partner/offers': () => json(200, { items: [offer()] }), ...routes });
  vi.stubGlobal('fetch', fetchMock);
  renderWithProviders(<OffersList enabled activeJobs={[]} maxActive={2} {...props} />);
  return fetchMock;
}

describe('OffersList', () => {
  it('accepts an offer and shows the accepted strip with Navigate to the pickup', async () => {
    const fetchMock = setup({
      'POST /deliveries/offers/o1/accept': () => json(200, { offerId: 'o1', status: 'ACCEPTED', job: job({ id: 'j2' }) }),
      'GET /deliveries/active': () => json(200, { items: [] }),
      'GET /partner/profile': () => json(200, {}),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept offer' }));
    const strip = await screen.findByTestId('accepted-strip');
    expect(strip).toHaveTextContent('Accepted');
    expect(strip).toHaveTextContent('Head to Green Leaf');
    expect(screen.getByRole('link', { name: /navigate to green leaf/i })).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=12.97,77.64');
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/v1/deliveries/offers/o1/accept')).toBe(true);
  });

  it('as a 2nd delivery the strip says "Added as delivery 2 · head to … after your current drop"', async () => {
    setup({ 'POST /deliveries/offers/o1/accept': () => json(200, { offerId: 'o1', status: 'ACCEPTED', job: job({ id: 'j2' }) }) }, { activeJobs: [job({ id: 'j1', status: 'AT_PICKUP' })] });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept offer' }));
    expect(await screen.findByTestId('accepted-strip')).toHaveTextContent('Added as delivery 2 · head to Green Leaf after your current drop');
  });

  it('409 ASSIGNMENT_TAKEN closes the offer as "Taken by another partner" and refetches offers', async () => {
    const fetchMock = setup({ 'POST /deliveries/offers/o1/accept': () => apiError(409, 'ASSIGNMENT_TAKEN', 'Another partner already accepted this delivery') });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept offer' }));
    expect(await screen.findByText('Taken by another partner')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/partner/offers')).length).toBeGreaterThan(1));
  });

  it('409 OFFER_EXPIRED closes it as "Offer expired"', async () => {
    setup({ 'POST /deliveries/offers/o1/accept': () => apiError(409, 'OFFER_EXPIRED', 'This offer has expired or is no longer available') });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept offer' }));
    expect(await screen.findByText('Offer expired')).toBeInTheDocument();
  });

  it('409 CAPACITY_EXCEEDED keeps the offer open with the server reason', async () => {
    setup({ 'POST /deliveries/offers/o1/accept': () => apiError(409, 'CAPACITY_EXCEEDED', 'You are at your active delivery limit or not online') });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept offer' }));
    expect(await screen.findByText(/active delivery limit or not online/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept offer' })).toBeEnabled();
  });

  it('decline calls reject and shows "Declined"', async () => {
    const fetchMock = setup({ 'POST /deliveries/offers/o1/reject': () => json(200, { ...offer(), status: 'REJECTED', job: null }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('Declined')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/v1/deliveries/offers/o1/reject')).toBe(true);
  });

  it('an offer whose countdown has run out shows "Offer expired"', async () => {
    setup({ 'GET /partner/offers': () => json(200, { items: [offer({ expiresAt: new Date(Date.now() - 1000).toISOString() })] }) });
    expect(await screen.findByText('Offer expired')).toBeInTheDocument();
  });

  it('at capacity, accept is disabled with the reason', async () => {
    setup({}, { activeJobs: [job({ id: 'a' }), job({ id: 'b' })] });
    expect(await screen.findByRole('button', { name: 'Accept offer' })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('You’re carrying 2 of 2 deliveries');
  });

  it('shows a calm empty line when there are no offers', async () => {
    setup({ 'GET /partner/offers': () => json(200, { items: [] }) });
    expect(await screen.findByTestId('no-offers')).toHaveTextContent('No offers right now');
  });

  it('shows a retry when offers fail to load', async () => {
    setup({ 'GET /partner/offers': () => apiError(503, 'UPSTREAM_UNAVAILABLE', 'Delivery is unavailable') });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
