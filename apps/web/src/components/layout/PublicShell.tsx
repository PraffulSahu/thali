/**
 * Public shell (board 00; design-spec §3.28, §6.2): sticky two-tier header + footer on the long ember glow.
 *
 *   utility bar: demo pill · "Bengaluru · pilot city" · Partner with us · Ride with Thali · Help & support · theme
 *   main bar:    logo · Deliver to (location) · search (`/`) · Offers · Sign in / avatar · Cart (count)
 *
 * Used by the landing (`/welcome`, and `/` when no location is set), the static pages and the marketing
 * pages. Layout route (renders <Outlet/>) or wrapper (`<PublicShell>{page}</PublicShell>`).
 *
 * "Deliver to" focuses the landing address box (`#hero-address`) or navigates to `/welcome#address`.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { hasGuestCart } from '../../lib/guest';
import { useChosenLocation } from '../../lib/location';
import { IconButton } from '../ui/Button';
import { Sheet } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { ThemeSegmented } from '../ui/ThemeToggle';
import { Logo } from './Logo';
import { DemoPill } from './ModeBanner';
import { AccountMenu, HeaderSearch, MainRegion, SkipLink } from './ShellParts';

/** Entry link for a role's onboarding: signed in → the onboarding route, else sign-in with the right tab. */
export function roleEntryHref(role: 'restaurant' | 'partner', signedIn: boolean): string {
  const target = role === 'restaurant' ? '/restaurant/onboarding' : '/partner/onboarding';
  return signedIn ? target : `/signin?role=${role}&next=${encodeURIComponent(target)}`;
}

export const ADDRESS_INPUT_ID = 'hero-address';

/** Focus the landing address box, or go to it. */
export function useFocusAddress() {
  const navigate = useNavigate();
  return () => {
    const el = document.getElementById(ADDRESS_INPUT_ID);
    if (el) {
      el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      el.focus({ preventScroll: true });
    } else {
      navigate('/welcome#address');
    }
  };
}

function useCartCount(): number {
  const auth = useAuth();
  const enabled = auth.isAuthenticated || hasGuestCart();
  const q = useQuery({
    queryKey: ['cart', 'count'],
    queryFn: () => api<{ itemCount?: number }>('/cart', { guest: true }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  return enabled ? (q.data?.itemCount ?? 0) : 0;
}

function LocationButton({ compact }: { compact?: boolean }) {
  const loc = useChosenLocation();
  const focusAddress = useFocusAddress();
  return (
    <button
      type="button"
      onClick={focusAddress}
      aria-label={loc ? `Deliver to ${loc.label}. Change delivery location` : 'Deliver to: Set your location. Choose delivery location'}
      className="flex max-w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-control py-1.5 pl-1.5 pr-2.5 text-left hover:bg-fill max-sm:gap-2 max-sm:px-1"
    >
      <span className="grid size-[34px] shrink-0 place-items-center rounded-item bg-acc-soft text-acc-fg">
        <Icon name="location" size={17} />
      </span>
      <span className={cn('flex min-w-0 flex-col', compact && 'max-sm:max-w-[6.5rem]')}>
        <span className="text-[11px] font-bold uppercase leading-tight tracking-[.08em] text-fg-3 max-sm:hidden">Deliver to</span>
        <span className="flex min-w-0 items-center gap-1 text-[15px] font-extrabold leading-tight text-fg">
          <span className="truncate">{loc ? loc.label : 'Set your location'}</span>
          <Icon name="chevron-down" size={14} className="shrink-0" />
        </span>
      </span>
    </button>
  );
}

function CartLink() {
  const count = useCartCount();
  return (
    <Link
      to="/cart"
      aria-label={count ? `Cart, ${count} ${count === 1 ? 'item' : 'items'}` : 'Cart, empty'}
      className="inline-flex h-12 shrink-0 items-center gap-2 rounded-field border-[1.5px] border-line-2 pl-4 pr-3 text-[15px] font-bold text-fg hover:border-fg-3 max-sm:h-11 max-sm:px-3"
    >
      <Icon name="bag" size={18} />
      <span className="max-sm:hidden">Cart</span>
      <span
        aria-hidden="true"
        className={cn(
          'inline-grid h-5 min-w-5 place-items-center rounded-pill px-1 font-mono text-[11px] font-medium',
          count ? 'bg-pri text-pri-fg' : 'bg-fill text-fg-3',
        )}
      >
        {count > 99 ? '99+' : count}
      </span>
    </Link>
  );
}

const navlink = 'inline-flex items-center gap-[7px] rounded-item px-3 py-2.5 text-[15px] font-semibold text-fg-2 hover:bg-fill hover:text-fg';
const utilLink = 'text-[13px] font-semibold text-fg-2 hover:text-acc-fg';

function SignInLink() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.isAuthenticated) return <AccountMenu area="consumer" />;
  return (
    <Link to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} className={navlink}>
      <Icon name="user" size={17} />
      Sign in
    </Link>
  );
}

function PublicHeader() {
  const navigate = useNavigate();
  const loc = useChosenLocation();
  const focusAddress = useFocusAddress();
  const [menu, setMenu] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMenu(false), [pathname]);
  const onSearch = (q: string) => {
    if (loc) navigate(`/search?q=${encodeURIComponent(q)}`);
    else focusAddress();
  };
  return (
    <header className="sticky top-0 z-30">
      <div className="border-b border-line bg-band backdrop-blur-md">
        <div className="mx-auto flex min-h-10 max-w-[1240px] flex-wrap items-center gap-x-[18px] gap-y-2 px-6 py-1.5 max-sm:px-4">
          <DemoPill />
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-fg-3 max-sm:hidden">
            <Icon name="location" size={14} />
            Bengaluru · pilot city
          </span>
          <nav aria-label="Secondary" className="ml-auto flex items-center gap-5 max-lg:hidden">
            <Link to="/partner-with-us" className={utilLink}>
              Partner with us
            </Link>
            <Link to="/ride-with-thali" className={utilLink}>
              Ride with Thali
            </Link>
            <Link to="/help" className={utilLink}>
              Help &amp; support
            </Link>
          </nav>
          <span aria-hidden="true" className="h-4 w-px bg-line-2 max-lg:hidden" />
          <div className="max-lg:ml-auto">
            <ThemeSegmented className="max-sm:hidden" />
            <ThemeSegmented iconOnly className="sm:hidden" />
          </div>
        </div>
      </div>
      <div className="border-b border-line bg-[color-mix(in_srgb,var(--bg)_80%,transparent)] backdrop-blur-[16px]">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-[18px] gap-y-3 px-6 py-3 max-sm:gap-x-2 max-sm:px-4">
          <Logo size="public" className="max-sm:[&>span]:text-[21px] max-sm:[&>svg]:size-7" />
          <span aria-hidden="true" className="h-8 w-px bg-line max-sm:hidden" />
          <div className="min-w-0 max-sm:flex-1">
            <LocationButton compact />
          </div>
          <div className="min-w-[260px] flex-1 max-lg:hidden">
            <HeaderSearch density="marketing" placeholder="Search for biryani, dosa or a restaurant" onSearch={onSearch} />
          </div>
          <nav aria-label="Account" className="flex items-center gap-1 max-sm:hidden">
            <Link to="/offers" className={navlink}>
              <Icon name="tag" size={17} />
              Offers
            </Link>
            <SignInLink />
          </nav>
          <div className="flex items-center gap-2 max-lg:ml-auto">
            <CartLink />
            <IconButton icon="menu" label="Open menu" size="lg" variant="outline" className="lg:hidden" onClick={() => setMenu(true)} />
          </div>
          <div className="w-full lg:hidden">
            <HeaderSearch density="marketing" hotkey={false} placeholder="Search for biryani, dosa or a restaurant" onSearch={onSearch} />
          </div>
        </div>
      </div>
      <Sheet open={menu} onClose={() => setMenu(false)} title="Menu" side="bottom">
        <nav aria-label="Menu" className="flex flex-col gap-1 pb-2">
          <Link to="/offers" className={navlink}>
            <Icon name="tag" size={17} /> Offers
          </Link>
          <MobileSignIn />
          <Link to="/partner-with-us" className={navlink}>
            <Icon name="store" size={17} /> Partner with us
          </Link>
          <Link to="/ride-with-thali" className={navlink}>
            <Icon name="bike" size={17} /> Ride with Thali
          </Link>
          <Link to="/help" className={navlink}>
            <Icon name="info" size={17} /> Help &amp; support
          </Link>
        </nav>
      </Sheet>
    </header>
  );
}

function MobileSignIn() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  if (auth.isAuthenticated) {
    return (
      <>
        <Link to="/account" className={navlink}>
          <Icon name="user" size={17} /> Your account
        </Link>
        <Link to="/orders" className={navlink}>
          <Icon name="receipt" size={17} /> Your orders
        </Link>
        <button
          type="button"
          className={cn(navlink, 'w-full text-left')}
          onClick={async () => {
            await auth.signOut();
            navigate('/');
          }}
        >
          <Icon name="logout" size={17} /> Sign out
        </button>
      </>
    );
  }
  return (
    <Link to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} className={navlink}>
      <Icon name="user" size={17} /> Sign in
    </Link>
  );
}

function FooterCol({ title, links }: { title: string; links: Array<{ to: string; label: string }> }) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-sans text-[13px] font-extrabold uppercase tracking-[.1em] text-fg-3">{title}</h2>
      <ul className="flex flex-col gap-2">
        {links.map((l) => (
          <li key={l.label}>
            <Link to={l.to} className="text-[14.5px] font-semibold text-fg-2 hover:text-acc-fg">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PublicFooter() {
  const auth = useAuth();
  const signedIn = auth.isAuthenticated;
  return (
    <footer className="border-t border-line bg-band backdrop-blur-md">
      <div className="mx-auto grid max-w-[1240px] grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-10 px-6 py-12 max-sm:px-4">
        <div className="flex flex-col gap-3">
          <Logo size="footer" />
          <p className="max-w-[16rem] text-[14.5px] text-fg-3">Food from many kitchens, one checkout. Bengaluru pilot.</p>
        </div>
        <FooterCol
          title="Eat"
          links={[
            { to: '/', label: 'Restaurants' },
            { to: '/membership', label: 'Thali Plus' },
            { to: '/orders', label: 'Your orders' },
          ]}
        />
        <FooterCol
          title="Partner"
          links={[
            { to: roleEntryHref('restaurant', signedIn), label: 'List a restaurant' },
            { to: roleEntryHref('partner', signedIn), label: 'Ride with Thali' },
            { to: '/signin?role=admin', label: 'Ops sign in' },
          ]}
        />
        <FooterCol
          title="Help"
          links={[
            { to: '/help', label: 'Support' },
            { to: '/refunds', label: 'Refunds' },
            { to: '/terms', label: 'Terms' },
            { to: '/privacy', label: 'Privacy' },
          ]}
        />
      </div>
      <div className="border-t border-line">
        <p className="mx-auto flex max-w-[1240px] flex-wrap justify-between gap-2 px-6 py-4 text-[13px] text-fg-3 max-sm:px-4">
          <span>© 2026 Thali</span>
          <span>Prices in INR · Times in IST</span>
        </p>
      </div>
    </footer>
  );
}

export function PublicShell({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col page-glow-long">
      <SkipLink />
      <PublicHeader />
      <MainRegion>{children ?? <Outlet />}</MainRegion>
      <PublicFooter />
    </div>
  );
}
