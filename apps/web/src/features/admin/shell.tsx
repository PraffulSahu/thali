/**
 * Admin shell slots for RoleSidebarShell (board 40): ⌘K search context card, grouped nav badges
 * (MARKETPLACE / OPERATIONS / SYSTEM), the phone top-bar search icon (+ the palette host, mounted once), and the
 * footer user block ("Nisha K. · Ops admin · MFA on" with the session's admin sub-role).
 */
import { useQuery } from '@tanstack/react-query';
import { NavCount, NavDot, NavPlainCount } from '../../components/layout/RoleNav';
import { SidebarSearchButton } from '../../components/layout/RoleSidebarShell';
import { useDisplayName } from '../../components/layout/ShellParts';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/Button';
import { useAuth } from '../../lib/auth';
import { getHealth, marketplaceOverview, ordersOverview, qk, tmsOverview, type HealthReport } from './api';
import { CommandPaletteHost, openCommandPalette } from './CommandPalette';

const BADGE_POLL = 60_000;

/** Shared overview queries (the overview page uses the same keys, so badges and tiles dedupe). */
export const useOrdersOverview = (refetchInterval = BADGE_POLL) => useQuery({ queryKey: qk.overview('orders'), queryFn: ordersOverview, refetchInterval });
export const useMarketplaceOverview = (refetchInterval = BADGE_POLL) => useQuery({ queryKey: qk.overview('marketplace'), queryFn: marketplaceOverview, refetchInterval });
export const useTmsOverview = (refetchInterval = BADGE_POLL) => useQuery({ queryKey: qk.tmsOverview, queryFn: tmsOverview, refetchInterval });
export const useHealth = (refetchInterval = BADGE_POLL) => useQuery({ queryKey: qk.health, queryFn: getHealth, refetchInterval });

/** Red when any service is unreachable, amber when degraded (incl. gateway redis), none when all up. */
export function healthTone(report: HealthReport | undefined): 'bad' | 'warn' | null {
  if (!report) return null;
  const states = Object.values(report.services).map((s) => s.status);
  if (states.includes('down')) return 'bad';
  if (states.includes('degraded') || report.overall !== 'up' || report.gateway.status !== 'up') return 'warn';
  return null;
}

export function RestaurantsBadge() {
  const { data } = useMarketplaceOverview();
  return <NavPlainCount count={data?.restaurants.pendingApproval} label="restaurants awaiting approval" />;
}
export function PartnersBadge() {
  const { data } = useTmsOverview();
  return <NavPlainCount count={data?.partners.byStatus.APPROVAL_PENDING} label="partners awaiting approval" />;
}
/**
 * Deliveries waiting for a partner (PENDING_ASSIGNMENT). The TMS jobs API filters one status at a time, so the badge,
 * the overview tile and `/admin/tms?filter=unassigned` all count exactly this set; offered jobs have their own tab.
 */
export function unassignedCount(data: { jobsByStatus: Record<string, number> } | undefined): number | undefined {
  if (!data) return undefined;
  return data.jobsByStatus.PENDING_ASSIGNMENT ?? 0;
}
export function DeliveriesBadge() {
  const { data } = useTmsOverview();
  return <NavCount count={unassignedCount(data)} label="unassigned deliveries" />;
}
export function SupportBadge() {
  const { data } = useOrdersOverview();
  return <NavPlainCount count={data?.support?.open} label="open tickets" />;
}
export function HealthBadge() {
  const { data } = useHealth();
  const tone = healthTone(data);
  return <NavDot tone={tone} label={tone === 'bad' ? 'a service is down' : 'a service is degraded'} />;
}

/** Sidebar context card: "Search orders, phones… ⌘K". */
export function AdminSearchContext() {
  return <SidebarSearchButton onClick={openCommandPalette} />;
}

/** ≤640 top bar: search icon. Also hosts the ⌘K palette + hotkey (this slot is mounted exactly once). */
export function AdminMobileContext() {
  return (
    <div className="flex justify-end">
      <IconButton icon="search" label="Search orders, phones…" size="sm" onClick={openCommandPalette} />
      <CommandPaletteHost />
    </div>
  );
}

const SUB_ROLE: Record<string, string> = { SUPER_ADMIN: 'Super', OPS: 'Ops', FINANCE: 'Finance', SUPPORT: 'Support' };

/** "Ops admin · MFA on" from the session's admin sub-roles. */
export function adminSubtitle(adminRoles: readonly string[], mfa: boolean): string {
  const order = ['SUPER_ADMIN', 'OPS', 'FINANCE', 'SUPPORT'];
  const names = order.filter((r) => adminRoles.includes(r)).map((r) => SUB_ROLE[r]);
  const role = names.length ? `${names.join(' · ')} admin` : 'Admin';
  return mfa ? `${role} · MFA on` : role;
}

/** Footer user block (30px initials avatar, name 13px, sub-role line). */
export function AdminFooter() {
  const auth = useAuth();
  const name = useDisplayName();
  if (!auth.isAuthenticated) return null;
  const src = typeof auth.user?.avatarUrl === 'string' ? (auth.user.avatarUrl as string) : null;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar name={name} src={src} size={30} />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-fg">{name}</p>
        <p className="truncate text-xs text-fg-3">{adminSubtitle(auth.adminRoles, auth.hasMfa)}</p>
      </div>
    </div>
  );
}
