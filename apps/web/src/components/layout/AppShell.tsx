/**
 * Page chrome for each role area. RoleArea renders it automatically around every area route, so feature
 * pages only render their content (start with <PageHeader>).
 *
 * consumer   : sticky top bar (logo, area HeaderActions such as location/cart, inline nav on desktop,
 *              account menu) + mobile bottom tab bar
 * restaurant : top bar + desktop sidebar; mobile drawer
 * partner    : top bar + mobile bottom tab bar (riders are on phones) + desktop sidebar
 * admin      : top bar + desktop sidebar; mobile drawer
 *
 * Every variant: skip link, ModeBanner, <main id="main"> with a max width, account menu with sign-out and
 * links to the other areas the user has roles for.
 */
import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { formatPhone } from '../../lib/format';
import { ButtonLink, IconButton } from '../ui/Button';
import { Sheet } from '../ui/Dialog';
import { Icon, type IconName } from '../ui/Icon';
import { Logo } from './Logo';
import { ModeBanner } from './ModeBanner';
import { RoleNav, type NavItem } from './RoleNav';

export type AreaKey = 'consumer' | 'restaurant' | 'partner' | 'admin';

const AREA_META: Record<AreaKey, { subtitle?: string; home: string; navLabel: string; signInPath: string }> = {
  consumer: { home: '/', navLabel: 'Main', signInPath: '/signin' },
  restaurant: { subtitle: 'for Restaurants', home: '/restaurant', navLabel: 'Restaurant', signInPath: '/signin' },
  partner: { subtitle: 'Partner', home: '/partner', navLabel: 'Partner', signInPath: '/signin' },
  admin: { subtitle: 'Admin', home: '/admin', navLabel: 'Admin', signInPath: '/admin/login' },
};

export interface AppShellProps {
  variant: AreaKey;
  children: ReactNode;
  nav?: NavItem[];
  /** Area-specific header controls (e.g. consumer location chip + cart button). */
  HeaderActions?: ComponentType;
  /** Hide navigation (e.g. admin login, or a user without the area's role). */
  showNav?: boolean;
  /** Full-bleed main (maps, boards) instead of the centered max-width column. */
  wide?: boolean;
}

export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only z-[70] rounded-control bg-surface px-4 py-3 font-semibold text-brand-700 shadow-overlay focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
    >
      Skip to main content
    </a>
  );
}

function AccountMenu({ variant }: { variant: AreaKey }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (auth.status === 'loading') return <span className="size-touch" aria-hidden="true" />;
  if (!auth.isAuthenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    return (
      <ButtonLink to={`${AREA_META[variant].signInPath}?next=${next}`} variant="secondary" size="sm" icon="user">
        Sign in
      </ButtonLink>
    );
  }

  const name = auth.user?.name || formatPhone(auth.user?.phone) || auth.user?.email || 'Account';
  const areaLinks: Array<{ to: string; label: string; icon: IconName; show: boolean }> = [
    { to: '/', label: 'Order food', icon: 'home', show: variant !== 'consumer' },
    { to: '/restaurant', label: 'Restaurant dashboard', icon: 'store', show: variant !== 'restaurant' && auth.hasRole('RESTAURANT_OWNER') },
    { to: '/partner', label: 'Partner app', icon: 'bike', show: variant !== 'partner' && auth.hasRole('DELIVERY_PARTNER') },
    { to: '/admin', label: 'Admin console', icon: 'shield', show: variant !== 'admin' && auth.hasRole('ADMIN') },
  ];

  const signOut = async () => {
    setOpen(false);
    await auth.signOut();
    navigate(variant === 'admin' ? '/admin/login' : '/');
  };

  const item = 'flex min-h-touch w-full items-center gap-3 rounded-control px-3 text-left text-[0.9375rem] text-slate-700 hover:bg-slate-100 hover:text-slate-900';
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-touch items-center gap-2 rounded-control px-2 text-slate-700 hover:bg-slate-100"
      >
        <span className="grid size-8 place-items-center rounded-full bg-brand-100 text-sm font-bold text-brand-800" aria-hidden="true">
          {name.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '?'}
        </span>
        <span className="hidden max-w-36 truncate text-sm font-medium lg:inline">{name}</span>
        <span className="sr-only lg:hidden">Account menu</span>
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div
          id={panelId}
          className="absolute right-0 top-full z-40 mt-2 w-64 animate-pop-in rounded-card border border-slate-200 bg-surface p-2 shadow-overlay"
        >
          <p className="truncate px-3 pb-2 pt-1 text-sm text-slate-500">Signed in as {name}</p>
          <ul className="border-t border-slate-100 pt-1">
            {variant === 'consumer' ? (
              <>
                <li><Link to="/account" className={item}><Icon name="user" size={18} />Profile</Link></li>
                <li><Link to="/orders" className={item}><Icon name="receipt" size={18} />Your orders</Link></li>
              </>
            ) : null}
            {areaLinks.filter((l) => l.show).map((l) => (
              <li key={l.to}>
                <Link to={l.to} className={item}>
                  <Icon name={l.icon} size={18} />
                  {l.label}
                </Link>
              </li>
            ))}
            <li className="mt-1 border-t border-slate-100 pt-1">
              <button type="button" onClick={() => void signOut()} className={item}>
                <Icon name="logout" size={18} />
                Sign out
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({ variant, children, nav = [], HeaderActions, showNav = true, wide }: AppShellProps) {
  const meta = AREA_META[variant];
  const [drawer, setDrawer] = useState(false);
  const items = showNav ? nav : [];
  const consumerLike = variant === 'consumer';
  const bottomBar = (variant === 'consumer' || variant === 'partner') && items.length > 0;
  const sidebar = !consumerLike && items.length > 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <ModeBanner />
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-surface/90 backdrop-blur-md">
        <div className={cn('mx-auto flex h-16 items-center gap-2 px-4 sm:gap-4', consumerLike ? 'max-w-content' : 'max-w-none lg:px-6')}>
          {sidebar && variant !== 'partner' ? (
            <IconButton icon="menu" label="Open navigation" className="-ml-2 md:hidden" onClick={() => setDrawer(true)} />
          ) : null}
          <Logo to={meta.home} subtitle={meta.subtitle} />
          {consumerLike ? <div className="ml-4"><RoleNav items={items} variant="inline" label={meta.navLabel} /></div> : null}
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {HeaderActions ? <HeaderActions /> : null}
            <AccountMenu variant={variant} />
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        {sidebar ? (
          <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-64 shrink-0 self-start overflow-y-auto border-r border-slate-200 bg-surface-muted px-3 py-4 md:block">
            <RoleNav items={items} variant="sidebar" label={meta.navLabel} />
          </aside>
        ) : null}
        <main
          id="main"
          tabIndex={-1}
          className={cn(
            'w-full flex-1 px-4 py-6 focus:outline-none sm:py-8',
            wide ? 'max-w-none lg:px-6' : consumerLike ? 'mx-auto max-w-content' : 'mx-auto max-w-6xl lg:px-8',
            bottomBar && 'pb-24 md:pb-8',
          )}
        >
          {children}
        </main>
      </div>

      {bottomBar ? <RoleNav items={items} variant="bottom" label={meta.navLabel} /> : null}
      {sidebar && variant !== 'partner' ? (
        <Sheet open={drawer} onClose={() => setDrawer(false)} title={`${meta.navLabel} navigation`} side="left" hideTitle>
          <RoleNav items={items} variant="drawer" label={meta.navLabel} onNavigate={() => setDrawer(false)} />
        </Sheet>
      ) : null}
    </div>
  );
}
