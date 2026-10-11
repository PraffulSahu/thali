/**
 * Today's KPIs (design-spec 20-16…20-19) and the open-state chip (20-12), both from
 * `GET /owner/restaurants/:id/dashboard?from&to` (IST today). Unavailable stats show "—" + "Stats unavailable ·
 * Retry", never zeros.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, KpiTile } from '../../components/ui';
import { formatINR } from '../../lib/format';
import { dashboardApi, keys, type Dashboard, type OwnerRestaurant } from './api';
import { istDayKey, nextOpening } from './hours';
import { percent, shortDuration } from './orderText';
import { usePaused } from './PauseControl';

export function useTodayDashboard(r: Pick<OwnerRestaurant, 'id' | 'status'>) {
  return useQuery({
    queryKey: keys.dashboard(r.id),
    queryFn: () => dashboardApi.today(r.id),
    enabled: r.status === 'APPROVED',
    refetchInterval: 60_000,
  });
}

/** "₹9,842" (whole rupees drop the .00; paise are kept when present). */
export const rupees = (paise: number) => formatINR(paise).replace(/\.00$/, '');

export function KpiGrid({ query }: { query: ReturnType<typeof useTodayDashboard> }) {
  const d = query.data;
  const o = d?.orders ?? null;
  const loading = query.isPending && query.fetchStatus !== 'idle';
  const unavailable = !loading && (query.isError || !d?.ordersAvailable || !o);
  const retry = () => void query.refetch();
  const common = { loading, unavailable, onRetry: unavailable ? retry : undefined };
  return (
    <section aria-label="Today" className="grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-2.5 max-sm:grid-cols-2">
      <KpiTile label="Orders today" value={o?.ordersTotal} {...common} />
      <KpiTile label="Acceptance" value={o ? (o.acceptanceRate === null ? '—' : percent(o.acceptanceRate)) : undefined} sub={o && o.acceptanceRate === null ? 'No orders decided yet' : undefined} {...common} />
      <KpiTile label="Avg. time to accept" value={o ? (o.avgAcceptSeconds === null ? '—' : shortDuration(o.avgAcceptSeconds)) : undefined} sub={o && o.avgAcceptSeconds === null ? 'No accepted orders yet' : undefined} {...common} />
      <KpiTile label="Revenue · gross / net" value={o ? rupees(o.grossPaise) : undefined} secondary={o ? `/ ${rupees(o.netRevenuePaise)}` : undefined} {...common} />
    </section>
  );
}

/** "Open · accepting" (ok) · "Paused until 3:30 PM" (warn) · "Closed · opens 6:00 PM" (neutral). */
export function OpenStateChip({ restaurant, dashboard }: { restaurant: OwnerRestaurant; dashboard: Dashboard | undefined }) {
  const paused = usePaused(restaurant);
  const time = (t: Date | string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(new Date(t)).toUpperCase();
  if (restaurant.status !== 'APPROVED') return <Badge tone="neutral" dot>Not live yet</Badge>;
  if (paused && restaurant.pausedUntil) return <Badge tone="warn" dot>Paused until {time(restaurant.pausedUntil)}</Badge>;
  if (!dashboard) return null;
  if (dashboard.restaurant.open) return <Badge tone="ok" dot>Open · accepting</Badge>;
  const next = nextOpening(restaurant.hours);
  if (!next) return <Badge tone="neutral" dot>Closed · no opening hours set</Badge>;
  const sameDay = istDayKey(next.getTime()) === istDayKey(Date.now());
  const day = sameDay ? '' : `${new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' }).format(next)} `;
  return <Badge tone="neutral" dot>Closed · opens {day}{time(next)}</Badge>;
}
