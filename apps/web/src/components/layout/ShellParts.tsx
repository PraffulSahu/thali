/**
 * Pieces shared by the shells: skip link, account menu (avatar + sign-out), header search with the `/`
 * shortcut, notification bell, sign-in link. Exported so role areas can compose custom headers.
 *
 *   <AccountMenu area="consumer" />                 // avatar button → Profile, Orders, other areas, Sign out
 *   <HeaderSearch placeholder="Search restaurants or dishes" onSearch={(q) => navigate(`/search?q=${q}`)} />
 *   <NotificationBell unread={hasUnread} />          // links to /notifications, 7px --acc dot when unread
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useHotkey } from '../../hooks/useHotkey';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { formatPhone } from '../../lib/format';
import { Avatar } from '../ui/Avatar';
import { ButtonLink } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { Kbd } from '../ui/Typography';

export type AreaKey = 'consumer' | 'restaurant' | 'partner' | 'admin';

export const AREA_HOME: Record<AreaKey, string> = { consumer: '/', restaurant: '/restaurant', partner: '/partner', admin: '/admin' };

/** Where each area sends signed-out users (keeps `?next=`). */
export function signInHref(area: AreaKey, next: string): string {
  const role = area === 'consumer' ? 'customer' : area;
  return `/signin?role=${role}&next=${encodeURIComponent(next)}`;
}

export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only z-[70] rounded-control bg-card px-4 py-3 font-semibold text-acc-fg shadow-modal focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
    >
      Skip to main content
    </a>
  );
}

/** Display name for the signed-in user (name, phone or email). */
export function useDisplayName(): string {
  const auth = useAuth();
  return auth.user?.name || formatPhone(auth.user?.phone) || auth.user?.email || 'Account';
}

function avatarUrl(user: { [k: string]: unknown } | null): string | null {
  const v = user?.avatarUrl;
  return typeof v === 'string' && v ? v : null;
}

export interface AccountMenuProps {
  area: AreaKey;
  /** Show the name next to the avatar on wide screens. */
  showName?: boolean;
  /** Extra links at the top of the menu. */
  links?: Array<{ to: string; label: string; icon: IconName }>;
  /** Avatar size (36 header default). */
  size?: number;
  /** Menu opens upwards (sidebar footer). */
  placement?: 'down' | 'up';
  /** 'avatar' (default) or a compact "⋯" button (sidebar footer next to the user block). */
  trigger?: 'avatar' | 'more';
  className?: string;
}

export function AccountMenu({ area, showName, links, size = 36, placement = 'down', trigger = 'avatar', className }: AccountMenuProps) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const name = useDisplayName();

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Disclosure pattern (button + list of links): Escape closes and returns focus to the trigger.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (auth.status === 'loading') return <span className="size-9" aria-hidden="true" />;
  if (!auth.isAuthenticated) {
    return (
      <ButtonLink to={signInHref(area, location.pathname + location.search)} variant="ghost" size="md" icon="user" className={className}>
        Sign in
      </ButtonLink>
    );
  }

  const areaLinks: Array<{ to: string; label: string; icon: IconName; show: boolean }> = [
    { to: '/', label: 'Order food', icon: 'bowl', show: area !== 'consumer' },
    { to: '/restaurant', label: 'Restaurant console', icon: 'store', show: area !== 'restaurant' && auth.hasRole('RESTAURANT_OWNER') },
    { to: '/partner', label: 'Partner app', icon: 'bike', show: area !== 'partner' && auth.hasRole('DELIVERY_PARTNER') },
    { to: '/admin', label: 'Ops console', icon: 'shield', show: area !== 'admin' && auth.hasRole('ADMIN') },
  ];
  const consumerLinks: Array<{ to: string; label: string; icon: IconName }> =
    area === 'consumer'
      ? [
          { to: '/account', label: 'Profile', icon: 'user' },
          { to: '/orders', label: 'Your orders', icon: 'receipt' },
        ]
      : [];

  const signOut = async () => {
    setOpen(false);
    await auth.signOut();
    navigate(area === 'consumer' ? '/' : signInHref(area, AREA_HOME[area]));
  };

  const item = 'flex min-h-10 w-full items-center gap-3 rounded-item px-3 text-left text-sm text-fg-2 hover:bg-fill hover:text-fg [@media(pointer:coarse)]:min-h-touch';
  return (
    <div ref={ref} className={cn('relative', className)}>
      {trigger === 'more' ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          ref={triggerRef}
          aria-label="Account menu"
          title="Account menu"
          onClick={() => setOpen((o) => !o)}
          className="grid size-8 place-items-center rounded-pill text-fg-3 hover:bg-fill hover:text-fg [@media(pointer:coarse)]:size-touch"
        >
          <Icon name="more" size={18} />
        </button>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          ref={triggerRef}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-2 rounded-pill text-fg hover:opacity-90"
        >
          <Avatar name={name} src={avatarUrl(auth.user)} size={size} bordered />
          {showName ? <span className="hidden max-w-36 truncate text-[13.5px] font-medium lg:inline">{name}</span> : null}
          <span className="sr-only">Account menu</span>
        </button>
      )}
      {open ? (
        <div
          id={panelId}
          className={cn(
            'absolute right-0 z-40 w-64 animate-pop-in rounded-card border border-line bg-card p-2 shadow-modal',
            placement === 'up' ? 'bottom-full left-0 right-auto mb-2' : 'top-full mt-2',
          )}
        >
          <p className="truncate px-3 pb-2 pt-1 text-[13px] text-fg-3">Signed in as {name}</p>
          <ul className="border-t border-line pt-1">
            {[...(links ?? []), ...consumerLinks].map((l) => (
              <li key={l.to}>
                <Link to={l.to} className={item}>
                  <Icon name={l.icon} size={17} />
                  {l.label}
                </Link>
              </li>
            ))}
            {areaLinks
              .filter((l) => l.show)
              .map((l) => (
                <li key={l.to}>
                  <Link to={l.to} className={item}>
                    <Icon name={l.icon} size={17} />
                    {l.label}
                  </Link>
                </li>
              ))}
            <li className="mt-1 border-t border-line pt-1">
              <button type="button" onClick={() => void signOut()} className={item}>
                <Icon name="logout" size={17} />
                Sign out
              </button>
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export interface HeaderSearchProps {
  placeholder?: string;
  /** Called with the trimmed query on submit. Default: navigate to /search?q=. */
  onSearch?: (q: string) => void;
  /** marketing = public header (48px, 1.5px border); app = consumer header (40px pill on --bg2). */
  density?: 'marketing' | 'app';
  /** Register the global `/` shortcut (default true). Only one search per page should. */
  hotkey?: boolean;
  defaultValue?: string;
  className?: string;
}

export function HeaderSearch({ placeholder = 'Search restaurants or dishes', onSearch, density = 'app', hotkey = true, defaultValue = '', className }: HeaderSearchProps) {
  const navigate = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(defaultValue);
  const id = useId();
  useHotkey('/', () => ref.current?.focus(), { enabled: hotkey });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    if (onSearch) onSearch(query);
    else navigate(`/search?q=${encodeURIComponent(query)}`);
  };
  const mk = density === 'marketing';
  return (
    <form role="search" onSubmit={submit} className={cn('min-w-0', className)}>
      <label
        htmlFor={id}
        className={cn(
          'flex w-full cursor-text items-center gap-2.5 transition-[border-color,box-shadow] duration-150',
          mk
            ? 'h-12 rounded-field border-[1.5px] border-line-2 bg-card pl-3.5 pr-2.5 focus-within:border-pri focus-within:shadow-[0_0_0_4px_var(--acc-soft)]'
            : 'h-10 rounded-pill border border-line bg-bg-2 px-3.5 focus-within:border-fg-3 focus-within:shadow-[0_0_0_4px_var(--muted)]',
        )}
      >
        <Icon name="search" size={mk ? 18 : 16} className="shrink-0 text-fg-3" />
        <span className="sr-only">Search</span>
        <input
          ref={ref}
          id={id}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-keyshortcuts={hotkey ? '/' : undefined}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden',
            mk ? 'text-[15px] font-medium' : 'text-sm',
          )}
        />
        {hotkey ? (
          <Kbd className={cn('max-sm:hidden', mk && 'rounded-xs border-line-2 border-b-2 px-[7px]')}>/</Kbd>
        ) : null}
      </label>
    </form>
  );
}

export function NotificationBell({ unread, to = '/notifications', className }: { unread?: boolean; to?: string; className?: string }) {
  return (
    <Link
      to={to}
      aria-label={unread ? 'Notifications, unread' : 'Notifications'}
      title="Notifications"
      className={cn('relative grid size-10 place-items-center rounded-pill text-fg-2 hover:bg-fill hover:text-fg [@media(pointer:coarse)]:size-touch', className)}
    >
      <Icon name="bell" size={18} />
      {unread ? <span aria-hidden="true" className="absolute right-2.5 top-[9px] size-[7px] rounded-full bg-acc" /> : null}
    </Link>
  );
}

/** Main landmark used by every shell (focus target after navigation). */
export function MainRegion({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <main id="main" tabIndex={-1} className={cn('w-full flex-1 focus:outline-none', className)}>
      {children}
    </main>
  );
}
