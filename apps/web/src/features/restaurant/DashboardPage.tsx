/**
 * Dashboard (design-spec §7.3): "Today at Spice Route", today's KPI tiles (IST, from
 * `GET /owner/restaurants/:id/dashboard`), then cards: open state with Pause/Resume, rating ("New" under 5),
 * menu health (items, hidden, out of stock, low-stock rows with "Update stock"). Stats unavailable → "—" +
 * Retry, never zeros. Not approved yet → what happens next instead of numbers.
 */
import { Link } from 'react-router';
import {
  AccentWord, Badge, ButtonLink, Button, ErrorState, Icon, PageHeader, RatingBadge, RelativeTime, SectionCard, SectionRow, Skeleton,
} from '../../components/ui';
import { formatBps, formatTime } from '../../lib/format';
import { type Dashboard, type OwnerRestaurant } from './api';
import { PauseChoices, usePauseActions, usePaused } from './PauseControl';
import { useCurrentRestaurant } from './RestaurantContext';
import { KpiGrid, OpenStateChip, useTodayDashboard } from './TodayStats';

function OpenStateCard({ r, d }: { r: OwnerRestaurant; d: Dashboard | undefined }) {
  const paused = usePaused(r);
  const { pause, resume } = usePauseActions(r);
  return (
    <SectionCard title="Taking orders" actions={<OpenStateChip restaurant={r} dashboard={d} />}>
      <div className="flex flex-col gap-3 px-4 py-4">
        {paused ? (
          <>
            <p className="text-sm text-fg-2">New orders are paused until {formatTime(r.pausedUntil)}. Customers see &ldquo;Temporarily not accepting orders&rdquo;.</p>
            <Button shape="block" onClick={() => resume.mutate()} loading={resume.isPending}>
              Resume orders now
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-3">Need a breather? Pause new orders; accepted orders carry on.</p>
            <PauseChoices onPause={(m) => pause.mutate(m)} pending={pause.isPending} error={pause.error} />
          </>
        )}
      </div>
    </SectionCard>
  );
}

function RatingCard({ d }: { d: Dashboard }) {
  return (
    <SectionCard title="Rating" actions={<RatingBadge avg={d.rating?.average ?? null} count={d.rating?.count ?? d.ratingCount} />}>
      <div className="flex flex-col gap-1 px-4 py-4">
        {d.rating ? (
          <>
            <p className="text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums">
              {d.rating.average.toFixed(1)}
              <span className="ml-1 text-base font-normal text-fg-3">/ 5</span>
            </p>
            <p className="text-[13px] text-fg-3">From {d.rating.count} ratings</p>
          </>
        ) : (
          <>
            <p className="text-[26px] font-semibold leading-none text-fg-3">New</p>
            <p className="text-[13px] text-fg-3">Customers see your rating after 5 ratings ({d.ratingCount} so far).</p>
          </>
        )}
      </div>
    </SectionCard>
  );
}

function MenuHealthCard({ d }: { d: Dashboard }) {
  const m = d.menu;
  return (
    <SectionCard title="Menu health" meta={`${m.itemsTotal} items`} actions={<ButtonLink to="/restaurant/menu" variant="ghost" size="xs">Open menu</ButtonLink>}>
      <SectionRow className="gap-x-5 text-sm">
        <span>
          <span className="font-semibold tabular-nums">{m.itemsUnavailable}</span> <span className="text-fg-3">hidden</span>
        </span>
        <span>
          <span className="font-semibold tabular-nums">{m.itemsOutOfStock}</span> <span className="text-fg-3">out of stock</span>
        </span>
      </SectionRow>
      {m.lowStock.length ? (
        m.lowStock.map((i) => (
          <SectionRow key={i.itemId} className="justify-between">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.name}</span>
            <Badge tone="warn" dot>
              {i.availableQty} left
            </Badge>
            <ButtonLink to={`/restaurant/menu?item=${encodeURIComponent(i.itemId)}`} variant="outline" size="xs">
              Update stock
            </ButtonLink>
          </SectionRow>
        ))
      ) : (
        <SectionRow>
          <span className="text-[13px] text-fg-3">Nothing is running low (alert at {m.lowStockThreshold} or fewer).</span>
        </SectionRow>
      )}
    </SectionCard>
  );
}

const LINKS = [
  { to: '/restaurant/orders', title: 'Live orders', desc: 'Accept, prepare, hand over', icon: 'receipt' as const },
  { to: '/restaurant/menu', title: 'Menu', desc: 'Items, prices, stock, featured', icon: 'list' as const },
  { to: '/restaurant/orders/history', title: 'Order history', desc: 'Past orders and refunds', icon: 'clock' as const },
  { to: '/restaurant/finance', title: 'Finance', desc: 'Earnings, ledger and payouts', icon: 'wallet' as const },
];

export default function DashboardPage() {
  const r = useCurrentRestaurant();
  const approved = r.status === 'APPROVED';
  const q = useTodayDashboard(r);

  return (
    <>
      <PageHeader
        title={
          <>
            Today at <AccentWord>{r.name}</AccentWord>
          </>
        }
        documentTitle={`Dashboard · ${r.name}`}
        className="mb-5"
        meta={
          <>
            <span>Today in IST</span>
            {q.dataUpdatedAt ? <RelativeTime value={q.dataUpdatedAt} prefix="refreshed" /> : null}
            <span>{formatBps(r.commissionBps)} commission</span>
            {r.isDemo ? <Badge tone="info">Demo restaurant</Badge> : null}
          </>
        }
        actions={<ButtonLink to="/restaurant/orders" icon="receipt">Live orders</ButtonLink>}
      />

      {approved ? (
        <div className="flex flex-col gap-5">
          <KpiGrid query={q} />
          {q.data ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] items-start gap-3.5">
              <OpenStateCard r={r} d={q.data} />
              <RatingCard d={q.data} />
              <MenuHealthCard d={q.data} />
            </div>
          ) : q.isError ? (
            <ErrorState error={q.error} title="Couldn't load today's dashboard" onRetry={() => void q.refetch()} retrying={q.isFetching} />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-3.5" aria-hidden="true">
              <Skeleton className="h-56 rounded-field" />
              <Skeleton className="h-56 rounded-field" />
              <Skeleton className="h-56 rounded-field" />
            </div>
          )}
        </div>
      ) : (
        <SectionCard title="Numbers show up once you're live">
          <p className="px-4 py-4 text-sm text-fg-3">
            Order stats start when {r.name} is approved and takes its first order. Use the time to build your menu and set your hours.
          </p>
        </SectionCard>
      )}

      <section aria-label="Manage" className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-2.5">
        {LINKS.map((l) => (
          <Link key={l.to} to={l.to} className="group flex items-start gap-3 rounded-card border border-line bg-card px-4 py-3.5 transition-shadow hover:shadow-card">
            <span className="grid size-9 shrink-0 place-items-center rounded-item bg-acc-soft text-acc-fg">
              <Icon name={l.icon} size={18} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg group-hover:underline">{l.title}</span>
              <span className="block text-[13px] text-fg-3">{l.desc}</span>
            </span>
          </Link>
        ))}
      </section>
    </>
  );
}
