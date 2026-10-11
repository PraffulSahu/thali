/**
 * Order history (design-spec §7.3): filter pills (All · Delivered · Rejected or cancelled · Delivery failed ·
 * In progress, kept in the URL as `?status=`) over a dense table (code, placed IST, status, items, total, refund).
 * The owner orders API filters by status only (no date range), so there is no date filter. Cursor-paginated;
 * the code / Details opens the read-only order detail dialog.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, DataTable, FilterPill, PageHeader, Pagination, Price, StatusPill, useCursorPages, type Column } from '../../components/ui';
import { formatDateTime, plural } from '../../lib/format';
import { HISTORY_FILTERS, keys, ordersApi, type OwnerOrder } from './api';
import { OrderDetailDialog } from './OrderDetailDialog';
import { useCurrentRestaurant } from './RestaurantContext';

export default function OrderHistoryPage() {
  const restaurant = useCurrentRestaurant();
  const pages = useCursorPages();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('status') ?? '';
  const status = HISTORY_FILTERS.some((f) => f.value === raw) ? raw : '';
  const [open, setOpen] = useState<OwnerOrder | null>(null);

  const statuses = HISTORY_FILTERS.find((f) => f.value === status)?.statuses.join(',');
  const q = useQuery({
    queryKey: keys.history(restaurant.id, status, pages.cursor),
    queryFn: () => ordersApi.page({ restaurantId: restaurant.id, status: statuses, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });

  const choose = (v: string) => {
    pages.reset();
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (v) n.set('status', v);
        else n.delete('status');
        return n;
      },
      { replace: true },
    );
  };

  const columns: Column<OwnerOrder>[] = [
    {
      key: 'code',
      header: 'Order',
      primary: true,
      cell: (o) => (
        <button type="button" onClick={() => setOpen(o)} className="font-mono text-[13.5px] font-medium text-fg hover:underline">
          {o.code}
        </button>
      ),
    },
    { key: 'placed', header: 'Placed', cell: (o) => <span className="font-mono text-[12.5px] text-fg-2">{o.placedAt ? formatDateTime(o.placedAt) : '—'}</span>, secondary: true },
    { key: 'status', header: 'Status', cell: (o) => <StatusPill kind="childOrder" status={o.status} density="dense" /> },
    { key: 'items', header: 'Items', cell: (o) => <span className="text-fg-2">{plural(o.lines.reduce((n, l) => n + l.quantity, 0), 'item')}</span>, hideOnMobile: true },
    {
      key: 'total',
      header: 'Items total',
      align: 'right',
      cell: (o) => {
        const p = o.breakdown?.itemsSubtotalPaise ?? o.breakdown?.totalPaise;
        return p === undefined ? '' : <Price paise={p} size="sm" />;
      },
    },
    {
      key: 'refund',
      header: 'Refund',
      cell: (o) => (o.refundStatus && o.refundStatus !== 'NONE' ? <StatusPill kind="childRefund" status={o.refundStatus} density="dense" /> : <span className="text-fg-3">—</span>),
      hideOnMobile: true,
    },
  ];

  return (
    <>
      <PageHeader title="Order history" className="mb-5" meta={<span>All orders for {restaurant.name} · times in IST</span>} />
      <div role="group" aria-label="Filter by status" className="-mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1">
        <FilterPill pressed={status === ''} onClick={() => choose('')}>
          All
        </FilterPill>
        {HISTORY_FILTERS.map((f) => (
          <FilterPill key={f.value} pressed={status === f.value} onClick={() => choose(f.value)}>
            {f.label}
          </FilterPill>
        ))}
      </div>
      <DataTable
        caption="Orders"
        columns={columns}
        rows={q.data?.items}
        getRowId={(o) => o.id}
        loading={q.isPending}
        error={q.isError && !q.data ? q.error : undefined}
        onRetry={() => q.refetch()}
        empty={{
          icon: 'receipt',
          title: status ? 'No orders match this filter' : 'No orders yet',
          description: status ? 'Try another status.' : 'Completed and past orders are listed here.',
          action: status ? <Button variant="outline" onClick={() => choose('')}>Show all orders</Button> : undefined,
        }}
        rowActions={(o) => (
          <Button variant="ghost" size="xs" onClick={() => setOpen(o)} aria-label={`View order ${o.code}`}>
            Details
          </Button>
        )}
        footer={
          <Pagination
            hasPrev={pages.hasPrev}
            hasNext={Boolean(q.data?.nextCursor)}
            onPrev={pages.prev}
            onNext={() => pages.next(q.data!.nextCursor!)}
            page={pages.page}
            loading={q.isFetching}
          />
        }
      />
      <OrderDetailDialog order={open} onClose={() => setOpen(null)} />
    </>
  );
}
