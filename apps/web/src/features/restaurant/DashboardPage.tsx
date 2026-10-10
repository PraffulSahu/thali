/** Dashboard (PRD R-6): today's orders, acceptance rate and revenue, all computed by the server from stored orders. */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Badge, ButtonLink, Card, Icon, PageHeader, Price, QueryState, RelativeTime, SkeletonList, StatusPill } from '../../components/ui';
import type { IconName } from '../../components/ui/Icon';
import { formatBps } from '../../lib/format';
import { dashboardApi, keys, type DashboardMetrics } from './api';
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

function Metrics({ m }: { m: DashboardMetrics }) {
  const decided = m.acceptedToday !== null && m.rejectedToday !== null ? m.acceptedToday + m.rejectedToday : null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Metric icon="receipt" label="Orders today" value={m.ordersToday ?? dash} />
      <Metric
        icon="check"
        label="Acceptance rate"
        value={m.acceptanceRatePct === null ? dash : `${m.acceptanceRatePct}%`}
        hint={decided === null ? undefined : decided === 0 ? 'No decided orders yet' : `${m.acceptedToday} accepted, ${m.rejectedToday} rejected`}
      />
      <Metric icon="wallet" label="Revenue today" value={m.revenuePaise === null ? dash : <Price paise={m.revenuePaise} size="xl" />} hint="Items sold, before commission" />
      <Metric icon="clock" label="Avg. prep time" value={m.avgPrepMinutes === null ? dash : `${Math.round(m.avgPrepMinutes)} min`} />
    </div>
  );
}

export default function DashboardPage() {
  const r = useCurrentRestaurant();
  const approved = r.status === 'APPROVED';
  const q = useQuery({ queryKey: keys.dashboard(r.id), queryFn: () => dashboardApi.get(r.id), refetchInterval: 60_000, enabled: approved });

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
            {(m) => (
              <>
                <Metrics m={m} />
                {q.dataUpdatedAt ? <p className="mt-2 text-xs text-slate-600"><RelativeTime value={q.dataUpdatedAt} prefix="Updated" /> · times in IST</p> : null}
              </>
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
