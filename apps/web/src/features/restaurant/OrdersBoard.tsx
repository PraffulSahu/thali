/**
 * Live orders board (PRD R-5): New (accept/reject within the window), In the kitchen, Ready for pickup.
 * Realtime `owner.order` events refresh the list; if the stream is down it polls every 10 s. A new order gets a
 * highlighted card, a screen-reader announcement and (once the owner enabled it) a chime.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Button, ButtonLink, Card, EmptyState, PageHeader, QueryState, RealtimeStatus, RelativeTime, SkeletonList } from '../../components/ui';
import { keys, type OwnerOrder } from './api';
import { OrderCard } from './OrderCard';
import { useCurrentRestaurant } from './RestaurantContext';
import { useOrderStream, useSoundState } from './orderStream';

function Column({ title, hint, orders, newIds, prep, onChanged }: { title: string; hint: string; orders: OwnerOrder[]; newIds: Set<string>; prep: number; onChanged: () => void }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <h2 className="flex items-center justify-between text-base font-semibold text-slate-900">
        {title}
        <span className="rounded-pill bg-slate-100 px-2 py-0.5 text-sm tabular-nums text-slate-700" aria-label={`${orders.length} orders`}>{orders.length}</span>
      </h2>
      {orders.length === 0 ? (
        <p className="rounded-card border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-600">{hint}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((o) => (
            <OrderCard key={o.id} order={o} isNew={newIds.has(o.id)} defaultPrepMinutes={prep} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

export default function OrdersBoard() {
  const restaurant = useCurrentRestaurant();
  const qc = useQueryClient();
  const approved = restaurant.status === 'APPROVED';
  const stream = useOrderStream(restaurant.id, { enabled: approved });
  const sound = useSoundState();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.orders(restaurant.id) });

  const newOrders = stream.active.filter((o) => o.status === 'PLACED');
  const kitchen = stream.active.filter((o) => o.status === 'ACCEPTED' || o.status === 'PREPARING');
  const ready = stream.active.filter((o) => o.status === 'READY_FOR_PICKUP');
  const newlyArrived = newOrders.filter((o) => stream.newIds.has(o.id));

  const actions = (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon="bell"
        aria-pressed={sound.enabled && sound.armed}
        onClick={() => sound.setEnabled(!(sound.enabled && sound.armed))}
      >
        {!sound.enabled ? 'Enable order sound' : sound.armed ? 'Order sound on' : 'Tap to turn sound on'}
      </Button>
      <ButtonLink to="/restaurant/orders/history" variant="secondary" size="sm" icon="list">
        Order history
      </ButtonLink>
    </>
  );

  return (
    <>
      <PageHeader title="Orders" description={`Live orders for ${restaurant.name}`} actions={actions} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <RealtimeStatus status={stream.realtime} />
        {stream.query.dataUpdatedAt ? <RelativeTime value={stream.query.dataUpdatedAt} prefix="updated" staleAfterSec={30} className="text-xs text-slate-600" /> : null}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {newlyArrived.length > 0 ? `New order${newlyArrived.length > 1 ? 's' : ''}: ${newlyArrived.map((o) => o.code).join(', ')}` : ''}
      </div>

      {!approved ? (
        <Card>
          <EmptyState
            icon="clock"
            title="Orders start once you're approved"
            description="Customers can only order from approved restaurants. The status banner above shows what's next."
            action={<ButtonLink to="/restaurant/orders/history" variant="secondary">View order history</ButtonLink>}
          />
        </Card>
      ) : (
        <QueryState query={stream.query} loading={<SkeletonList count={3} />} loadingLabel="Loading orders…">
          {() =>
            stream.active.length === 0 ? (
              <Card>
                <EmptyState
                  icon="receipt"
                  title="No active orders"
                  description="New orders appear here the moment customers pay. Keep this page open, and turn on order sound so you don't miss one."
                />
              </Card>
            ) : (
              <div className="grid gap-5 lg:grid-cols-3">
                <Column title="New" hint="No new orders." orders={newOrders} newIds={stream.newIds} prep={restaurant.avgPrepMinutes} onChanged={refresh} />
                <Column title="In the kitchen" hint="Nothing being prepared." orders={kitchen} newIds={stream.newIds} prep={restaurant.avgPrepMinutes} onChanged={refresh} />
                <Column title="Ready for pickup" hint="No orders waiting for a rider." orders={ready} newIds={stream.newIds} prep={restaurant.avgPrepMinutes} onChanged={refresh} />
              </div>
            )
          }
        </QueryState>
      )}
    </>
  );
}
