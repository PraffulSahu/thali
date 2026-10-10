/** Order history (PRD C-12): checkout groups (`orderSummary`), newest first, cursor-paginated; each lists its restaurants' parts. `?child=<childOrderId>` opens that order. */
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ButtonLink, Card, ErrorState, LoadMore, PageHeader, Price, SkeletonList, StatusPill, EmptyState } from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { formatDateTime, formatINR, plural } from '../../lib/format';
import { fetchOrders, refundLabel, type OrderSummary } from './api';
import { ReorderButton } from './OrderDetailPage';

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
        <StatusPill kind="checkout" status={o.status} />
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {o.children.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-800">
              {c.restaurantName} <span className="text-slate-500">· {plural(c.itemCount, 'item')} · {formatINR(c.totalPaise)}</span>
            </span>
            <span className="flex items-center gap-2">
              {refundLabel(c.refundStatus) ? <span className="text-xs text-info-800">{refundLabel(c.refundStatus)}</span> : null}
              <StatusPill kind="childOrder" status={c.status} />
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
        <span className="text-sm text-slate-700">
          <Price paise={o.totalPaise} />
          {o.adjustedTotals.refundedPaise > 0 ? <span className="ml-2 text-success-800">{formatINR(o.adjustedTotals.refundedPaise)} refunded</span> : null}
          {o.adjustedTotals.refundPendingPaise > 0 ? <span className="ml-2 text-info-800">{formatINR(o.adjustedTotals.refundPendingPaise)} refund pending</span> : null}
        </span>
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
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const childTarget = params.get('child');
  const q = useInfiniteQuery({
    queryKey: ['orders', 'list'],
    queryFn: ({ pageParam }) => fetchOrders(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  // Deep link from a notification that only knows the child order id: open its checkout once found.
  const owner = childTarget ? q.data?.pages.flatMap((p) => p.items).find((o) => o.children.some((c) => c.id === childTarget)) : undefined;
  useEffect(() => {
    if (owner) navigate(`/orders/${owner.id}`, { replace: true });
  }, [owner, navigate]);
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
