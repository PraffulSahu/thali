/**
 * Role shell for restaurant (KITCHEN), partner (PARTNER) and admin (OPS) — boards 20 / 30 / 40.
 *
 *   ≥1024   sidebar 232px (admin 224): logo + role tag · context slot · nav (badges) · footer (user + theme)
 *   641–1023 72px icon rail (logo mark, `railContext` tile, nav icons with tooltips, avatar + theme)
 *   ≤640    56px top bar (logo mark + role tag + context + avatar) and a bottom tab bar (+ "More" drawer); the tab
 *           bar shows the role's ordered `tabs` (restaurant Live orders · Dashboard · Menu · Finance; partner Home ·
 *           History · Earnings · Profile; admin Overview · Orders · Deliveries · Approvals) + More
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
import { useEffect, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { Avatar } from '../ui/Avatar';
import { Sheet } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { ThemeToggle } from '../ui/ThemeToggle';
import { Popover } from '../ui/Popover';
import { Kbd, RoleTag } from '../ui/Typography';
import { Logo, LogoMark } from './Logo';
import { ModeBanner } from './ModeBanner';
import { RoleNav, type NavItem, type RoleTab } from './RoleNav';
import { AccountMenu, AREA_HOME, MainRegion, SkipLink, type AreaKey } from './ShellParts';

export type ShellRole = Exclude<AreaKey, 'consumer'>;

const ROLE_META: Record<ShellRole, { tag: string; subtitle: string; navLabel: string; userRole: string }> = {
  restaurant: { tag: 'KITCHEN', subtitle: 'for Restaurants', navLabel: 'Restaurant', userRole: 'Owner' },
  partner: { tag: 'PARTNER', subtitle: 'Partner', navLabel: 'Partner', userRole: 'Delivery partner' },
  admin: { tag: 'OPS', subtitle: 'Admin', navLabel: 'Admin', userRole: 'Ops admin' },
};

/** Default phone tab bars (design-spec §6.5). Paths not in the area's nav are dropped unless they carry an icon. */
export const ROLE_TABS: Record<ShellRole, RoleTab[]> = {
  restaurant: [
    { to: '/restaurant/orders', label: 'Live orders' },
    { to: '/restaurant', label: 'Dashboard' },
    { to: '/restaurant/menu', label: 'Menu' },
    { to: '/restaurant/finance', label: 'Finance' },
  ],
  partner: [
    { to: '/partner', label: 'Home' },
    { to: '/partner/history', label: 'History' },
    { to: '/partner/earnings', label: 'Earnings' },
    { to: '/partner/onboarding', label: 'Profile' },
  ],
  admin: [
    { to: '/admin', label: 'Overview' },
    { to: '/admin/orders', label: 'Orders' },
    { to: '/admin/tms', label: 'Deliveries' },
    { to: '/admin/restaurants?status=APPROVAL_PENDING', label: 'Approvals', icon: 'check-circle' },
  ],
};

const ADMIN_SUB_ROLES = ['SUPER_ADMIN', 'OPS', 'FINANCE', 'SUPPORT'] as const;
const ADMIN_TAG: Record<string, string> = { SUPER_ADMIN: 'SUPER', OPS: 'OPS', FINANCE: 'FINANCE', SUPPORT: 'SUPPORT' };
const ADMIN_NAME: Record<string, string> = { SUPER_ADMIN: 'Super', OPS: 'Ops', FINANCE: 'Finance', SUPPORT: 'Support' };

/** Admin role tag from the session's sub-roles (board 40-01): SUPER · OPS · FINANCE · SUPPORT (first held). */
export function adminRoleTag(adminRoles: readonly string[]): string {
  const r = ADMIN_SUB_ROLES.find((x) => adminRoles.includes(x));
  return r ? ADMIN_TAG[r]! : 'OPS';
}

/** "Ops admin · MFA on" / "Finance · Support admin" from the session's admin sub-roles. */
export function adminUserSubtitle(adminRoles: readonly string[], mfa: boolean): string {
  const names = ADMIN_SUB_ROLES.filter((r) => adminRoles.includes(r)).map((r) => ADMIN_NAME[r]);
  const role = names.length ? `${names.join(' · ')} admin` : 'Ops admin';
  return mfa ? `${role} · MFA on` : role;
}

/** Slots a role area can provide (as components, so they can use hooks). */
export interface RoleShellConfig {
  /** Sidebar context block (switcher / profile card / search button). */
  Context?: ComponentType;
  /**
   * Also show `Context` in the 641–1023 icon rail. Only for blocks that collapse with the `rail:` variant
   * (SidebarSwitcher → initials tile opening its menu to the right, SidebarSearchButton → search icon,
   * SidebarProfileCard → avatar). Default false (hidden in the rail, reachable from the "More" drawer on phones).
   */
  railContext?: boolean;
  /** Compact context for the ≤640 top bar (restaurant name, online pill, search icon). */
  MobileContext?: ComponentType;
  /** Replaces the default footer user block (partner: status chip + theme). Theme toggle + "⋯" menu are added for you. */
  Footer?: ComponentType;
  /** Sub-line under the user's name ("Owner"; admin default "<Sub-role> admin · MFA on" from the session). */
  userSubtitle?: string;
  /** Role tag next to the logo (KITCHEN / PARTNER / OPS). A component can read the session; admin default = sub-role. */
  roleTag?: string | ComponentType;
  /** Phone tab bar: ordered destinations (default ROLE_TABS[role]); `false` = legacy `primary` / first-4 rule. */
  tabs?: RoleTab[] | false;
  /** Account menu: "Sign out of all devices" (with confirm) above Sign out. */
  signOutAll?: boolean;
  /** Extra account-menu items above "Sign out" (render <AccountMenuItem>s; `close` closes the menu). */
  AccountExtras?: ComponentType<{ close: () => void }>;
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

function TagContent({ role, roleTag }: { role: ShellRole; roleTag?: string | ComponentType }) {
  const auth = useAuth();
  if (typeof roleTag === 'function') {
    const Tag = roleTag;
    return <Tag />;
  }
  if (typeof roleTag === 'string') return <>{roleTag}</>;
  return <>{role === 'admin' ? adminRoleTag(auth.adminRoles ?? []) : ROLE_META[role].tag}</>;
}

export function RoleSidebarShell({
  role,
  nav = [],
  showNav = true,
  Context,
  railContext = false,
  MobileContext,
  Footer,
  userSubtitle,
  roleTag,
  tabs,
  AccountExtras,
  signOutAll,
  wide,
  children,
}: RoleSidebarShellProps) {
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
  const subtitle = userSubtitle ?? (admin ? adminUserSubtitle(auth.adminRoles ?? [], auth.hasMfa) : meta.userRole);
  const home = AREA_HOME[role];
  const tabItems = tabs === false ? undefined : (tabs ?? ROLE_TABS[role]);
  const extra = AccountExtras ? (close: () => void) => <AccountExtras close={close} /> : undefined;
  const tag = <TagContent role={role} roleTag={roleTag} />;

  return (
    <div className="flex min-h-dvh flex-col page-glow sm:h-dvh sm:min-h-0 sm:overflow-hidden">
      <SkipLink />
      <ModeBanner />

      {/* ≤640: top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2.5 border-b border-line px-4 glass sm:hidden">
        <Logo to={home} subtitle={meta.subtitle} markOnly size="sidebar" />
        <RoleTag>{tag}</RoleTag>
        <div className="min-w-0 flex-1">{MobileContext ? <MobileContext /> : null}</div>
        <ThemeToggle size="sm" />
        <AccountMenu area={role} size={32} extra={extra} signOutAll={signOutAll} />
      </header>

      <div className="flex flex-1 sm:min-h-0">
        {/* ≥641: rail (tablet) / sidebar (desktop). Not a scroll container itself (the nav scrolls), so menus can overflow it. */}
        <aside
          data-shell-rail=""
          className={cn(
            'relative z-20 hidden shrink-0 flex-col border-r border-line bg-side backdrop-blur-md sm:flex',
            'w-[72px] items-center gap-4 px-2 py-[18px] lg:items-stretch',
            admin ? 'lg:w-[224px] lg:gap-4 lg:px-3' : 'lg:w-[232px] lg:gap-[18px] lg:px-3.5',
          )}
        >
          <div className="flex items-center gap-2 lg:px-1.5">
            <Logo to={home} subtitle={meta.subtitle} size="sidebar" className="max-lg:hidden" />
            <span className="lg:hidden">
              <Logo to={home} subtitle={meta.subtitle} size="sidebar" markOnly />
            </span>
            <RoleTag className="ml-auto max-lg:hidden">{tag}</RoleTag>
          </div>
          {Context && hasNav ? (
            <div className={cn(railContext ? 'max-lg:flex max-lg:w-11 max-lg:justify-center' : 'max-lg:hidden')}>
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
            {Footer ? (
              <>
                <div className="min-w-0 flex-1 max-lg:hidden">
                  <Footer />
                </div>
                {auth.isAuthenticated ? (
                  <div className="max-lg:hidden">
                    <AccountMenu area={role} trigger="more" placement="up" extra={extra} signOutAll={signOutAll} />
                  </div>
                ) : null}
              </>
            ) : (
              <AccountMenu area={role} trigger="user" placement="up" size={admin ? 30 : 32} subtitle={subtitle} extra={extra} signOutAll={signOutAll} className="flex-1 max-lg:hidden" />
            )}
            <div className="lg:hidden">
              <AccountMenu area={role} size={32} placement="up" extra={extra} signOutAll={signOutAll} />
            </div>
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

      {hasNav ? <RoleNav items={items} variant="bottom" label={meta.navLabel} tabs={tabItems} onMore={() => setDrawer(true)} /> : null}
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

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export interface SidebarSwitcherProps extends Omit<ComponentProps<'button'>, 'children' | 'name'> {
  name: string;
  /** Second line (locality). */
  area?: string;
  /** Prefix of the default accessible name: "<label>. Current: <name>". Pass `aria-label` to replace it. */
  label?: string;
  /** Small accent dot on the initials tile (activity elsewhere, e.g. new orders at another restaurant). */
  dot?: boolean;
  /** Menu content: renders an anchored Popover (dialog named `menuLabel`); opens to the right in the tablet rail. */
  menu?: (close: () => void) => ReactNode;
  menuLabel?: string;
}

/**
 * Switcher button (52px outline, initials tile, name + area, up-down chevrons; design-spec §3.27). In the tablet
 * rail (`railContext`) it collapses to the 44px initials tile (§6.5). Extra props (aria-*, onClick, data-*) are
 * spread onto the <button>, so it can also be a trigger for your own popover / sheet.
 *
 *   <SidebarSwitcher name="Spice Route" area="Indiranagar" menu={(close) => <RestaurantList onPick={close} />} />
 */
export function SidebarSwitcher({ name, area, onClick, label = 'Switch restaurant', dot, menu, menuLabel, className, ...rest }: SidebarSwitcherProps) {
  const button = (extra?: Partial<ComponentProps<'button'>>) => (
    <button
      type="button"
      aria-label={`${label}. Current: ${name}`}
      title={name}
      {...rest}
      {...extra}
      onClick={(e) => {
        extra?.onClick?.(e);
        onClick?.(e);
      }}
      className={cn(
        'flex h-[52px] w-full items-center gap-2.5 rounded-control border border-line bg-card px-2.5 text-left hover:border-line-2',
        'rail:size-11 rail:justify-center rail:px-0',
        className,
      )}
    >
      <span className="relative shrink-0">
        <span aria-hidden="true" className="grid size-[30px] place-items-center rounded-badge bg-acc-soft text-xs font-semibold text-acc-fg">
          {initialsOf(name) || '·'}
        </span>
        {dot ? <span aria-hidden="true" className="absolute -right-1 -top-1 size-2.5 rounded-full border-2 border-card bg-acc" /> : null}
      </span>
      <span className="min-w-0 flex-1 rail:hidden">
        <span className="block truncate text-sm font-medium text-fg">{name}</span>
        {area ? <span className="block truncate text-xs text-fg-3">{area}</span> : null}
      </span>
      <Icon name="chevrons-up-down" size={14} className="shrink-0 text-fg-3 rail:hidden" />
    </button>
  );
  if (!menu) return button();
  return (
    <Popover
      label={menuLabel ?? label}
      align="start"
      // full trigger width in the sidebar; a 288px panel to the right of the tile in the rail
      panelClassName="right-0 rail:right-auto rail:top-0 rail:mt-0 rail:left-full rail:ml-2 rail:w-72"
      trigger={(p) => button(p)}
    >
      {(close) => menu(close)}
    </Popover>
  );
}

/** Partner profile card (36px avatar, name, mono vehicle line). Rail: avatar only. */
export function SidebarProfileCard({ name, detail, avatarUrl }: { name: string; detail?: string; avatarUrl?: string | null }) {
  return (
    <div title={name} className="flex items-center gap-2.5 rounded-card border border-line bg-card p-3 rail:border-0 rail:bg-transparent rail:p-0">
      <Avatar name={name} src={avatarUrl} size={36} />
      <div className="min-w-0 rail:sr-only">
        <p className="truncate text-sm font-medium text-fg">{name}</p>
        {detail ? <p className="truncate font-mono text-[11.5px] text-fg-3">{detail}</p> : null}
      </div>
    </div>
  );
}

/** Admin search button ("Search orders, phones…" + ⌘K). Wire `onClick` to your command palette. Rail: search icon. */
export function SidebarSearchButton({ onClick, placeholder = 'Search orders, phones…' }: { onClick: () => void; placeholder?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={placeholder}
      title={placeholder}
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-9 w-full items-center gap-2 rounded-item border border-line bg-card px-2.5 text-[13px] text-fg-3 hover:border-line-2 rail:size-11 rail:justify-center rail:px-0"
    >
      <Icon name="search" size={14} className="rail:size-[18px]" />
      <span className="flex-1 truncate text-left rail:hidden">{placeholder}</span>
      <Kbd className="rounded-[4px] px-[5px] py-px text-[10.5px] rail:hidden">⌘K</Kbd>
    </button>
  );
}

export { LogoMark };
