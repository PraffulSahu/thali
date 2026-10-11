import '../setup';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsumerShell } from '../../src/components/layout/ConsumerShell';
import { bottomNavItems, type NavItem } from '../../src/components/layout/RoleNav';
import { adminRoleTag, adminUserSubtitle, RoleSidebarShell, SidebarSwitcher } from '../../src/components/layout/RoleSidebarShell';
import { AccountMenu, AccountMenuItem, Breadcrumb, NotificationBell, useShellBreadcrumb } from '../../src/components/layout/ShellParts';
import { CartDock } from '../../src/components/ui/CartDock';
import { KpiTile } from '../../src/components/ui/KpiTile';
import { OptionCard } from '../../src/components/ui/OptionCard';
import { Popover } from '../../src/components/ui/Popover';
import { makeAuth, renderWithProviders } from '../utils';

function metaFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/meta')) return new Response(JSON.stringify({ mode: 'production' }), { headers: { 'content-type': 'application/json' } });
      throw new TypeError('offline');
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

const tabLabels = (nav: HTMLElement) => within(nav).getAllByRole('link').map((a) => a.textContent);
/** The phone tab bar is the last nav with the area label (sidebar + rail come first). */
const tabBar = (name: string) => screen.getAllByRole('navigation', { name }).at(-1)!;

describe('Popover', () => {
  function Demo() {
    return (
      <>
        <button type="button">outside</button>
        <Popover label="Pause new orders" panelClassName="w-[320px] p-3" trigger={(p) => <button {...p}>Pause orders</button>}>
          {(close) => (
            <>
              <button type="button" onClick={close}>
                30 min
              </button>
              <button type="button">1 hour</button>
            </>
          )}
        </Popover>
      </>
    );
  }

  it('focuses the first control, closes on Escape (focus back to the trigger) and on outside click', async () => {
    const user = userEvent.setup();
    render(<Demo />);
    const trigger = screen.getByRole('button', { name: 'Pause orders' });
    await user.click(trigger);
    const panel = screen.getByRole('dialog', { name: 'Pause new orders' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '30 min' })).toHaveFocus();
    // panelClassName merges over the defaults (later wins: p-3 replaces p-2)
    expect(panel.className).toContain('w-[320px]');
    expect(panel.className).toContain('p-3');
    expect(panel.className).not.toMatch(/(^|\s)p-2(\s|$)/);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '30 min' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('components', () => {
  it('OptionCard disabledReason replaces " · Unavailable"', () => {
    render(
      <>
        <OptionCard type="checkbox" disabled label="Boiled egg" />
        <OptionCard type="checkbox" disabled disabledReason="Max 2" label="Mint chutney" />
        <OptionCard type="radio" disabled disabledReason={null} label="Half" />
      </>,
    );
    expect(screen.getByLabelText('Boiled egg · Unavailable')).toBeDisabled();
    expect(screen.getByLabelText('Mint chutney · Max 2')).toBeDisabled();
    expect(screen.getByLabelText('Half')).toBeDisabled();
  });

  it('KpiTile highlight fills acc-soft (no bg-card left behind)', () => {
    render(<KpiTile label="Available for payout" value="₹1,200" highlight />);
    const tile = screen.getByText('Available for payout').parentElement!;
    expect(tile.className).toContain('bg-acc-soft');
    expect(tile.className).not.toContain('bg-card');
  });

  it('CartDock chips are buttons with onChipClick', async () => {
    const onChip = vi.fn();
    renderWithProviders(
      <CartDock
        carts={[
          { id: 'r1', name: 'Spice Route', hue: '#d23f11', subtotalPaise: 37800, itemCount: 2 },
          { id: 'r2', name: 'Dosa Hut', hue: '#1d4ed8', subtotalPaise: 18000, itemCount: 1 },
        ]}
        itemCount={3}
        totalPaise={55800}
        open={false}
        onOpenChange={() => {}}
        onChipClick={onChip}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Dosa Hut · ₹180/ }));
    expect(onChip).toHaveBeenCalledWith('r2');
  });

  it('NotificationBell announces the unread count', () => {
    renderWithProviders(<NotificationBell unread={3} />);
    expect(screen.getByRole('link', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
  });
});

describe('RoleNav tabs', () => {
  const nav: NavItem[] = [
    { to: '/admin', label: 'Overview', icon: 'chart', end: true },
    { to: '/admin/restaurants', label: 'Restaurants', icon: 'store' },
    { to: '/admin/orders', label: 'Orders', icon: 'receipt' },
  ];
  it('resolves tabs against the nav, keeps their order, drops icon-less unknown paths', () => {
    const items = bottomNavItems(nav, [
      { to: '/admin/orders' },
      { to: '/admin/restaurants?status=APPROVAL_PENDING', label: 'Approvals', icon: 'check-circle' },
      { to: '/admin/nowhere', label: 'Nope' },
      { to: '/admin' },
    ]);
    expect(items.map((i) => [i.label, i.icon])).toEqual([
      ['Orders', 'receipt'],
      ['Approvals', 'check-circle'],
      ['Overview', 'chart'],
    ]);
    expect(items[2]!.end).toBe(true);
  });
  it('uses shortLabel without explicit tabs', () => {
    expect(bottomNavItems([{ to: '/p/h', label: 'Delivery history', shortLabel: 'History', icon: 'clock' }])[0]!.label).toBe('History');
  });
});

describe('RoleSidebarShell polish', () => {
  it('admin: sub-role tag + subtitle from the session, phone tabs Overview · Orders · Deliveries · Approvals + More', () => {
    metaFetch();
    const nav: NavItem[] = [
      { to: '/admin', label: 'Overview', icon: 'chart', end: true },
      { to: '/admin/restaurants', label: 'Restaurants', icon: 'store' },
      { to: '/admin/partners', label: 'Partners', icon: 'bike' },
      { to: '/admin/orders', label: 'Orders', icon: 'receipt' },
      { to: '/admin/tms', label: 'Deliveries', icon: 'map' },
      { to: '/admin/health', label: 'Health', icon: 'activity' },
    ];
    renderWithProviders(<RoleSidebarShell role="admin" nav={nav} />, {
      route: '/admin',
      auth: makeAuth({ roles: ['ADMIN'], adminRoles: ['FINANCE', 'SUPPORT'], hasMfa: true, user: { id: 'a', name: 'Nisha Kapoor Raghunathan', roles: ['ADMIN'] } }),
    });
    expect(screen.getAllByText('FINANCE').length).toBeGreaterThan(0);
    expect(screen.queryByText('OPS')).not.toBeInTheDocument();
    expect(screen.getByText('Finance · Support admin · MFA on')).toBeInTheDocument();
    const bar = tabBar('Admin');
    expect(tabLabels(bar)).toEqual(['Overview', 'Orders', 'Deliveries', 'Approvals']);
    expect(within(bar).getByRole('link', { name: 'Approvals' })).toHaveAttribute('href', '/admin/restaurants?status=APPROVAL_PENDING');
    expect(within(bar).getByRole('button', { name: 'More' })).toBeInTheDocument();
    // footer: the whole user block is the account-menu trigger (no separate "⋯" squeezing the name)
    expect(screen.getByRole('button', { name: /Nisha Kapoor Raghunathan.*account menu/i })).toBeInTheDocument();
  });

  it('helpers: adminRoleTag / adminUserSubtitle', () => {
    expect(adminRoleTag(['SUPPORT', 'SUPER_ADMIN'])).toBe('SUPER');
    expect(adminRoleTag([])).toBe('OPS');
    expect(adminUserSubtitle(['OPS'], true)).toBe('Ops admin · MFA on');
    expect(adminUserSubtitle([], false)).toBe('Ops admin');
  });

  it('partner: Home · History · Earnings · Profile; restaurant: Live orders first + More; roleTag + extra menu items', async () => {
    metaFetch();
    const partnerNav: NavItem[] = [
      { to: '/partner', label: 'Home', icon: 'home', end: true },
      { to: '/partner/history', label: 'Delivery history', icon: 'clock' },
      { to: '/partner/earnings', label: 'Earnings & payouts', icon: 'wallet' },
      { to: '/partner/onboarding', label: 'Profile & documents', icon: 'user' },
    ];
    const { unmount } = renderWithProviders(<RoleSidebarShell role="partner" nav={partnerNav} roleTag="RIDER" />, { route: '/partner', auth: makeAuth({ roles: ['DELIVERY_PARTNER'] }) });
    const pbar = tabBar('Partner');
    expect(tabLabels(pbar)).toEqual(['Home', 'History', 'Earnings', 'Profile']);
    expect(within(pbar).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    expect(screen.getAllByText('RIDER').length).toBeGreaterThan(0);
    unmount();

    const restaurantNav: NavItem[] = [
      { to: '/restaurant', label: 'Dashboard', icon: 'chart', end: true },
      { to: '/restaurant/orders', label: 'Live orders', icon: 'receipt', end: true },
      { to: '/restaurant/orders/history', label: 'Order history', icon: 'clock' },
      { to: '/restaurant/menu', label: 'Menu', icon: 'list' },
      { to: '/restaurant/settings', label: 'Store settings', icon: 'settings' },
      { to: '/restaurant/finance', label: 'Finance', icon: 'wallet' },
    ];
    const user = userEvent.setup();
    renderWithProviders(
      <RoleSidebarShell
        role="restaurant"
        nav={restaurantNav}
        signOutAll
        AccountExtras={({ close }) => (
          <AccountMenuItem icon="ticket" onClick={close}>
            Help centre
          </AccountMenuItem>
        )}
      />,
      { route: '/restaurant', auth: makeAuth({ roles: ['RESTAURANT_OWNER'], user: { id: 'o', name: 'Owner One', roles: ['RESTAURANT_OWNER'] } }) },
    );
    const rbar = tabBar('Restaurant');
    expect(tabLabels(rbar)).toEqual(['Live orders', 'Dashboard', 'Menu', 'Finance']);
    expect(within(rbar).getByRole('button', { name: 'More' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Owner One.*account menu/i }));
    expect(screen.getByRole('button', { name: 'Help centre' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out of all devices' }));
    expect(await screen.findByRole('alertdialog', { name: 'Sign out of all devices?' })).toBeInTheDocument();
  });

  it('SidebarSwitcher: spreads props onto the button and opens its menu as a dialog', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <SidebarSwitcher name="Spice Route" area="Indiranagar" dot data-testid="sw" onClick={onClick} aria-label="Switch restaurant. Current: Spice Route, Indiranagar" menuLabel="Switch restaurant" menu={(close) => <button onClick={close}>Dosa Hut</button>} />,
    );
    const btn = screen.getByTestId('sw');
    expect(btn).toHaveAccessibleName('Switch restaurant. Current: Spice Route, Indiranagar');
    await user.click(btn);
    expect(onClick).toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Switch restaurant' });
    await user.click(within(dialog).getByRole('button', { name: 'Dosa Hut' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Account menu + ConsumerShell slots', () => {
  it('consumer: Profile · Your orders first, then area links, and a phone-only theme row', async () => {
    renderWithProviders(<AccountMenu area="consumer" links={[{ to: '/account/addresses', label: 'Addresses', icon: 'location' }, { to: '/orders', label: 'Orders dup', icon: 'receipt' }]} />, {
      auth: makeAuth({ roles: ['CONSUMER'] }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    const links = screen.getAllByRole('link').map((a) => a.textContent);
    expect(links.slice(0, 3)).toEqual(['Profile', 'Your orders', 'Addresses']);
    expect(links).not.toContain('Orders dup');
    const theme = screen.getByRole('button', { name: 'Dark mode' });
    expect(theme.className).toContain('sm:hidden');
  });

  it('ConsumerShell: accountLinks, page breadcrumb via useShellBreadcrumb, bleed container', async () => {
    metaFetch();
    function Page() {
      useShellBreadcrumb(<Breadcrumb items={[{ label: 'Restaurants', to: '/' }, { label: 'Spice Route' }]} />, []);
      return <section data-testid="hero">hero</section>;
    }
    renderWithProviders(
      <ConsumerShell variant="discover" container="bleed" accountLinks={[{ to: '/support', label: 'Support', icon: 'ticket' }]}>
        <Page />
      </ConsumerShell>,
      { route: '/r/spice', auth: makeAuth({ roles: ['CONSUMER'] }) },
    );
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByRole('link', { name: 'Restaurants' })).toHaveAttribute('href', '/');
    expect(within(crumb).getByText('Spice Route')).toHaveAttribute('aria-current', 'page');
    // breadcrumb replaces the desktop search; bleed = page is a direct child of <main>
    expect(screen.getByTestId('hero').parentElement).toBe(screen.getByRole('main'));
    await userEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support'));
  });
});
