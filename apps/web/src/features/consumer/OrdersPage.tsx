/**
 * Orders (design-spec §7.2; PRD C-12): checkout groups newest first, cursor-paginated. Each card: mono code + IST
 * date + checkout chip; restaurants with per-child chips; total paid + refund line (pending --info / refunded --ok);
 * item count; Reorder; row → `/orders/:id` (or the payment status while AWAITING_PAYMENT).
 * `?child=<childOrderId>` (notification deep link) opens the order that contains that child.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ButtonLink, EmptyState, ErrorState, LoadMore, PageHeader, SkeletonCard, StatusPill } from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { formatINR, plural } from '../../lib/format';
import { fetchOrders, type OrderSummary } from './api';
import { PageContainer } from './ConsumerLayout';
import { ReorderButton } from './OrderDetailPage';
import { relativeDay } from './parts';

function OrderCard({ o }: { o: OrderSummary }) {
  const when = o.placedAt ?? o.createdAt;
  const href = o.status === 'AWAITING_PAYMENT' ? `/checkout/status/${o.id}` : `/orders/${o.id}`;
  const items = o.children.reduce((n, c) => n + c.itemCount, 0);
  return (
    <li className="flex list-none flex-col gap-3.5 rounded-card border border-line bg-card px-[18px] py-4 transition-[border-color,box-shadow] hover:border-line-2 hover:shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Link to={href} className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-[15px] font-medium">{o.code}</span>
            <StatusPill kind="checkout" status={o.status} />
          </Link>
          <span className="text-[13px] text-fg-3">
            {when ? relativeDay(when).replace(/^\w/, (c) => c.toUpperCase()) : null} · {plural(o.children.length, 'restaurant')} · {plural(items, 'item')}
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-right">
          <span className="text-[15px] font-semibold tabular-nums">{formatINR(o.adjustedTotals.paidPaise || o.totalPaise)}</span>
          {o.adjustedTotals.refundPendingPaise > 0 ? <span className="text-[12.5px] text-info">{formatINR(o.adjustedTotals.refundPendingPaise)} refund pending</span> : null}
          {o.adjustedTotals.refundedPaise > 0 ? <span className="text-[12.5px] text-ok">{formatINR(o.adjustedTotals.refundedPaise)} refunded</span> : null}
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {o.children.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate text-fg-2">
              {c.restaurantName} <span className="text-fg-3">· {plural(c.itemCount, 'item')}</span>
            </span>
            <span className="flex items-center gap-2">
              {c.refundStatus !== 'NONE' ? <StatusPill kind="childRefund" status={c.refundStatus} density="dense" /> : null}
              <StatusPill kind="childOrder" status={c.status} density="dense" />
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        <ReorderButton checkoutId={o.id} />
        <ButtonLink to={href} size="sm" iconRight="arrow-right" variant="outline">
          {o.status === 'AWAITING_PAYMENT' ? 'Payment status' : 'Track / details'}
        </ButtonLink>
      </div>
    </li>
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
  const owner = childTarget ? q.data?.pages.flatMap((p) => p.items).find((o) => o.children.some((c) => c.id === childTarget)) : undefined;
  useEffect(() => {
    if (owner) navigate(`/orders/${owner.id}`, { replace: true });
  }, [owner, navigate]);
  if (q.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading your orders…</span>
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
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
      <ul className="flex flex-col gap-3">
        {items.map((o) => (
          <OrderCard key={o.id} o={o} />
        ))}
      </ul>
      <LoadMore hasMore={q.hasNextPage} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} label="Older orders" />
    </>
  );
}

export default function OrdersPage() {
  return (
    <PageContainer width="narrow">
      <PageHeader size="page" title="Your orders" description="Each restaurant in an order cooks and delivers separately; refunds are per restaurant." />
      <RequireAuth signInMessage="Sign in to see your orders.">
        <OrdersList />
      </RequireAuth>
    </PageContainer>
  );
}
