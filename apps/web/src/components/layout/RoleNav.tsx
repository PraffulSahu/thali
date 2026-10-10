/**
 * Role-area navigation. Items come from each area's `nav` export (features/<area>/routes.tsx), so the area
 * implementers own their menus.
 *
 *   export const nav: NavItem[] = [
 *     { to: '/restaurant', label: 'Dashboard', icon: 'chart', end: true },
 *     { to: '/restaurant/orders', label: 'Orders', icon: 'receipt', Badge: NewOrdersCount },
 *   ];
 *
 * Variants: 'sidebar' (desktop vertical), 'bottom' (mobile tab bar, first 5 items), 'inline' (header links),
 * 'drawer' (inside a Sheet). Active item gets aria-current="page".
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
  /** Small live counter rendered next to the label (a component so it can use hooks). */
  Badge?: ComponentType;
}

export type RoleNavVariant = 'sidebar' | 'bottom' | 'inline' | 'drawer';

export function RoleNav({ items, variant, label, onNavigate }: { items: NavItem[]; variant: RoleNavVariant; label: string; onNavigate?: () => void }) {
  if (items.length === 0) return null;

  if (variant === 'bottom') {
    return (
      <nav
        aria-label={label}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm md:hidden"
      >
        <ul className="mx-auto flex max-w-lg">
          {items.slice(0, 5).map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[0.6875rem] font-medium',
                    isActive ? 'text-brand-700' : 'text-slate-600 hover:text-slate-900',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span className="relative">
                      <Icon name={item.icon} size={22} strokeWidth={isActive ? 2.1 : 1.75} />
                      {item.Badge ? (
                        <span className="absolute -right-2.5 -top-1.5">
                          <item.Badge />
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate">{item.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  if (variant === 'inline') {
    return (
      <nav aria-label={label} className="hidden md:block">
        <ul className="flex items-center gap-1">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'inline-flex min-h-touch items-center gap-2 rounded-control px-3 text-[0.9375rem] font-medium transition-colors duration-150',
                    isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
                  )
                }
              >
                <Icon name={item.icon} size={18} />
                {item.label}
                {item.Badge ? <item.Badge /> : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label={label}>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex min-h-touch items-center gap-3 rounded-control px-3 text-[0.9375rem] font-medium transition-colors duration-150',
                  isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon name={item.icon} size={20} className={isActive ? 'text-brand-600' : 'text-slate-500'} />
                  <span className="flex-1">{item.label}</span>
                  {item.Badge ? <item.Badge /> : null}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Small count bubble for NavItem.Badge components: `() => <NavCount count={n} label="new orders" />`. */
export function NavCount({ count, label }: { count: number | undefined; label: string }) {
  if (!count) return null;
  return (
    <span className="inline-grid min-w-5 place-items-center rounded-pill bg-brand-600 px-1.5 text-[0.6875rem] font-bold leading-5 text-white">
      {count > 99 ? '99+' : count}
      <span className="sr-only"> {label}</span>
    </span>
  );
}
