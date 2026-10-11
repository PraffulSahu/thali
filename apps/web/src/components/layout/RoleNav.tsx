/**
 * Role-area navigation. Items come from each area's `nav` export (features/<area>/routes.tsx), so the area
 * implementers own their menus.
 *
 *   export const nav: NavItem[] = [
 *     { to: '/restaurant', label: 'Dashboard', icon: 'chart', end: true },
 *     { to: '/restaurant/orders', label: 'Live orders', icon: 'receipt', Badge: NewOrdersCount, primary: true },
 *     { to: '/admin/health', label: 'Health', icon: 'activity', section: 'System', Badge: HealthDot },
 *   ];
 *
 * Variants: 'sidebar' (design-spec §3.27: 38px rows, current = card + hairline ring, section labels from
 * `section`), 'rail' (72px icon rail, tablets), 'bottom' (phone tab bar: the explicit ordered `tabs` — each role
 * shell has a default — else `primary` items, else the first 4; + "More" when nav items are left over),
 * 'inline' (consumer account ghost nav), 'drawer' (inside a Sheet). Active item gets aria-current="page".
 * Tab labels: `tab.label` ?? `item.shortLabel` ?? `item.label` ("Earnings & payouts" → "Earnings").
 */
import type { ComponentType } from 'react';
import { NavLink } from 'react-router';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from '../ui/Icon';

export interface NavItem {
  /** Absolute path, e.g. '/restaurant/orders'. */
  to: string;
  label: string;
  icon: IconName;
  /** Match exactly (use for the area index route). */
  end?: boolean;
  /** Trailing live counter / dot (a component so it can use hooks): <NavCount>, <NavBadgeCount>, <NavDot>. */
  Badge?: ComponentType;
  /** Section label shown above this item when it changes (admin: "Marketplace", "Operations", "System"). */
  section?: string;
  /** Show in the phone bottom tab bar when the shell has no explicit `tabs` (default: the first 4 items). */
  primary?: boolean;
  /** Short label for the phone tab bar ("History" for "Delivery history"). */
  shortLabel?: string;
}

/**
 * One phone tab-bar destination (ordered). Icon / Badge / end come from the nav item with the same path unless
 * given; a tab whose path is not in the nav needs its own `icon` (else it is dropped).
 *   { to: '/admin/restaurants?status=APPROVAL_PENDING', label: 'Approvals', icon: 'check-circle' }
 */
export interface RoleTab {
  to: string;
  label?: string;
  icon?: IconName;
  end?: boolean;
  Badge?: ComponentType;
}

export type RoleNavVariant = 'sidebar' | 'rail' | 'bottom' | 'inline' | 'drawer';

export interface RoleNavProps {
  items: NavItem[];
  variant: RoleNavVariant;
  label: string;
  onNavigate?: () => void;
  /** Dense rows (admin): 34px, 13.5px. */
  dense?: boolean;
  /** Bottom bar: extra "More" button (opens the drawer). */
  onMore?: () => void;
  /** Bottom bar: explicit ordered destinations (see RoleTab). */
  tabs?: RoleTab[];
}

const pathOf = (to: string) => to.split(/[?#]/)[0]!;

/** Phone tab-bar items: explicit `tabs` (resolved against the nav), else `primary` items, else the first 4–5. */
export function bottomNavItems(items: NavItem[], tabs?: RoleTab[]): NavItem[] {
  if (tabs?.length) {
    const resolved = tabs.flatMap((t): NavItem[] => {
      const item = items.find((i) => i.to === t.to) ?? items.find((i) => pathOf(i.to) === pathOf(t.to));
      const icon = t.icon ?? item?.icon;
      if (!icon) return [];
      return [{ to: t.to, label: t.label ?? item?.shortLabel ?? item?.label ?? t.to, icon, end: t.end ?? item?.end, Badge: t.Badge ?? item?.Badge }];
    });
    if (resolved.length) return resolved.slice(0, 5);
  }
  const primary = items.filter((i) => i.primary);
  return (primary.length ? primary : items).slice(0, items.length > 5 ? 4 : 5).map((i) => (i.shortLabel ? { ...i, label: i.shortLabel } : i));
}

/** Nav items the tab bar doesn't show (they go behind "More"). */
export function overflowNavItems(items: NavItem[], shown: NavItem[]): NavItem[] {
  const paths = new Set(shown.map((s) => pathOf(s.to)));
  return items.filter((i) => !paths.has(pathOf(i.to)));
}

export function RoleNav({ items, variant, label, onNavigate, dense, onMore, tabs }: RoleNavProps) {
  if (items.length === 0) return null;

  if (variant === 'bottom') {
    const shown = bottomNavItems(items, tabs);
    const more = onMore && overflowNavItems(items, shown).length > 0;
    const cell =
      'relative flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium transition-colors duration-150';
    return (
      <nav aria-label={label} className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] sm:hidden">
        <ul className="mx-auto flex max-w-lg">
          {shown.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) => cn(cell, isActive ? 'text-acc-fg' : 'text-fg-3 hover:text-fg')}
              >
                <span className="relative">
                  <Icon name={item.icon} size={20} />
                  {item.Badge ? (
                    <span className="absolute -right-3 -top-1.5">
                      <item.Badge />
                    </span>
                  ) : null}
                </span>
                <span className="max-w-full truncate">{item.label}</span>
              </NavLink>
            </li>
          ))}
          {more ? (
            <li className="flex-1">
              <button type="button" onClick={onMore} className={cn(cell, 'w-full text-fg-3 hover:text-fg')}>
                <Icon name="more" size={20} />
                More
              </button>
            </li>
          ) : null}
        </ul>
      </nav>
    );
  }

  if (variant === 'inline') {
    return (
      <nav aria-label={label}>
        <ul className="flex items-center gap-1">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'inline-flex h-10 items-center gap-2 rounded-pill px-4 text-sm font-bold transition-colors duration-150',
                    isActive ? 'bg-fill text-fg' : 'text-fg-2 hover:bg-fill hover:text-fg',
                  )
                }
              >
                {item.label}
                {item.Badge ? <item.Badge /> : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  if (variant === 'rail') {
    return (
      <nav aria-label={label}>
        <ul className="flex flex-col items-center gap-1">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                title={item.label}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'relative grid size-11 place-items-center rounded-item transition-colors duration-150',
                    isActive ? 'bg-card text-fg shadow-[0_0_0_1px_var(--line)]' : 'text-fg-2 hover:bg-fill hover:text-fg',
                  )
                }
              >
                <Icon name={item.icon} size={20} />
                <span className="sr-only">{item.label}</span>
                {item.Badge ? (
                  <span className="absolute right-0.5 top-0.5 [&>*]:origin-top-right [&>*]:scale-75">
                    <item.Badge />
                  </span>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  // sidebar + drawer
  let lastSection: string | undefined;
  return (
    <nav aria-label={label}>
      <ul className={cn('flex flex-col', dense ? 'gap-px' : 'gap-0.5')}>
        {items.map((item) => {
          const header = item.section && item.section !== lastSection ? item.section : null;
          lastSection = item.section ?? lastSection;
          return (
            <li key={item.to}>
              {header ? <p className="lbl px-2.5 pb-1.5 pt-3.5 text-[11px]!">{header}</p> : null}
              <NavLink
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex items-center justify-between gap-2 px-2.5 transition-colors duration-150 [@media(pointer:coarse)]:min-h-touch',
                    dense ? 'min-h-[34px] rounded-[9px] text-[13.5px]' : 'min-h-[38px] rounded-item text-sm',
                    isActive
                      ? 'bg-card font-medium text-fg shadow-[0_0_0_1px_var(--line)]'
                      : 'font-[450] text-fg-2 hover:bg-fill hover:text-fg',
                  )
                }
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  {variant === 'drawer' ? <Icon name={item.icon} size={18} className="shrink-0 text-fg-3" /> : null}
                  <span className="truncate">{item.label}</span>
                </span>
                {item.Badge ? <item.Badge /> : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Urgent count bubble for NavItem.Badge (chili, mono 11px): `() => <NavCount count={n} label="new orders" />`.
 * Renders nothing for 0 / undefined.
 */
export function NavCount({ count, label }: { count: number | undefined; label: string }) {
  if (!count) return null;
  return (
    <span className="inline-grid min-w-5 place-items-center rounded-pill bg-acc px-[7px] py-0.5 font-mono text-[11px] font-medium leading-none text-pri-fg">
      {count > 99 ? '99+' : count}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

/** Plain (non-urgent) count: mono 11px --fg3. */
export function NavPlainCount({ count, label }: { count: number | undefined; label: string }) {
  if (!count) return null;
  return (
    <span className="font-mono text-[11px] font-medium text-fg-3">
      {count}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

/** Health dot: 7px --bad blinking (down) or static --warn (degraded). */
export function NavDot({ tone, label }: { tone: 'bad' | 'warn' | null | undefined; label: string }) {
  if (!tone) return null;
  return (
    <span className={cn('inline-block size-[7px] rounded-full', tone === 'bad' ? 'animate-blink bg-bad' : 'bg-warn')}>
      <span className="sr-only">{label}</span>
    </span>
  );
}
