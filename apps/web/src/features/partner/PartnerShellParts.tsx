/**
 * Partner shell slots (RoleSidebarShell `shell` config, board 30):
 *   Context        profile card (avatar, name, "Scooter · KA03HX4417") → /partner/onboarding (profile & documents)
 *   MobileContext  online / offline pill in the ≤640 top bar
 *   Footer         partner status chip ("Approved"); non-approved links to onboarding
 * They render outside the area guard, so each one only fetches the profile for a signed-in user.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Avatar } from '../../components/ui/Avatar';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusPill } from '../../components/ui/StatusPill';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/cn';
import { profileQueryOptions, VEHICLE_OPTIONS, type PartnerProfile } from './api';

const VEHICLE_SHORT: Record<string, string> = { BIKE: 'Bike', SCOOTER: 'Scooter', BICYCLE: 'Bicycle', CAR: 'Car' };

export function vehicleLine(p: Pick<PartnerProfile, 'vehicle'>): string | null {
  if (!p.vehicle) return null;
  const type = VEHICLE_SHORT[p.vehicle.type] ?? VEHICLE_OPTIONS.find((o) => o.value === p.vehicle!.type)?.label ?? p.vehicle.type;
  return `${type} · ${p.vehicle.registrationNumber}`;
}

function useShellProfile() {
  const auth = useAuth();
  const q = useQuery({ ...profileQueryOptions(), enabled: auth.isAuthenticated });
  return { auth, q };
}

function avatarOf(user: unknown): string | null {
  const url = (user as { avatarUrl?: unknown } | null | undefined)?.avatarUrl;
  return typeof url === 'string' ? url : null;
}

/** Sidebar profile card (30-02). */
export function PartnerProfileCard() {
  const { auth, q } = useShellProfile();
  if (!auth.isAuthenticated) return null;
  if (q.isPending) {
    return (
      <div className="flex items-center gap-2.5 rounded-card border border-line bg-card p-3" aria-hidden="true">
        <Skeleton className="size-9 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
    );
  }
  const p = q.data;
  const name = p?.name || auth.user?.name || 'Delivery partner';
  const detail = p ? vehicleLine(p) ?? 'Add your vehicle' : 'Set up your profile';
  return (
    <Link
      to="/partner/onboarding"
      aria-label={`${name}${p ? `, ${detail}` : ''}. Profile and documents`}
      className="flex items-center gap-2.5 rounded-card border border-line bg-card p-3 transition-colors hover:border-line-2"
    >
      <Avatar name={name} src={avatarOf(auth.user)} size={36} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate text-sm font-medium text-fg">{name}</span>
        <span className="font-mono text-[11.5px] leading-snug text-fg-3">{detail}</span>
      </span>
    </Link>
  );
}

/** ≤640 top bar: online state pill. */
export function PartnerMobileContext() {
  const { auth, q } = useShellProfile();
  const p = q.data;
  if (!auth.isAuthenticated || !p || p.status !== 'APPROVED') return null;
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-pill px-2.5 text-xs font-bold',
        p.online ? 'bg-ok-bg text-ok' : 'bg-fill text-fg-3',
      )}
    >
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', p.online ? 'animate-pulse-ok bg-ok' : 'bg-fg-3')} />
      {p.online ? 'Online' : 'Offline'}
    </span>
  );
}

/** Sidebar footer: status chip (30-07). Non-approved statuses link to the application. */
export function PartnerStatusFooter() {
  const { auth, q } = useShellProfile();
  if (!auth.isAuthenticated) return null;
  const p = q.data;
  if (!p) return <span className="text-xs text-fg-3">{q.isPending ? '' : 'No partner profile yet'}</span>;
  const chip = <StatusPill kind="partner" status={p.status} />;
  if (p.status === 'APPROVED') return chip;
  return (
    <Link to="/partner/onboarding" aria-label={`Application status: ${p.status === 'APPROVAL_PENDING' ? 'awaiting approval' : p.status.toLowerCase()}. Open application`} className="inline-flex">
      {chip}
    </Link>
  );
}
