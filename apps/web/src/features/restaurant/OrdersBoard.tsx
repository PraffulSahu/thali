/**
 * Live orders — board 20 (design-spec §5.20). Title row (open-state chip, live indicator, Chime, Pause), today's
 * KPIs, and the kanban: New (PLACED) · Preparing (ACCEPTED + PREPARING) · Ready for pickup (READY_FOR_PICKUP).
 * Realtime `owner.order` refreshes the list; when the stream is down it polls every 10 s ("Live updates paused").
 * A new order gets the arrive animation, an assertive screen-reader announcement and (once enabled) a chime.
 * ≤ 640 px the kanban becomes segmented tabs (the New tab auto-selects and pulses when an order arrives).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button, ButtonLink, EmptyState, ErrorState, Icon, KanbanColumn, KanbanEmpty, LiveIndicator, PageHeader, SegmentedTabs, Skeleton,
} from '../../components/ui';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { cn } from '../../lib/cn';
import { keys, type OwnerOrder } from './api';
import { BellOffIcon } from './kit';
import { NewOrderCard, PreparingCard, ReadyCard, type EndedKind } from './OrderCard';
import { OrderDetailDialog } from './OrderDetailDialog';
import { defaultPrep } from './orderText';
import { useOrderStream, useSoundState } from './orderStream';
import { PauseButton } from './PauseControl';
import { useCurrentRestaurant } from './RestaurantContext';
import { KpiGrid, OpenStateChip, useTodayDashboard } from './TodayStats';

type Col = 'new' | 'prep' | 'ready';
const ENDED_TTL_MS = 60_000;

function ChimeButton() {
  const sound = useSoundState();
  return (
    <Button variant="outline" aria-pressed={sound.enabled} onClick={sound.toggle} title={sound.enabled && !sound.armed ? 'Tap anywhere on the page to allow sound' : undefined}>
      {sound.enabled ? <Icon name="bell" size={16} /> : <BellOffIcon size={16} />}
      {sound.enabled ? 'Chime on' : 'Chime off'}
    </Button>
  );
}

function BoardSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] items-start gap-3.5" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2.5">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-48 rounded-card" />
        </div>
      ))}
    </div>
  );
}

interface Ended {
  order: OwnerOrder;
  kind: EndedKind;
  at: number;
}

export default function OrdersBoard() {
  const restaurant = useCurrentRestaurant();
  const qc = useQueryClient();
  const approved = restaurant.status === 'APPROVED';
  const stream = useOrderStream(restaurant.id, { enabled: approved });
  const sound = useSoundState();
  const dashboard = useTodayDashboard(restaurant);
  const phone = !useMediaQuery('(min-width: 641px)', true);
  const [tab, setTab] = useState<Col>('new');
  const [open, setOpen] = useState<OwnerOrder | null>(null);
  const [ended, setEnded] = useState<Map<string, Ended>>(() => new Map());
  /** id → status at first load: cards that move column afterwards slide in. */
  const firstLoad = useRef<Map<string, string> | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.orders(restaurant.id) });
    void qc.invalidateQueries({ queryKey: keys.dashboard(restaurant.id) });
    void qc.invalidateQueries({ queryKey: keys.placedAll });
  };

  const active = stream.active;
  const activeIds = useMemo(() => new Set(active.map((o) => o.id)), [active]);
  if (firstLoad.current === null && stream.query.data) firstLoad.current = new Map(active.map((o) => [o.id, o.status]));

  const newOrders = active.filter((o) => o.status === 'PLACED');
  const kitchen = active.filter((o) => o.status === 'ACCEPTED' || o.status === 'PREPARING');
  const ready = active.filter((o) => o.status === 'READY_FOR_PICKUP');
  const endedShown = [...ended.values()].filter((e) => !activeIds.has(e.order.id));

  // a new order moves "Orders today": refresh the KPIs when one arrives
  const arrivedTotal = stream.newIds.size;
  useEffect(() => {
    if (arrivedTotal > 0) void qc.invalidateQueries({ queryKey: keys.dashboard(restaurant.id) });
  }, [arrivedTotal, qc, restaurant.id]);

  // the New tab takes over on phones when an order arrives
  const arrivals = newOrders.filter((o) => stream.newIds.has(o.id)).length;
  useEffect(() => {
    if (arrivals > 0) setTab('new');
  }, [arrivals]);

  // ended placeholders fade out after a minute
  useEffect(() => {
    if (ended.size === 0) return;
    const t = setInterval(() => {
      setEnded((m) => {
        const next = new Map([...m].filter(([, e]) => Date.now() - e.at < ENDED_TTL_MS));
        return next.size === m.size ? m : next;
      });
    }, 5_000);
    return () => clearInterval(t);
  }, [ended.size]);

  const onEnded = (o: OwnerOrder, kind: EndedKind) => setEnded((m) => new Map(m).set(o.id, { order: o, kind, at: Date.now() }));
  const animateIn = (o: OwnerOrder) => firstLoad.current !== null && firstLoad.current.get(o.id) !== o.status;
  const prep = defaultPrep(restaurant.avgPrepMinutes);

  const columns: Record<Col, { title: string; count: number; body: ReactNode; empty: { title: string; sub?: string } }> = {
    new: {
      title: 'New',
      count: newOrders.length,
      empty: { title: 'No new orders', sub: 'New orders appear here with a chime.' },
      body:
        newOrders.length + endedShown.length > 0 ? (
          <>
            {newOrders.map((o) => (
              <NewOrderCard key={o.id} order={o} isNew={stream.newIds.has(o.id)} defaultPrep={prep} onChanged={refresh} onOpen={setOpen} onEnded={onEnded} />
            ))}
            {endedShown.map((e) => (
              <li key={`ended-${e.order.id}`} className="list-none">
                <KanbanEmpty
                  title={e.kind === 'auto' ? 'Auto-rejected — the accept window passed' : 'Rejected · the customer is being refunded'}
                  sub={e.order.code}
                />
              </li>
            ))}
          </>
        ) : null,
    },
    prep: {
      title: 'Preparing',
      count: kitchen.length,
      empty: { title: 'Nothing on the stove', sub: 'Accepted orders move here.' },
      body: kitchen.length ? kitchen.map((o) => <PreparingCard key={o.id} order={o} onChanged={refresh} onOpen={setOpen} className={animateIn(o) ? 'motion-safe:animate-slidein' : undefined} />) : null,
    },
    ready: {
      title: 'Ready for pickup',
      count: ready.length,
      empty: { title: 'No orders waiting', sub: 'Orders you mark ready wait here for the rider.' },
      body: ready.length ? ready.map((o) => <ReadyCard key={o.id} order={o} onChanged={refresh} onOpen={setOpen} className={animateIn(o) ? 'motion-safe:animate-slidein' : undefined} />) : null,
    },
  };

  const renderColumn = (c: Col, hideTitle = false) => {
    const col = columns[c];
    return (
      <KanbanColumn
        key={c}
        title={col.title}
        count={col.count}
        empty={col.empty}
        className={hideTitle ? '[&>h2]:sr-only' : undefined}
      >
        {col.body ? <ul className="flex flex-col gap-2.5">{col.body}</ul> : null}
      </KanbanColumn>
    );
  };

  return (
    <>
      <PageHeader
        title="Live orders"
        className="mb-5"
        status={
          <>
            <OpenStateChip restaurant={restaurant} dashboard={dashboard.data} />
            {approved ? <LiveIndicator status={stream.realtime} variant="inline" /> : null}
          </>
        }
        meta={sound.enabled && !sound.armed ? <span>Chime is on — tap anywhere on the page once to allow sound.</span> : undefined}
        actions={
          <>
            <ChimeButton />
            <PauseButton restaurant={restaurant} />
          </>
        }
      />
      <div role="status" aria-live="assertive" className="sr-only">
        {stream.announcement}
      </div>

      {!approved ? (
        <EmptyState
          icon="clock"
          title="Orders start once you're approved"
          description="Customers can only order from approved restaurants. The banner above shows what's next."
          action={<ButtonLink to="/restaurant/orders/history" variant="outline">View order history</ButtonLink>}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <KpiGrid query={dashboard} />
          {stream.query.data === undefined ? (
            stream.query.isError ? (
              <ErrorState error={stream.query.error} title="Couldn't load live orders" onRetry={() => void stream.query.refetch()} retrying={stream.query.isFetching} />
            ) : (
              <BoardSkeleton />
            )
          ) : phone ? (
            <div className="flex flex-col gap-3">
              <div className="sticky top-14 z-20 -mx-4 bg-bg/90 px-4 py-2 backdrop-blur">
                <SegmentedTabs
                  semantics="tabs"
                  idPrefix="kanban"
                  size="sm"
                  fullWidth
                  label="Order status"
                  value={tab}
                  onChange={setTab}
                  options={(['new', 'prep', 'ready'] as Col[]).map((c) => ({
                    value: c,
                    label: <span className={cn(c === 'new' && arrivals > 0 && tab !== 'new' && 'motion-safe:animate-pulse')}>{c === 'ready' ? 'Ready' : columns[c].title}</span>,
                    ariaLabel: columns[c].title,
                    count: columns[c].count,
                  }))}
                />
              </div>
              <div role="tabpanel" id={`kanban-panel-${tab}`} aria-label={columns[tab].title}>
                {renderColumn(tab, true)}
              </div>
            </div>
          ) : (
            <div className="grid items-start gap-3.5 sm:max-lg:grid-flow-col sm:max-lg:auto-cols-[minmax(284px,1fr)] sm:max-lg:pb-2 sm:max-lg:overflow-x-auto lg:grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))]">
              {renderColumn('new')}
              {renderColumn('prep')}
              {renderColumn('ready')}
            </div>
          )}
        </div>
      )}
      <OrderDetailDialog order={open} onClose={() => setOpen(null)} />
    </>
  );
}
