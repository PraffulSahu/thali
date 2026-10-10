/** Order history (PRD C-12): checkout groups, newest first, cursor-paginated; each lists its restaurants' parts. */
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ButtonLink, Card, ErrorState, LoadMore, PageHeader, Price, SkeletonList, StatusPill, EmptyState } from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { formatDateTime, plural } from '../../lib/format';
import { fetchOrders, refundLabel, type OrderSummary } from './api';
import { ReorderButton } from './OrderDetailPage';
import { DemoBadge } from './parts';

function OrderRow({ o }: { o: OrderSummary }) {
  const when = o.placedAt ?? o.createdAt;
  return (
    <Card as="li" className="list-none">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link to={`/orders/${o.id}`} className="text-base font-semibold text-slate-900 hover:underline">
            Order {o.code}
          </Link>
          <p className="text-sm text-slate-600">
            {when ? formatDateTime(when) : null} · {plural(o.children.length, 'restaurant')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DemoBadge show={o.isDemo} />
          <StatusPill kind="checkout" status={o.status} />
        </div>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {o.children.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-800">{c.restaurantName}</span>
            <span className="flex items-center gap-2">
              {refundLabel(c.refundStatus) ? <span className="text-xs text-info-800">{refundLabel(c.refundStatus)}</span> : null}
              <StatusPill kind="childOrder" status={c.status} />
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
        <Price paise={o.pricing.totalPaise} />
        <div className="flex gap-2">
          <ReorderButton checkoutId={o.id} />
          <ButtonLink to={o.status === 'AWAITING_PAYMENT' ? `/checkout/status/${o.id}` : `/orders/${o.id}`} size="sm" iconRight="chevron-right">
            {o.status === 'AWAITING_PAYMENT' ? 'Payment status' : 'Details'}
          </ButtonLink>
        </div>
      </div>
    </Card>
  );
}

function OrdersList() {
  const q = useInfiniteQuery({
    queryKey: ['orders', 'list'],
    queryFn: ({ pageParam }) => fetchOrders(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  if (q.isPending) {
    return (
      <div role="status">
        <span className="sr-only">Loading your orders…</span>
        <SkeletonList count={3} />
      </div>
    );
  }
  if (q.isError && !q.data) return <ErrorState error={q.error} title="Couldn't load your orders" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (!items.length) {
    return <EmptyState icon="receipt" title="No orders yet" description="Your orders from every restaurant will show up here." action={<ButtonLink to="/">Find food</ButtonLink>} />;
  }
  return (
    <>
      <ul className="space-y-3">
        {items.map((o) => (
          <OrderRow key={o.id} o={o} />
        ))}
      </ul>
      <LoadMore hasMore={q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} label="Older orders" />
    </>
  );
}

export default function OrdersPage() {
  return (
    <>
      <PageHeader title="Your orders" />
      <RequireAuth signInMessage="Sign in to see your orders.">
        <OrdersList />
      </RequireAuth>
    </>
  );
}
