import '../setup';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutShell } from '../../src/components/layout/CheckoutShell';
import { ConsumerShell } from '../../src/components/layout/ConsumerShell';
import { PublicShell } from '../../src/components/layout/PublicShell';
import { NavCount, NavDot, type NavItem } from '../../src/components/layout/RoleNav';
import { RoleSidebarShell, SidebarSearchButton } from '../../src/components/layout/RoleSidebarShell';
import { makeAuth, renderWithProviders } from '../utils';

function metaFetch(mode: 'demo' | 'production') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/meta')) return new Response(JSON.stringify({ mode }), { headers: { 'content-type': 'application/json' } });
      throw new TypeError('offline');
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Overview', icon: 'chart', end: true },
  { to: '/admin/restaurants', label: 'Restaurants', icon: 'store', section: 'Marketplace' },
  { to: '/admin/tms', label: 'Deliveries', icon: 'map', section: 'Operations', Badge: () => <NavCount count={1} label="unassigned" /> },
  { to: '/admin/health', label: 'Health', icon: 'activity', section: 'System', Badge: () => <NavDot tone="bad" label="services down" /> },
];

describe('RoleSidebarShell', () => {
  it('admin: OPS tag, section labels, badges, user block with MFA, theme toggle, demo strip', async () => {
    metaFetch('demo');
    renderWithProviders(
      <RoleSidebarShell role="admin" nav={ADMIN_NAV} Context={() => <SidebarSearchButton onClick={() => {}} />}>
        <h1>Today at a glance</h1>
      </RoleSidebarShell>,
      { route: '/admin', auth: makeAuth({ roles: ['ADMIN'], hasMfa: true, user: { id: 'a', name: 'Nisha Kapoor' } }) },
    );
    expect(screen.getAllByText('OPS').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Marketplace').length).toBeGreaterThan(0);
    expect(screen.getAllByText('unassigned').length).toBeGreaterThan(0);
    expect(screen.getAllByText('services down').length).toBeGreaterThan(0);
    expect(screen.getByText('Ops admin · MFA on')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Switch to dark mode' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /search orders, phones/i }).length).toBeGreaterThan(0);
    expect(await screen.findByText('DEMO MODE — no real money, SMS or deliveries')).toBeInTheDocument();
    const current = screen.getAllByRole('link', { name: 'Overview' }).find((a) => a.getAttribute('aria-current') === 'page');
    expect(current).toBeTruthy();
    expect(screen.getByRole('main')).toHaveTextContent('Today at a glance');
  });

  it('restaurant: KITCHEN tag; no navigation when the user lacks the role', () => {
    metaFetch('production');
    renderWithProviders(<RoleSidebarShell role="restaurant" nav={ADMIN_NAV} showNav={false} />, { route: '/restaurant', auth: makeAuth() });
    expect(screen.getAllByText('KITCHEN').length).toBeGreaterThan(0);
    expect(screen.queryByRole('navigation', { name: 'Restaurant' })).not.toBeInTheDocument();
    expect(screen.queryByText(/DEMO MODE/)).not.toBeInTheDocument();
  });
});

describe('ConsumerShell', () => {
  it('"/" focuses the search; Orders + bell only when signed in', () => {
    metaFetch('production');
    renderWithProviders(<ConsumerShell variant="discover" />, { route: '/', auth: makeAuth({ roles: ['CONSUMER'] }) });
    const search = screen.getAllByRole('searchbox')[0]!;
    fireEvent.keyDown(document.body, { key: '/' });
    expect(search).toHaveFocus();
    expect(screen.getAllByRole('link', { name: 'Orders' })[0]).toHaveAttribute('href', '/orders');
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose delivery location' })).toBeInTheDocument();
  });

  it('account variant shows Restaurants · Orders · Thali Plus · Support; guests get Sign in', () => {
    metaFetch('production');
    renderWithProviders(<ConsumerShell variant="account" />, { route: '/orders', auth: makeAuth() });
    const nav = screen.getByRole('navigation', { name: 'Account' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Restaurants', 'Orders', 'Thali Plus', 'Support']);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin?role=customer&next=%2Forders');
    expect(screen.queryByRole('link', { name: 'Notifications' })).not.toBeInTheDocument();
  });
});

describe('CheckoutShell', () => {
  it('back button, "/ Checkout", secure label, theme', () => {
    metaFetch('production');
    renderWithProviders(<CheckoutShell backTo="/cart" />, { route: '/checkout' });
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByText('Secure checkout')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });
});

describe('PublicShell', () => {
  it('utility bar, demo pill, theme radiogroup, header links and footer', async () => {
    metaFetch('demo');
    renderWithProviders(<PublicShell>page</PublicShell>, { route: '/terms' });
    expect(await screen.findByText('DEMO MODE · no real money, SMS or deliveries')).toBeInTheDocument();
    expect(screen.getAllByRole('radiogroup', { name: 'Theme' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Partner with us' })[0]).toHaveAttribute('href', '/partner-with-us');
    expect(screen.getAllByRole('link', { name: /offers/i })[0]).toHaveAttribute('href', '/offers');
    expect(screen.getByRole('link', { name: 'Cart, empty' })).toHaveAttribute('href', '/cart');
    expect(screen.getByRole('link', { name: 'List a restaurant' })).toHaveAttribute('href', '/signin?role=restaurant&next=%2Frestaurant%2Fonboarding');
    expect(screen.getByRole('link', { name: 'Ops sign in' })).toHaveAttribute('href', '/signin?role=admin');
    await waitFor(() => expect(screen.getByText('© 2026 Thali')).toBeInTheDocument());
  });
});
