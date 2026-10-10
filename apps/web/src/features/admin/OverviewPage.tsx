/**
 * `/admin`: marketplace overview from stored records. Each source loads independently, so one failing
 * service never blanks the page. Delivery and marketplace overviews are verified shapes; the orders overview
 * (services/orders admin routes were not written yet) is rendered generically: every numeric field becomes
 * a tile (money fields end in `Paise`) and every number map becomes a breakdown list.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Card } from '../../components/ui/Card';
import { PageHeader } from '../../components/ui/PageHeader';
import { formatPaise } from '../../components/ui/Price';
import { QueryState } from '../../components/ui/QueryState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { humanize } from '../../components/ui/StatusPill';
import { formatBps } from '../../lib/format';
import { marketplaceOverview, ordersOverview, qk, tmsOverview, type OverviewData } from './api';
import { SectionTitle, StatTile } from './shared';

const label = (key: string) => humanize(key.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumberMap = (v: unknown): v is Record<string, number> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).length > 0 && Object.values(v).every(isCount);

function formatMetric(key: string, v: number): string {
  if (/paise$/i.test(key)) return formatPaise(v);
  if (/bps$/i.test(key)) return formatBps(v);
  return v.toLocaleString('en-IN');
}

/** Renders any overview payload honestly: numbers as tiles, number maps as breakdown lists. */
export function MetricGroup({ data }: { data: OverviewData }) {
  const tiles = Object.entries(data).filter(([, v]) => isCount(v)) as [string, number][];
  const maps = Object.entries(data).filter(([, v]) => isNumberMap(v)) as [string, Record<string, number>][];
  const nested = Object.entries(data).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && !isNumberMap(v)) as [string, OverviewData][];
  const stamp = ['generatedAt', 'asOf', 'checkedAt'].map((k) => data[k]).find((v): v is string => typeof v === 'string');
  if (!tiles.length && !maps.length && !nested.length) return <p className="text-sm text-slate-600">No metrics reported yet.</p>;
  return (
    <div className="flex flex-col gap-4">
      {tiles.length ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map(([k, v]) => (
            <StatTile key={k} label={label(k)} value={formatMetric(k, v)} />
          ))}
        </div>
      ) : null}
      {maps.length ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {maps.map(([k, m]) => (
            <Card key={k} padding="sm">
              <h3 className="mb-2 text-sm font-semibold text-slate-800">{label(k)}</h3>
              <dl className="divide-y divide-slate-100">
                {Object.entries(m).map(([s, n]) => (
                  <div key={s} className="flex justify-between py-1.5 text-sm">
                    <dt className="text-slate-600">{label(s)}</dt>
                    <dd className="font-medium tabular-nums">{formatMetric(s, n)}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          ))}
        </div>
      ) : null}
      {nested.map(([k, v]) => (
        <div key={k}>
          <h3 className="mb-2 text-sm font-semibold text-slate-800">{label(k)}</h3>
          <MetricGroup data={v} />
        </div>
      ))}
      {stamp ? <p className="text-xs text-slate-500"><RelativeTime value={stamp} prefix="As of" /></p> : null}
    </div>
  );
}

function AttentionLink({ to, label: text, value, tone }: { to: string; label: string; value: string; tone?: 'warn' | 'danger' }) {
  return (
    <Link to={to} className="block rounded-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
      <StatTile label={text} value={value} tone={tone} />
    </Link>
  );
}

export default function OverviewPage() {
  const tms = useQuery({ queryKey: qk.tmsOverview, queryFn: tmsOverview, refetchInterval: 30_000 });
  const orders = useQuery({ queryKey: qk.overview('orders'), queryFn: ordersOverview, refetchInterval: 30_000 });
  const market = useQuery({ queryKey: qk.overview('marketplace'), queryFn: marketplaceOverview, refetchInterval: 60_000 });

  const pendingRestaurants = market.data ? String(market.data.restaurants.pendingApproval) : market.isError ? 'n/a' : '…';
  const pendingPartners = tms.data ? String(tms.data.partners.byStatus.APPROVAL_PENDING ?? 0) : tms.isError ? 'n/a' : '…';
  const unassigned = tms.data ? String(tms.data.jobsByStatus.PENDING_ASSIGNMENT ?? 0) : tms.isError ? 'n/a' : '…';
  const exceptions = tms.data ? String(tms.data.exceptions) : tms.isError ? 'n/a' : '…';

  return (
    <>
      <PageHeader title="Admin overview" description="Live figures from stored orders, deliveries and approvals." />

      <section aria-label="Needs attention" className="mb-8">
        <SectionTitle>Needs attention</SectionTitle>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <AttentionLink to="/admin/restaurants?status=APPROVAL_PENDING" label="Restaurants awaiting approval" value={pendingRestaurants} tone={pendingRestaurants !== '0' && pendingRestaurants !== '…' && pendingRestaurants !== 'n/a' ? 'warn' : undefined} />
          <AttentionLink to="/admin/partners?status=APPROVAL_PENDING" label="Partners awaiting approval" value={pendingPartners} tone={pendingPartners !== '0' && pendingPartners !== '…' && pendingPartners !== 'n/a' ? 'warn' : undefined} />
          <AttentionLink to="/admin/tms" label="Deliveries without a partner" value={unassigned} tone={unassigned !== '0' && unassigned !== '…' && unassigned !== 'n/a' ? 'warn' : undefined} />
          <AttentionLink to="/admin/tms" label="Delivery exceptions" value={exceptions} tone={exceptions !== '0' && exceptions !== '…' && exceptions !== 'n/a' ? 'danger' : undefined} />
        </div>
      </section>

      <div className="flex flex-col gap-8">
        <section aria-label="Orders">
          <SectionTitle>Orders</SectionTitle>
          <QueryState query={orders} errorTitle="Couldn't load order metrics">
            {(d) => <MetricGroup data={d} />}
          </QueryState>
        </section>
        <section aria-label="Deliveries">
          <SectionTitle>Deliveries and partners</SectionTitle>
          <QueryState query={tms} errorTitle="Couldn't load delivery metrics">
            {(d) => <MetricGroup data={{ partnersOnline: d.partners.online, liveOffers: d.liveOffers, jobsByStatus: d.jobsByStatus, partnersByStatus: d.partners.byStatus, generatedAt: d.generatedAt }} />}
          </QueryState>
        </section>
        <section aria-label="Marketplace">
          <SectionTitle>Marketplace</SectionTitle>
          <QueryState query={market} errorTitle="Couldn't load marketplace metrics">
            {(d) => <MetricGroup data={d as unknown as OverviewData} />}
          </QueryState>
        </section>
      </div>
    </>
  );
}
