/**
 * Consumer shell (boards 10, 11, 13; design-spec §3.28 + §6.4).
 *
 *   Header (sticky, glass): logo (→ /discover, the consumer home) · location chip slot · search (`/` focuses) · Orders · bell · theme · avatar
 *   variant="account" adds the ghost nav Restaurants · Orders · Thali Plus · Support (≥1024)
 *   ≤1023 search drops to a second row; ≤640 bottom tab bar Home · Search · Orders · Account
 *
 * Mounting: the consumer area's auto chrome renders it for you with the module's `shell` slots:
 *
 *   export const shell: ConsumerShellConfig = {
 *     Location: LocationChip,            // opens your location picker
 *     Actions: CartButton,               // extra right-cluster control(s)
 *     Bell: () => <NotificationBell unread={useUnread()} />,
 *     accountRoutes: ['/orders', '/account', '/membership', '/support', '/notifications'],
 *   };
 *
 * or explicitly as a layout route: `{ element: <ConsumerShell variant="account" />, children: [...] }`.
 * The cart dock is page content (render <CartDock> at the end of your page; it sits above the tab bar).
 */
import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { useChosenLocation } from '../../lib/location';
import { ButtonLink } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ThemeToggle } from '../ui/ThemeToggle';
import { Logo } from './Logo';
import { ModeBanner } from './ModeBanner';
import { RoleNav, type NavItem } from './RoleNav';
import { AccountMenu, HeaderSearch, MainRegion, NotificationBell, ShellSlotContext, SkipLink, type AccountMenuLink } from './ShellParts';

export const CONSUMER_ACCOUNT_NAV: NavItem[] = [
  { to: '/discover', label: 'Restaurants', icon: 'store', end: true },
  { to: '/orders', label: 'Orders', icon: 'receipt' },
  { to: '/membership', label: 'Thali Plus', icon: 'star' },
  { to: '/support', label: 'Support', icon: 'ticket' },
];

export const CONSUMER_TAB_NAV: NavItem[] = [
  { to: '/discover', label: 'Home', icon: 'home', end: true },
  { to: '/search', label: 'Search', icon: 'search' },
  { to: '/orders', label: 'Orders', icon: 'receipt' },
  { to: '/account', label: 'Account', icon: 'user' },
];

export interface ConsumerShellConfig {
  /** Location chip (opens the picker). Default: a chip showing the stored location, linking to /welcome. */
  Location?: ComponentType;
  /** Extra right-cluster controls (e.g. cart button). */
  Actions?: ComponentType;
  /** Bell with unread state. Default: plain bell linking to /notifications (signed-in only). */
  Bell?: ComponentType;
  /** Path prefixes that use the account variant (4-link nav). */
  accountRoutes?: string[];
  /** Tab bar items (≤640). Default CONSUMER_TAB_NAV. */
  tabs?: NavItem[];
  /** Account-menu links after Profile · Your orders (e.g. Addresses, Thali Plus, Support, Notifications). */
  accountLinks?: AccountMenuLink[];
}

export interface ConsumerShellProps extends ConsumerShellConfig {
  variant?: 'discover' | 'account';
  /**
   * Restaurant page: breadcrumb replaces the search on ≥1024. Pages can also set it from inside the shell with
   * `useShellBreadcrumb(<Breadcrumb items={[{ label: 'Restaurants', to: '/discover' }, { label: name }]} />, [name])`.
   */
  breadcrumb?: ReactNode;
  hideSearch?: boolean;
  searchPlaceholder?: string;
  /**
   * Content max width: discover 1360 · page 1200 (default) · checkout 1160 · none (no max width, keeps the page
   * padding) · bleed (no wrapper at all: pages own widths and padding — cuisine bands, restaurant hero).
   */
  container?: 'discover' | 'page' | 'checkout' | 'none' | 'bleed';
  children?: ReactNode;
}

/** Default location chip: stored label + address; links to the landing address box to change it. */
export function DefaultLocationChip() {
  const loc = useChosenLocation();
  return (
    <Link
      to="/welcome#address"
      aria-label={loc ? `Delivery location: ${loc.label}. Change` : 'Choose delivery location'}
      className="flex h-10 min-w-0 max-w-[280px] items-center gap-2.5 rounded-pill border border-line bg-card px-3.5 text-sm hover:border-line-2"
    >
      <Icon name="location" size={16} className="shrink-0 text-acc" />
      <span className="shrink-0 font-semibold text-fg">{loc ? loc.label : 'Set location'}</span>
      {loc?.address && loc.address !== loc.label ? <span className="min-w-0 truncate text-fg-3 max-sm:hidden">{loc.address}</span> : null}
      <Icon name="chevron-down" size={14} className="shrink-0 text-fg-3" />
    </Link>
  );
}

const containers: Record<'discover' | 'page' | 'checkout' | 'none', string> = {
  discover: 'max-w-[1360px]',
  page: 'max-w-[1200px]',
  checkout: 'max-w-[1160px]',
  none: 'max-w-none',
};

export function ConsumerShell({
  variant,
  breadcrumb,
  hideSearch,
  searchPlaceholder = 'Search restaurants or dishes',
  container = 'page',
  Location = DefaultLocationChip,
  Actions,
  Bell,
  accountRoutes = ['/orders', '/account', '/membership', '/support', '/notifications'],
  tabs = CONSUMER_TAB_NAV,
  accountLinks,
  children,
}: ConsumerShellProps) {
  const auth = useAuth();
  const [pageBreadcrumb, setBreadcrumb] = useState<ReactNode>(null);
  const slots = useMemo(() => ({ setBreadcrumb }), []);
  const crumb = breadcrumb ?? pageBreadcrumb;
  const headerWidth = containers[container === 'none' || container === 'bleed' ? 'discover' : container];
  const { pathname } = useLocation();
  const account = variant ? variant === 'account' : accountRoutes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const search = hideSearch ? null : <HeaderSearch placeholder={searchPlaceholder} />;
  const searchMobile = hideSearch ? null : <HeaderSearch placeholder={searchPlaceholder} hotkey={false} />;

  return (
    <ShellSlotContext.Provider value={slots}>
    <div className="flex min-h-dvh flex-col page-glow">
      <SkipLink />
      <ModeBanner />
      <header className="sticky top-0 z-30 border-b border-line glass">
        <div className={cn('mx-auto flex flex-wrap items-center gap-x-4 gap-y-2.5 px-6 py-2.5 max-sm:gap-x-2 max-sm:px-4', headerWidth)}>
          <Logo to="/discover" />
          {account ? (
            <div className="max-lg:hidden">
              <RoleNav items={CONSUMER_ACCOUNT_NAV} variant="inline" label="Account" />
            </div>
          ) : (
            <div className="min-w-0 shrink">
              <Location />
            </div>
          )}
          {crumb ? <div className="min-w-0 flex-1 text-sm text-fg-3 max-lg:hidden">{crumb}</div> : null}
          {!account && !crumb && search ? <div className="min-w-[240px] flex-1 max-lg:hidden">{search}</div> : null}
          <div className="ml-auto flex items-center gap-1.5">
            {Actions ? <Actions /> : null}
            {auth.isAuthenticated ? (
              <ButtonLink to="/orders" variant="ghost" className="max-sm:hidden" aria-current={pathname.startsWith('/orders') ? 'page' : undefined}>
                Orders
              </ButtonLink>
            ) : null}
            {auth.isAuthenticated ? Bell ? <Bell /> : <NotificationBell /> : null}
            <ThemeToggle className="max-sm:hidden" />
            <AccountMenu area="consumer" links={accountLinks} />
          </div>
          {!account && !crumb && searchMobile ? <div className="w-full lg:hidden">{searchMobile}</div> : null}
        </div>
      </header>
      <MainRegion className="pb-10 max-sm:pb-28">
        {container === 'bleed' ? (
          (children ?? <Outlet />)
        ) : (
          <div className={cn('mx-auto w-full px-6 pt-6 max-sm:px-4', containers[container as 'discover'])}>{children ?? <Outlet />}</div>
        )}
      </MainRegion>
      <RoleNav items={tabs} variant="bottom" label="Main" />
    </div>
    </ShellSlotContext.Provider>
  );
}
