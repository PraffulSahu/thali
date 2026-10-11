/**
 * `/admin/orders`: checkout-level order search (ORD-1 `GET /admin/orders/checkouts`). One search box takes a TH- code,
 * a checkout/child/user/restaurant id, a restaurant-name prefix or a phone (4–13 digits → ORD-7 last-4 match); status
 * and day filters live in the URL (`?q&status&range&from&to&restaurantId`) so "View all →" on the overview lands here
 * with the same filters. Rows open the investigation page.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { SectionCard } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { istDateToIso, listCheckouts, qk } from './api';
import { CHECKOUT_STATUS_OPTIONS, CheckoutsTable, DATE_RANGES, istToday, PillSelect, rangeToIso, type DateRange } from './ui';

type Range = DateRange | 'custom';
const RANGES: { value: Range; label: string }[] = [...DATE_RANGES, { value: 'custom', label: 'Custom dates' }];

export default function OrdersSearch() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const statusParam = params.get('status') ?? 'ALL';
  const status = CHECKOUT_STATUS_OPTIONS.some((o) => o.value === statusParam) ? statusParam : 'ALL';
  const range = (RANGES.some((r) => r.value === params.get('range')) ? params.get('range') : 'all') as Range;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const restaurantId = params.get('restaurantId') ?? '';
  const [draft, setDraft] = useState(q);
  const [rid, setRid] = useState(restaurantId);
  // ⌘K "Search all orders for …" can change ?q while this page is open: keep the inputs in step with the URL.
  useEffect(() => setDraft(q), [q]);
  useEffect(() => setRid(restaurantId), [restaurantId]);
  const pages = useCursorPages();

  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) (v ? p.set(k, v) : p.delete(k));
    pages.reset();
    setParams(p, { replace: true });
  };

  const win = range === 'custom' ? { from: from ? istDateToIso(from, 'start') : undefined, to: to ? istDateToIso(to, 'end') : undefined } : rangeToIso(range);
  const query = useQuery({
    queryKey: qk.checkouts({ q, status, range, from, to, restaurantId, day: istToday(), cursor: pages.cursor }),
    queryFn: () =>
      listCheckouts({
        q: q || undefined,
        status: status === 'ALL' ? undefined : status,
        restaurantId: restaurantId || undefined,
        ...win,
        cursor: pages.cursor,
      }),
    placeholderData: keepPreviousData,
  });

  const filtered = Boolean(q || status !== 'ALL' || range !== 'all' || restaurantId);
  const clear = () => {
    setDraft('');
    setRid('');
    pages.reset();
    setParams(new URLSearchParams(), { replace: true });
  };

  return (
    <>
      <PageHeader title="Orders" description="Search any order, then open it to investigate the timeline, cancel or refund." />
      <div className="flex flex-col gap-[18px]">
        <form
          role="search"
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: draft.trim() || null });
          }}
        >
          <Field label="Search orders" hint="Order code (TH-…), phone number, restaurant name, or a checkout / user / restaurant id" className="flex-1">
            <Input type="search" icon="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="TH-K7Z2MP4Q, 98765 43210, Spice Route…" />
          </Field>
          <Button type="submit">Search</Button>
        </form>

        <SectionCard
          title={q ? `Results for “${q}”` : 'All orders'}
          actions={
            <div className="flex flex-wrap items-center gap-1.5">
              <PillSelect label="Order status" prefix="Status:" value={status} onChange={(v) => update({ status: v === 'ALL' ? null : v })} options={CHECKOUT_STATUS_OPTIONS} />
              <PillSelect label="Placed" value={range} onChange={(v) => update({ range: v === 'all' ? null : v })} options={RANGES} />
              {filtered ? (
                <Button size="xs" variant="ghost" onClick={clear}>
                  Clear
                </Button>
              ) : null}
            </div>
          }
        >
          {range === 'custom' || restaurantId ? (
            <div className="grid grid-cols-1 gap-3 border-b border-line px-4 py-3 sm:grid-cols-3">
              {range === 'custom' ? (
                <>
                  <Field label="From (IST)">
                    <Input type="date" density="compact" value={from} onChange={(e) => update({ from: e.target.value || null })} />
                  </Field>
                  <Field label="To (IST)">
                    <Input type="date" density="compact" value={to} onChange={(e) => update({ to: e.target.value || null })} />
                  </Field>
                </>
              ) : null}
              {restaurantId ? (
                <Field label="Restaurant id">
                  <Input density="compact" className="font-mono" value={rid} onChange={(e) => setRid(e.target.value)} onBlur={() => update({ restaurantId: rid.trim() || null })} />
                </Field>
              ) : null}
            </div>
          ) : null}
          <CheckoutsTable
            caption="Orders"
            rows={query.data?.items}
            loading={query.isPending}
            error={query.isError ? query.error : undefined}
            onRetry={() => void query.refetch()}
            showDate
            skeletonRows={8}
            empty={{
              title: 'No orders match',
              description: 'Check the code or phone number, or widen the status and date filters.',
              action: filtered ? (
                <Button variant="outline" onClick={clear}>
                  Clear filters
                </Button>
              ) : undefined,
            }}
          />
          {query.data && (pages.hasPrev || query.data.nextCursor) ? (
            <div className="border-t border-line px-4 pb-4">
              <Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />
            </div>
          ) : null}
        </SectionCard>
      </div>
    </>
  );
}
