/**
 * Dashboard (PRD R-6). Order numbers for today (IST) come from the orders service through
 * `GET /owner/restaurants/:id/dashboard`; menu health and rating come from marketplace. When the orders
 * service can't be reached the page says so instead of showing zeros.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Badge, Button, ButtonLink, Card, Icon, PageHeader, Price, QueryState, RelativeTime, SkeletonList, StatusPill } from '../../components/ui';
import type { IconName } from '../../components/ui/Icon';
import { formatBps, formatDuration } from '../../lib/format';
import { dashboardApi, keys, type Dashboard } from './api';
import { useCurrentRestaurant } from './RestaurantContext';

function Metric({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon: IconName }) {
  return (
    <Card padding="sm" className="flex flex-col gap-1">
      <p className="flex items-center gap-1.5 text-sm text-slate-600">
        <Icon name={icon} size={16} /> {label}
      </p>
      <p className="text-2xl font-bold tabular-nums text-slate-900">{value}</p>
      {hint ? <p className="text-sm text-slate-600">{hint}</p> : null}
    </Card>
  );
}

const dash = <span aria-label="not available">—</span>;

export function OrderMetrics({ d, onRetry, retrying }: { d: Dashboard; onRetry: () => void; retrying: boolean }) {
  const o = d.orders;
  if (!d.ordersAvailable || !o) {
    return (
      <Card tone="warn">
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <Icon name="alert" size={20} />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-warn-800">Order stats unavailable</h3>
            <p className="text-sm text-slate-700">We couldn&rsquo;t load today&rsquo;s order numbers right now. Your orders are not affected.</p>
          </div>
          <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry} loading={retrying}>Try again</Button>
        </div>
      </Card>
    );
  }
  const ratePct = Math.round((o.acceptanceRate ?? 0) * 100 * 10) / 10;
  const delivered = o.byStatus.DELIVERED ?? 0;
  const rejected = (o.byStatus.REJECTED ?? 0) + (o.byStatus.CANCELLED ?? 0);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metric icon="receipt" label="Orders today" value={o.ordersTotal} hint={`${delivered} delivered, ${rejected} rejected or cancelled`} />
      <Metric
        icon="check"
        label="Acceptance rate"
        value={o.acceptanceRate === null ? dash : `${ratePct}%`}
        hint={o.acceptanceRate === null ? 'No orders decided yet' : 'Accepted of accepted + rejected'}
      />
      <Metric icon="wallet" label="Net revenue today" value={<Price paise={o.netRevenuePaise} size="xl" />} hint={<>Delivered orders after commission. Gross <Price paise={o.grossPaise} size="sm" tone="muted" /></>} />
      <Metric icon="clock" label="Avg. time to accept" value={o.avgAcceptSeconds === null ? dash : formatDuration(o.avgAcceptSeconds)} hint={o.avgAcceptSeconds === null ? 'No accepted orders yet' : 'minutes:seconds'} />
    </div>
  );
}

function MenuHealth({ d }: { d: Dashboard }) {
  const m = d.menu;
  return (
    <Card padding="sm" aria-label="Menu health">
      <h3 className="mb-2 text-base font-semibold text-slate-900">Menu health</h3>
      <p className="text-sm text-slate-700">
        {m.itemsTotal} items · {m.itemsUnavailable} hidden · {m.itemsOutOfStock} out of stock
      </p>
      {m.lowStock.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {m.lowStock.map((i) => (
            <li key={i.itemId} className="flex items-center justify-between gap-2">
              <span>{i.name}</span>
              <Badge tone="warn">{i.availableQty} left</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-slate-600">No items are running low (threshold {m.lowStockThreshold}).</p>
      )}
      <p className="mt-2 text-sm text-slate-700">
        {d.rating ? `Rating ${d.rating.average} from ${d.rating.count} ratings` : `Rating shown after 5 ratings (${d.ratingCount} so far)`}
      </p>
    </Card>
  );
}

export default function DashboardPage() {
  const r = useCurrentRestaurant();
  const approved = r.status === 'APPROVED';
  const q = useQuery({ queryKey: keys.dashboard(r.id), queryFn: () => dashboardApi.today(r.id), refetchInterval: 60_000, enabled: approved });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={r.name}
        status={<StatusPill kind="restaurant" status={r.status} />}
        actions={<ButtonLink to="/restaurant/orders" icon="receipt">Live orders</ButtonLink>}
      />
      {r.isDemo ? <p className="mb-3"><Badge tone="info">Demo restaurant</Badge></p> : null}

      {approved ? (
        <section aria-label="Today" className="mb-6">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">Today</h2>
          <QueryState query={q} loading={<SkeletonList count={2} />} loadingLabel="Loading today's numbers…">
            {(d) => (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-slate-700">
                  {d.restaurant.open ? <Badge tone="success" dot>Open for orders</Badge> : <Badge tone="warn" dot>Closed{d.restaurant.closedReason ? `: ${d.restaurant.closedReason.toLowerCase().replace(/_/g, ' ')}` : ''}</Badge>}
                </p>
                <OrderMetrics d={d} onRetry={() => void q.refetch()} retrying={q.isFetching} />
                <MenuHealth d={d} />
                {q.dataUpdatedAt ? <p className="text-xs text-slate-600"><RelativeTime value={q.dataUpdatedAt} prefix="Updated" /> · today in IST</p> : null}
              </div>
            )}
          </QueryState>
        </section>
      ) : (
        <Card className="mb-6">
          <p className="text-[0.9375rem] text-slate-700">
            Order numbers show up here once {r.name} is approved and starts receiving orders. Use the time to build your menu.
          </p>
        </Card>
      )}

      <section aria-label="Manage" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { to: '/restaurant/menu', title: 'Menu', desc: 'Categories, items, prices and stock', icon: 'list' as const },
          { to: '/restaurant/settings', title: 'Store settings', desc: `Hours, pause ordering · ${formatBps(r.commissionBps)} commission`, icon: 'settings' as const },
          { to: '/restaurant/orders/history', title: 'Order history', desc: 'Past orders and refunds', icon: 'receipt' as const },
          { to: '/restaurant/finance', title: 'Finance', desc: 'Earnings, refunds and payouts', icon: 'wallet' as const },
        ].map((l) => (
          <Card key={l.to} as="div" interactive padding="sm">
            <ButtonLink to={l.to} variant="link" icon={l.icon} className="font-semibold">{l.title}</ButtonLink>
            <p className="mt-1 text-sm text-slate-600">{l.desc}</p>
          </Card>
        ))}
      </section>
    </>
  );
}
