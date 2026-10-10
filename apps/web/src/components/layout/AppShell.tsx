/**
 * Area chrome dispatcher (kept for compatibility). AreaLayout (RoleArea.tsx) renders it around every area
 * route unless the area exports `chrome = 'none'` and mounts shells itself:
 *
 *   consumer   → <ConsumerShell>    (location chip, search, Orders, bell, theme, avatar; tab bar ≤640)
 *   restaurant → <RoleSidebarShell role="restaurant">  (KITCHEN)
 *   partner    → <RoleSidebarShell role="partner">     (PARTNER)
 *   admin      → <RoleSidebarShell role="admin">       (OPS)
 *
 * Every variant: skip link, demo/sandbox strip, <main id="main">, account menu with sign-out and links to the
 * other areas the user has roles for. See README-DESIGN-SYSTEM.md §Shells.
 */
import type { ComponentType, ReactNode } from 'react';
import { ConsumerShell, type ConsumerShellConfig } from './ConsumerShell';
import { RoleSidebarShell, type RoleShellConfig } from './RoleSidebarShell';
import type { NavItem } from './RoleNav';
import type { AreaKey } from './ShellParts';

export type { AreaKey } from './ShellParts';
export { SkipLink } from './ShellParts';

export interface AppShellProps {
  variant: AreaKey;
  children: ReactNode;
  nav?: NavItem[];
  /** Legacy: extra header controls (consumer: location chip + cart). Used when `shell.Actions` is absent. */
  HeaderActions?: ComponentType;
  /** Hide navigation (e.g. a user without the area's role). */
  showNav?: boolean;
  /** Full-bleed main column (maps, boards). */
  wide?: boolean;
  /** Area slots (ConsumerShellConfig for consumer, RoleShellConfig for the others). */
  shell?: ConsumerShellConfig | RoleShellConfig;
}

export function AppShell({ variant, children, nav = [], HeaderActions, showNav = true, wide, shell }: AppShellProps) {
  if (variant === 'consumer') {
    const cfg = (shell ?? {}) as ConsumerShellConfig;
    return (
      <ConsumerShell {...cfg} Actions={cfg.Actions ?? HeaderActions} container={wide ? 'none' : 'page'}>
        {children}
      </ConsumerShell>
    );
  }
  const cfg = (shell ?? {}) as RoleShellConfig;
  return (
    <RoleSidebarShell role={variant} nav={nav} showNav={showNav} wide={cfg.wide ?? wide} {...cfg}>
      {children}
    </RoleSidebarShell>
  );
}
