import '../setup';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nav, shell } from '../../src/features/partner/routes';
import { PartnerMobileContext, PartnerProfileCard, PartnerStatusFooter } from '../../src/features/partner/PartnerShellParts';
import { makeAuth, renderWithProviders } from '../utils';
import { json, profile, routeFetch } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
const auth = makeAuth({ roles: ['CONSUMER', 'DELIVERY_PARTNER'] });

describe('partner shell slots (board 30 sidebar)', () => {
  it('nav: Home · Delivery history · Earnings & payouts · Profile & documents; slots wired', () => {
    expect(nav.map((n) => [n.label, n.to])).toEqual([
      ['Home', '/partner'],
      ['Delivery history', '/partner/history'],
      ['Earnings & payouts', '/partner/earnings'],
      ['Profile & documents', '/partner/onboarding'],
    ]);
    expect(shell.Context).toBe(PartnerProfileCard);
    expect(shell.Footer).toBe(PartnerStatusFooter);
  });

  it('profile card shows name + "Scooter · KA03HX4417" and links to profile & documents', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'GET /partner/profile': () => json(200, profile()) }));
    renderWithProviders(<PartnerProfileCard />, { auth });
    const link = await screen.findByRole('link', { name: /ravi kumar, scooter · ka03hx4417/i });
    expect(link).toHaveAttribute('href', '/partner/onboarding');
    expect(screen.getByText('Scooter · KA03HX4417')).toBeInTheDocument();
  });

  it('footer shows the status chip; mobile context shows Online', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'GET /partner/profile': () => json(200, profile()) }));
    renderWithProviders(
      <>
        <PartnerStatusFooter />
        <PartnerMobileContext />
      </>,
      { auth },
    );
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('a pending partner’s chip links to the application', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'GET /partner/profile': () => json(200, profile({ status: 'APPROVAL_PENDING', online: false })) }));
    renderWithProviders(<PartnerStatusFooter />, { auth });
    expect(await screen.findByRole('link', { name: /awaiting approval/i })).toHaveAttribute('href', '/partner/onboarding');
  });

  it('renders nothing (and fetches nothing) when signed out', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderWithProviders(<PartnerProfileCard />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
