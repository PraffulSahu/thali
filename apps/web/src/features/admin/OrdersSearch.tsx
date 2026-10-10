/** `/admin/orders`: search checkouts by id/code, customer phone, restaurant, status and date. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { Price } from '../../components/ui/Price';
import { Select } from '../../components/ui/Select';
import { StatusPill, statusLabel } from '../../components/ui/StatusPill';
import { formatDateTime } from '../../lib/format';
import { istDateToIso, qk, searchOrders, type AdminOrderSummary } from './api';
import { FilterBar } from './shared';

const STATUSES = ['AWAITING_PAYMENT', 'PAID_PLACED', 'IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED', 'PAYMENT_FAILED', 'EXPIRED'];
type Filters = { q: string; phone: string; restaurantId: string; status: string; from: string; to: string };
const EMPTY: Filters = { q: '', phone: '', restaurantId: '', status: '', from: '', to: '' };

export default function OrdersSearch() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const pages = useCursorPages();
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const query = useQuery({
    queryKey: qk.orders({ ...applied, cursor: pages.cursor }),
    queryFn: () =>
      searchOrders({
        q: applied.q.trim() || undefined,
        phone: applied.phone.trim() || undefined,
        restaurantId: applied.restaurantId.trim() || undefined,
        status: applied.status || undefined,
        from: istDateToIso(applied.from, 'start'),
        to: istDateToIso(applied.to, 'end'),
        cursor: pages.cursor,
      }),
    placeholderData: keepPreviousData,
  });

  const columns: Column<AdminOrderSummary>[] = [
    { key: 'code', header: 'Order', cell: (o) => o.code, primary: true },
    { key: 'customer', header: 'Customer', cell: (o) => o.customerLabel || '-', secondary: true },
    { key: 'restaurants', header: 'Restaurants', cell: (o) => o.restaurants.join(', ') || '-', hideOnMobile: true },
    { key: 'status', header: 'Status', cell: (o) => <StatusPill kind="checkout" status={o.status} /> },
    { key: 'total', header: 'Total', cell: (o) => (o.totalPaise === null ? '-' : <Price paise={o.totalPaise} />), align: 'right' },
    { key: 'created', header: 'Placed', cell: (o) => formatDateTime(o.createdAt), hideOnMobile: true },
  ];

  return (
    <>
      <PageHeader title="Orders" description="Search any order, then open it to investigate the timeline, cancel or refund." />
      <FilterBar
        onSubmit={() => {
          pages.reset();
          setApplied(draft);
        }}
      >
        <Field label="Order id or code">
          <Input value={draft.q} onChange={set('q')} placeholder="TH-1001 or checkout id" />
        </Field>
        <Field label="Customer phone">
          <Input type="tel" inputMode="tel" value={draft.phone} onChange={set('phone')} placeholder="+91 98765 43210" />
        </Field>
        <Field label="Restaurant id" hint="From the restaurant page address">
          <Input value={draft.restaurantId} onChange={set('restaurantId')} />
        </Field>
        <Field label="Status">
          <Select value={draft.status} onChange={set('status')} placeholder="Any status" options={STATUSES.map((s) => ({ value: s, label: statusLabel('checkout', s) }))} />
        </Field>
        <Field label="From (IST)">
          <Input type="date" value={draft.from} onChange={set('from')} />
        </Field>
        <Field label="To (IST)">
          <Input type="date" value={draft.to} onChange={set('to')} />
        </Field>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit">Search</Button>
          <Button type="button" variant="ghost" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); pages.reset(); }}>
            Clear
          </Button>
        </div>
      </FilterBar>
      <DataTable
        caption="Orders"
        columns={columns}
        rows={query.data?.items}
        getRowId={(o) => o.id}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        rowHref={(o) => `/admin/orders/${o.id}`}
        empty={{ icon: 'receipt', title: 'No orders match', description: 'Check the id or phone number, or widen the date range.' }}
        footer={
          <Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />
        }
      />
    </>
  );
}
