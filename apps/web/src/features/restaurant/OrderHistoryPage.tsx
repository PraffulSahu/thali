/** Order history with a status filter (PRD R-5; the API filters by status only). Cursor-paginated; details open in a dialog. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Button, DataTable, Dialog, Field, FoodMarker, PageHeader, Pagination, Price, Select, StatusPill, useCursorPages,
  type Column,
} from '../../components/ui';
import { formatDateTime, plural } from '../../lib/format';
import { HISTORY_FILTERS, keys, ordersApi, type OwnerOrder } from './api';
import { useCurrentRestaurant } from './RestaurantContext';

function OrderDetails({ order, onClose }: { order: OwnerOrder | null; onClose: () => void }) {
  if (!order) return null;
  const b = order.breakdown;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Order ${order.code}`}
      description={order.placedAt ? `Placed ${formatDateTime(order.placedAt)}` : undefined}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        <StatusPill kind="childOrder" status={order.status} />
        <ul className="flex flex-col gap-1.5">
          {order.lines.map((l, i) => (
            <li key={i} className="flex items-start gap-2 text-[0.9375rem]">
              <FoodMarker veg={l.isVeg ?? true} />
              <span className="flex-1">
                {l.quantity} × {l.name}
                {l.addOns?.length ? <span className="block text-sm text-slate-600">{l.addOns.map((a) => a.name).join(', ')}</span> : null}
                {l.note ? <span className="block text-sm text-slate-600">Note: {l.note}</span> : null}
              </span>
              {typeof l.lineTotalPaise === 'number' ? <Price paise={l.lineTotalPaise} size="sm" /> : null}
            </li>
          ))}
        </ul>
        {b?.itemsSubtotalPaise !== undefined ? (
          <p className="flex justify-between border-t border-slate-100 pt-2 text-sm font-semibold">
            <span>Items total</span>
            <Price paise={b.itemsSubtotalPaise} />
          </p>
        ) : null}
        {order.rejectionReason ? <p className="text-sm text-slate-700"><strong>Rejection reason:</strong> {order.rejectionReason}</p> : null}
        {order.cancellationReason ? <p className="text-sm text-slate-700"><strong>Cancellation reason:</strong> {order.cancellationReason}</p> : null}
        {order.refundStatus && order.refundStatus !== 'NONE' ? (
          <p className="flex items-center gap-2 text-sm text-slate-700">
            Refund <StatusPill kind="childRefund" status={order.refundStatus} />
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export default function OrderHistoryPage() {
  const restaurant = useCurrentRestaurant();
  const pages = useCursorPages();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<OwnerOrder | null>(null);

  const statuses = HISTORY_FILTERS.find((f) => f.value === status)?.statuses.join(',');
  const q = useQuery({
    queryKey: keys.history(restaurant.id, status, pages.cursor),
    queryFn: () => ordersApi.page({ restaurantId: restaurant.id, status: statuses, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });
  const reset = () => pages.reset();

  const columns: Column<OwnerOrder>[] = [
    { key: 'code', header: 'Order', cell: (o) => <span className="font-mono">{o.code}</span>, primary: true },
    { key: 'placed', header: 'Placed', cell: (o) => (o.placedAt ? formatDateTime(o.placedAt) : ''), secondary: true },
    { key: 'items', header: 'Items', cell: (o) => plural(o.lines.reduce((n, l) => n + l.quantity, 0), 'item') },
    {
      key: 'total',
      header: 'Items total',
      align: 'right',
      cell: (o) => {
        const p = o.breakdown?.itemsSubtotalPaise ?? o.breakdown?.totalPaise;
        return p === undefined ? '' : <Price paise={p} />;
      },
    },
    { key: 'status', header: 'Status', cell: (o) => <StatusPill kind="childOrder" status={o.status} /> },
    {
      key: 'refund',
      header: 'Refund',
      cell: (o) => (o.refundStatus && o.refundStatus !== 'NONE' ? <StatusPill kind="childRefund" status={o.refundStatus} /> : <span className="text-slate-500">None</span>),
      hideOnMobile: true,
    },
  ];

  return (
    <>
      <PageHeader title="Order history" description={`All orders for ${restaurant.name}`} back={{ to: '/restaurant/orders', label: 'Live orders' }} />
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()} aria-label="Filter orders">
        <Field label="Status" className="min-w-56">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              reset();
            }}
            placeholder="All orders"
            options={HISTORY_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
          />
        </Field>
        <Button
          variant="ghost"
          onClick={() => {
            setStatus('');
            reset();
          }}
          disabled={!status}
        >
          Clear filter
        </Button>
      </form>
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
          description: status ? 'Try a different status.' : 'Completed and past orders will be listed here.',
        }}
        rowActions={(o) => (
          <Button variant="ghost" size="sm" onClick={() => setOpen(o)} aria-label={`View order ${o.code}`}>
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
      <OrderDetails order={open} onClose={() => setOpen(null)} />
    </>
  );
}
