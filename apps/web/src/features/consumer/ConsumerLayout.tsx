/**
 * Consumer chrome (boards 10, 11, 13; design-spec §3.28, §6.4), mounted as layout routes by routes.tsx
 * (`chrome = 'none'`). Built from the foundation shell parts so it matches `ConsumerShell`, plus what the
 * consumer boards need that the foundation shell has no slot for:
 *   - account menu links Addresses · Thali Plus · Support (10-08)            [foundation gap: AccountMenu links]
 *   - breadcrumb set by the page ("Restaurants / Spice Route", 11-02)
 *   - full-bleed pages (discover cuisine band, restaurant hero) — pages own their containers
 *   - bell aria-label "Notifications, N unread" (10-06)
 *
 * Variants: `discover` (location chip + search) · `restaurant` (breadcrumb + Cart · N) · `account` (ghost nav).
 * ≤1023 search drops to a second row; ≤640 bottom tab bar Home · Search · Orders · Account.
 */
import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useSearchParams } from 'react-router';
import { CONSUMER_ACCOUNT_NAV, CONSUMER_TAB_NAV } from '../../components/layout/ConsumerShell';
import { Logo } from '../../components/layout/Logo';
import { ModeBanner } from '../../components/layout/ModeBanner';
import { RoleNav } from '../../components/layout/RoleNav';
import { AccountMenu, HeaderSearch, MainRegion, SkipLink } from '../../components/layout/ShellParts';
import { Button, ButtonLink, Icon, ThemeToggle } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { plural } from '../../lib/format';
import { useCart, useUnreadNotifications } from './api';
import { useChosenLocation } from './location';

const CartDrawer = lazy(() => import('./CartDrawer'));
const LocationDialog = lazy(() => import('./LocationPicker').then((m) => ({ default: m.LocationDialog })));

/* ------------------------------------------------------------------ page → header slots */

interface ShellSlots {
  setBreadcrumb: (node: ReactNode) => void;
}
const ShellSlotContext = createContext<ShellSlots | null>(null);

/** Restaurant page: `useShellBreadcrumb(<>Restaurants / Spice Route</>)`. Cleared on unmount. */
export function useShellBreadcrumb(node: ReactNode, deps: unknown[]) {
  const ctx = useContext(ShellSlotContext);
  useEffect(() => {
    ctx?.setBreadcrumb(node);
    return () => ctx?.setBreadcrumb(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* ------------------------------------------------------------------ header controls */

/** 10-03 location chip: "Home · 12th Main, Indiranagar" → LocationPicker dialog. */
export function LocationChip() {
  const loc = useChosenLocation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={loc ? `Delivery location: ${loc.label}${loc.address && loc.address !== loc.label ? `, ${loc.address}` : ''}. Change` : 'Choose delivery location'}
        className="flex h-10 min-w-0 max-w-[280px] items-center gap-2.5 rounded-pill border border-line bg-card px-3.5 text-sm hover:border-line-2 max-sm:max-w-[200px] max-sm:gap-1.5 max-sm:px-2.5"
      >
        <Icon name="location" size={16} className="shrink-0 text-acc" />
        <span className="shrink-0 truncate font-semibold text-fg max-sm:shrink">{loc ? loc.label : 'Set location'}</span>
        {loc?.address && loc.address !== loc.label ? <span className="min-w-0 truncate text-fg-3 max-sm:hidden">{loc.address}</span> : null}
        <Icon name="chevron-down" size={14} className="shrink-0 text-fg-3" />
      </button>
      {open ? (
        <Suspense fallback={null}>
          <LocationDialog open onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

/** 11-04 "Cart · 3" (opens the cart drawer). `always` keeps an outline "Cart" visible at 0 items. */
export function CartButton({ always }: { always?: boolean }) {
  const cart = useCart();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const count = cart.data?.itemCount ?? 0;
  if (!count && !always) return null;
  const onCartPage = pathname === '/cart' || pathname.startsWith('/checkout');
  return (
    <>
      <Button
        variant={count ? 'primary' : 'outline'}
        icon="cart"
        onClick={() => setOpen(true)}
        disabled={onCartPage}
        aria-label={count ? `Cart, ${plural(count, 'item')}` : 'Cart, empty'}
        aria-haspopup="dialog"
      >
        <span className="max-sm:hidden">{count ? `Cart · ${count}` : 'Cart'}</span>
        <span className="sm:hidden">{count || ''}</span>
      </Button>
      {open ? (
        <Suspense fallback={null}>
          <CartDrawer open onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}

/** 10-06 bell with unread dot (`GET /notifications` unreadCount). */
export function ConsumerBell() {
  const unread = useUnreadNotifications();
  return (
    <Link
      to="/notifications"
      aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      title="Notifications"
      className="relative grid size-10 place-items-center rounded-pill text-fg-2 hover:bg-fill hover:text-fg [@media(pointer:coarse)]:size-touch"
    >
      <Icon name="bell" size={18} />
      {unread ? <span aria-hidden="true" className="absolute right-2.5 top-[9px] size-[7px] rounded-full bg-acc" /> : null}
    </Link>
  );
}

const ACCOUNT_LINKS = [
  { to: '/account/addresses', label: 'Addresses', icon: 'location' as const },
  { to: '/membership', label: 'Thali Plus', icon: 'star' as const },
  { to: '/support', label: 'Support', icon: 'ticket' as const },
  { to: '/notifications', label: 'Notifications', icon: 'bell' as const },
];

/* ------------------------------------------------------------------ layout */

export interface ConsumerLayoutProps {
  variant: 'discover' | 'restaurant' | 'account';
  children?: ReactNode;
}

export function ConsumerLayout({ variant, children }: ConsumerLayoutProps) {
  const auth = useAuth();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const [breadcrumb, setBreadcrumb] = useState<ReactNode>(null);
  const q = pathname === '/search' ? (params.get('q') ?? '') : '';
  const width = variant === 'discover' ? 'max-w-[1360px]' : 'max-w-[1200px]';
  const showSearch = variant === 'discover';

  return (
    <ShellSlotContext.Provider value={{ setBreadcrumb }}>
      <div className="flex min-h-dvh flex-col page-glow">
        <SkipLink />
        <ModeBanner />
        <header className={cn('z-30 border-b border-line', variant === 'discover' ? 'sticky top-0 glass' : 'relative')}>
          <div className={cn('mx-auto flex flex-wrap items-center gap-x-4 gap-y-2.5 px-6 py-2.5 max-sm:gap-x-2 max-sm:px-4', width)}>
            <Logo />
            {variant === 'account' ? (
              <div className="max-lg:hidden">
                <RoleNav items={CONSUMER_ACCOUNT_NAV} variant="inline" label="Account" />
              </div>
            ) : variant === 'restaurant' ? (
              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm text-fg-3">
                <Link to="/" className="hover:text-fg">
                  Restaurants
                </Link>
                {breadcrumb ? (
                  <>
                    <span aria-hidden="true">/</span>
                    <span aria-current="page" className="truncate text-fg">
                      {breadcrumb}
                    </span>
                  </>
                ) : null}
              </nav>
            ) : (
              <div className="min-w-0 shrink">
                <LocationChip />
              </div>
            )}
            {showSearch ? (
              <div className="min-w-[240px] flex-1 max-lg:hidden">
                <HeaderSearch key={`d-${q}`} defaultValue={q} />
              </div>
            ) : null}
            <div className="ml-auto flex items-center gap-1.5">
              {variant !== 'discover' ? <CartButton always={variant === 'restaurant'} /> : null}
              {auth.isAuthenticated && variant !== 'restaurant' ? (
                <ButtonLink to="/orders" variant="ghost" className={cn('max-sm:hidden', variant === 'account' && 'lg:hidden')} aria-current={pathname.startsWith('/orders') ? 'page' : undefined}>
                  Orders
                </ButtonLink>
              ) : null}
              {auth.isAuthenticated && variant !== 'restaurant' ? <ConsumerBell /> : null}
              <ThemeToggle className="max-sm:hidden" />
              <AccountMenu area="consumer" links={ACCOUNT_LINKS} />
            </div>
            {showSearch ? (
              <div className="w-full lg:hidden">
                <HeaderSearch key={`m-${q}`} defaultValue={q} hotkey={false} />
              </div>
            ) : null}
          </div>
        </header>
        <MainRegion className="pb-10 max-sm:pb-28">{children ?? <Outlet />}</MainRegion>
        <RoleNav items={CONSUMER_TAB_NAV} variant="bottom" label="Main" />
      </div>
    </ShellSlotContext.Provider>
  );
}

/** Standard page container for account-style pages (1200px, page padding). */
export function PageContainer({ children, className, width = 'page' }: { children: ReactNode; className?: string; width?: 'page' | 'discover' | 'narrow' }) {
  const w = width === 'discover' ? 'max-w-[1360px]' : width === 'narrow' ? 'max-w-[760px]' : 'max-w-[1200px]';
  return <div className={cn('mx-auto w-full px-6 pt-7 max-sm:px-4 max-sm:pt-5', w, className)}>{children}</div>;
}
