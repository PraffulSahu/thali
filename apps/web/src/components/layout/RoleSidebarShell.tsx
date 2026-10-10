/**
 * Role shell for restaurant (KITCHEN), partner (PARTNER) and admin (OPS) — boards 20 / 30 / 40.
 *
 *   ≥1024   sidebar 232px (admin 224): logo + role tag · context slot · nav (badges) · footer (user + theme)
 *   641–1023 72px icon rail (logo mark, nav icons with tooltips, avatar + theme)
 *   ≤640    56px top bar (logo mark + role tag + context + avatar) and a bottom tab bar (+ "More" drawer)
 *
 * Mount it as a layout route (renders <Outlet/> when no children) or let the area auto-chrome do it:
 *
 *   // features/restaurant/routes.tsx — auto chrome reads these exports:
 *   export const nav: NavItem[] = [...];
 *   export const shell: RoleShellConfig = { Context: RestaurantSwitcher, mobileContext: RestaurantName };
 *
 *   // or explicitly (export const chrome = 'none' and wrap your routes):
 *   { element: <RoleSidebarShell role="restaurant" nav={nav} context={<RestaurantSwitcher />} />, children: [...] }
 *
 * Context slot examples (design-spec §3.27): restaurant switcher (`<SidebarSwitcher>`), partner profile card
 * (`<SidebarProfileCard>`), admin search button (`<SidebarSearchButton>`).
 */
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { Avatar } from '../ui/Avatar';
import { Sheet } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { ThemeToggle } from '../ui/ThemeToggle';
import { Kbd, RoleTag } from '../ui/Typography';
import { Logo, LogoMark } from './Logo';
import { ModeBanner } from './ModeBanner';
import { RoleNav, type NavItem } from './RoleNav';
import { AccountMenu, AREA_HOME, MainRegion, SkipLink, useDisplayName, type AreaKey } from './ShellParts';

export type ShellRole = Exclude<AreaKey, 'consumer'>;

const ROLE_META: Record<ShellRole, { tag: string; subtitle: string; navLabel: string; userRole: string }> = {
  restaurant: { tag: 'KITCHEN', subtitle: 'for Restaurants', navLabel: 'Restaurant', userRole: 'Owner' },
  partner: { tag: 'PARTNER', subtitle: 'Partner', navLabel: 'Partner', userRole: 'Delivery partner' },
  admin: { tag: 'OPS', subtitle: 'Admin', navLabel: 'Admin', userRole: 'Ops admin' },
};

/** Slots a role area can provide (as components, so they can use hooks). */
export interface RoleShellConfig {
  /** Sidebar context block (switcher / profile card / search button). */
  Context?: ComponentType;
  /** Compact context for the ≤640 top bar (restaurant name, online pill, search icon). */
  MobileContext?: ComponentType;
  /** Replaces the default footer user block (partner: status chip + theme). Theme toggle is added for you. */
  Footer?: ComponentType;
  /** Sub-line under the user's name ("Owner", "Ops admin · MFA on"). */
  userSubtitle?: string;
  /** Full-bleed main column (maps, boards). */
  wide?: boolean;
}

export interface RoleSidebarShellProps extends RoleShellConfig {
  role: ShellRole;
  nav?: NavItem[];
  /** Hide navigation (signed-out guard screens, onboarding without the role). */
  showNav?: boolean;
  children?: ReactNode;
}

function UserBlock({ subtitle, collapsed }: { subtitle: string; collapsed?: boolean }) {
  const auth = useAuth();
  const name = useDisplayName();
  if (!auth.isAuthenticated) return null;
  const src = typeof auth.user?.avatarUrl === 'string' ? (auth.user.avatarUrl as string) : null;
  if (collapsed) return <Avatar name={name} src={src} size={32} />;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar name={name} src={src} size={32} />
      <div className="min-w-0">
        <p className="truncate text-[13.5px] font-medium text-fg">{name}</p>
        <p className="truncate text-xs text-fg-3">{subtitle}</p>
      </div>
    </div>
  );
}

export function RoleSidebarShell({ role, nav = [], showNav = true, Context, MobileContext, Footer, userSubtitle, wide, children }: RoleSidebarShellProps) {
  const meta = ROLE_META[role];
  const auth = useAuth();
  const { pathname } = useLocation();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    setDrawer(false);
    // ≥641px the main column is the scroll container: reset it on navigation.
    document.getElementById('main')?.scrollTo?.({ top: 0 });
  }, [pathname]);
  const items = showNav ? nav : [];
  const hasNav = items.length > 0;
  const admin = role === 'admin';
  const subtitle = userSubtitle ?? (admin ? `${meta.userRole}${auth.hasMfa ? ' · MFA on' : ''}` : meta.userRole);
  const home = AREA_HOME[role];

  return (
    <div className="flex min-h-dvh flex-col page-glow sm:h-dvh sm:min-h-0 sm:overflow-hidden">
      <SkipLink />
      <ModeBanner />

      {/* ≤640: top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2.5 border-b border-line px-4 glass sm:hidden">
        <Logo to={home} subtitle={meta.subtitle} markOnly size="sidebar" />
        <RoleTag>{meta.tag}</RoleTag>
        <div className="min-w-0 flex-1">{MobileContext ? <MobileContext /> : null}</div>
        <ThemeToggle size="sm" />
        <AccountMenu area={role} size={32} />
      </header>

      <div className="flex flex-1 sm:min-h-0">
        {/* ≥641: rail (tablet) / sidebar (desktop) */}
        <aside
          className={cn(
            'hidden shrink-0 flex-col overflow-y-auto border-r border-line bg-side backdrop-blur-md sm:flex',
            'w-[72px] items-center gap-4 px-2 py-[18px] lg:items-stretch',
            admin ? 'lg:w-[224px] lg:gap-4 lg:px-3' : 'lg:w-[232px] lg:gap-[18px] lg:px-3.5',
          )}
        >
          <div className="flex items-center gap-2 lg:px-1.5">
            <Logo to={home} subtitle={meta.subtitle} size="sidebar" className="max-lg:hidden" />
            <span className="lg:hidden">
              <Logo to={home} subtitle={meta.subtitle} size="sidebar" markOnly />
            </span>
            <RoleTag className="ml-auto max-lg:hidden">{meta.tag}</RoleTag>
          </div>
          {Context && hasNav ? (
            <div className="max-lg:hidden">
              <Context />
            </div>
          ) : null}
          {hasNav ? (
            <div className="min-h-0 flex-1 overflow-y-auto max-lg:w-full">
              <div className="max-lg:hidden">
                <RoleNav items={items} variant="sidebar" label={meta.navLabel} dense={admin} />
              </div>
              <div className="lg:hidden">
                <RoleNav items={items} variant="rail" label={meta.navLabel} />
              </div>
            </div>
          ) : (
            <div className="flex-1" />
          )}
          <div className="flex items-center gap-2.5 border-t border-line pt-2.5 max-lg:flex-col lg:px-1.5">
            <div className="min-w-0 flex-1 max-lg:hidden">{Footer ? <Footer /> : <UserBlock subtitle={subtitle} />}</div>
            <div className="lg:hidden">
              <AccountMenu area={role} size={32} placement="up" />
            </div>
            {auth.isAuthenticated ? (
              <div className="max-lg:hidden">
                <AccountMenu area={role} trigger="more" placement="up" />
              </div>
            ) : null}
            <ThemeToggle size="sm" />
          </div>
        </aside>

        <MainRegion
          className={cn(
            'min-w-0 sm:overflow-y-auto',
            admin ? 'px-[clamp(16px,2.4vw,32px)] pb-10 pt-6' : 'px-[clamp(16px,2.4vw,32px)] pb-10 pt-[22px]',
            hasNav && 'max-sm:pb-24',
          )}
        >
          <div className={cn(wide ? 'max-w-none' : 'mx-auto max-w-[1400px]')}>{children ?? <Outlet />}</div>
        </MainRegion>
      </div>

      {hasNav ? <RoleNav items={items} variant="bottom" label={meta.navLabel} onMore={() => setDrawer(true)} /> : null}
      {hasNav ? (
        <Sheet open={drawer} onClose={() => setDrawer(false)} title={`${meta.navLabel} navigation`} side="bottom">
          {Context ? (
            <div className="mb-3">
              <Context />
            </div>
          ) : null}
          <RoleNav items={items} variant="drawer" label={meta.navLabel} onNavigate={() => setDrawer(false)} />
        </Sheet>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ context-slot building blocks */

/** Restaurant switcher button (52px outline, initials tile, name + area, up-down chevrons). */
export function SidebarSwitcher({ name, area, onClick, label = 'Switch restaurant' }: { name: string; area?: string; onClick?: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}. Current: ${name}`}
      className="flex h-[52px] w-full items-center gap-2.5 rounded-control border border-line bg-card px-2.5 text-left hover:border-line-2"
    >
      <span aria-hidden="true" className="grid size-[30px] shrink-0 place-items-center rounded-badge bg-acc-soft text-xs font-semibold text-acc-fg">
        {name
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0]!.toUpperCase())
          .join('')}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{name}</span>
        {area ? <span className="block truncate text-xs text-fg-3">{area}</span> : null}
      </span>
      <Icon name="chevrons-up-down" size={14} className="shrink-0 text-fg-3" />
    </button>
  );
}

/** Partner profile card (36px avatar, name, mono vehicle line). */
export function SidebarProfileCard({ name, detail, avatarUrl }: { name: string; detail?: string; avatarUrl?: string | null }) {
  return (
    <div className="flex items-center gap-2.5 rounded-card border border-line bg-card p-3">
      <Avatar name={name} src={avatarUrl} size={36} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-fg">{name}</p>
        {detail ? <p className="truncate font-mono text-[11.5px] text-fg-3">{detail}</p> : null}
      </div>
    </div>
  );
}

/** Admin search button ("Search orders, phones…" + ⌘K). Wire `onClick` to your command palette. */
export function SidebarSearchButton({ onClick, placeholder = 'Search orders, phones…' }: { onClick: () => void; placeholder?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-9 w-full items-center gap-2 rounded-item border border-line bg-card px-2.5 text-[13px] text-fg-3 hover:border-line-2"
    >
      <Icon name="search" size={14} />
      <span className="flex-1 truncate text-left">{placeholder}</span>
      <Kbd className="rounded-[4px] px-[5px] py-px text-[10.5px]">⌘K</Kbd>
    </button>
  );
}

export { LogoMark };
