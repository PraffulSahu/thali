import '../setup';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PartnerHome from '../../src/features/partner/PartnerHome';
import { makeAuth, renderWithProviders } from '../utils';
import { apiError, batchedOffer, job, json, payout, profile, routeFetch, summary } from './fixtures';

beforeEach(() => {
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: vi.fn(), watchPosition: vi.fn(() => 1), clearWatch: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

const auth = makeAuth({ roles: ['CONSUMER', 'DELIVERY_PARTNER'] });

function render(routes: Parameters<typeof routeFetch>[0]) {
  const fetchMock = routeFetch({
    'GET /partner/profile': () => json(200, profile()),
    'GET /deliveries/active': () => json(200, { items: [job({ status: 'AT_PICKUP' })] }),
    'GET /partner/offers': () => json(200, { items: [batchedOffer()] }),
    'GET /finance/partner/summary': () => json(200, summary({ deliveries: 6, earningsPaise: 64200 })),
    'GET /finance/partner/payouts': () => json(200, { items: [payout()], nextCursor: null }),
    ...routes,
  });
  vi.stubGlobal('fetch', fetchMock);
  renderWithProviders(<PartnerHome />, { auth, route: '/partner' });
  return fetchMock;
}

describe('PartnerHome (board 30)', () => {
  it('approved + online: online card, offer (2nd delivery), active delivery, Today, last payout with UTR, tips', async () => {
    const fetchMock = render({});
    expect(await screen.findByRole('heading', { name: 'You’re online' })).toBeInTheDocument();
    expect(await screen.findByText('New offer · would be your 2nd delivery')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Active delivery 1 of 1' })).toBeInTheDocument();
    const today = screen.getByRole('region', { name: 'Today' });
    expect(await within(today).findByText('6')).toBeInTheDocument();
    expect(within(today).getByText('₹642')).toBeInTheDocument();
    expect(within(today).getByRole('link', { name: /earnings & payouts/i })).toHaveAttribute('href', '/partner/earnings');
    const last = screen.getByRole('region', { name: 'Last payout' });
    expect(await within(last).findByText('₹3,410.00')).toBeInTheDocument();
    expect(within(last).getByText('Paid')).toBeInTheDocument();
    expect(within(last).getByText(/UTR 4021 8833 1190 · 8 Oct/)).toBeInTheDocument();
    expect(screen.getAllByText(/keep thali open while delivering/i).length).toBeGreaterThan(0);
    // last payout asks for exactly one row; Today uses the default (today IST) window
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/v1/finance/partner/payouts?limit=1')).toBe(true);
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/v1/finance/partner/summary')).toBe(true);
  });

  it('a PAID payout without UTR is never shown as "Paid"; no payouts → "No payouts yet"; failed stats → "—" + Retry', async () => {
    render({
      'GET /finance/partner/payouts': () => json(200, { items: [payout({ utr: null })], nextCursor: null }),
      'GET /finance/partner/summary': () => apiError(503, 'UPSTREAM_UNAVAILABLE', 'Payments unavailable'),
    });
    const last = await screen.findByRole('region', { name: 'Last payout' });
    expect(await within(last).findByText('Awaiting bank reference')).toBeInTheDocument();
    expect(within(last).queryByText('Paid')).not.toBeInTheDocument();
    const today = screen.getByRole('region', { name: 'Today' });
    expect(await within(today).findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(today).getAllByText('—')).toHaveLength(2);
  });

  it('offline: no offers are fetched and the empty active card says to go online', async () => {
    const fetchMock = render({
      'GET /partner/profile': () => json(200, profile({ online: false })),
      'GET /deliveries/active': () => json(200, { items: [] }),
      'GET /finance/partner/payouts': () => json(200, { items: [], nextCursor: null }),
    });
    expect(await screen.findByRole('heading', { name: 'You’re offline' })).toBeInTheDocument();
    expect(await screen.findByText('Go online to start receiving delivery offers.')).toBeInTheDocument();
    expect(await screen.findByText(/no payouts yet/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/partner/offers'))).toBe(false);
  });

  it('not approved: status banner with the reason and a link to resubmit, no online card', async () => {
    render({ 'GET /partner/profile': () => json(200, profile({ status: 'REJECTED', statusReason: 'Licence photo is blurry', online: false })) });
    expect(await screen.findByText('Your application wasn’t approved')).toBeInTheDocument();
    expect(screen.getByText(/Licence photo is blurry/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fix and resubmit' })).toHaveAttribute('href', '/partner/onboarding');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('no profile yet: onboarding call to action', async () => {
    render({ 'GET /partner/profile': () => apiError(404, 'NOT_FOUND', 'Create your delivery partner profile first') });
    expect(await screen.findByRole('heading', { name: 'Set up your delivery partner profile' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start onboarding' })).toHaveAttribute('href', '/partner/onboarding');
  });

  it('profile error: error state with retry', async () => {
    render({ 'GET /partner/profile': () => apiError(500, 'INTERNAL', 'Something broke') });
    expect(await screen.findByRole('button', { name: /try again/i }, { timeout: 8000 })).toBeInTheDocument();
  });
});
