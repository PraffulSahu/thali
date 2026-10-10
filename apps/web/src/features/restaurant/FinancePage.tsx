/**
 * Finance (PRD R-7): earnings, commission, refunds and adjustments, balance, payouts. Everything comes from the
 * payments ledger. Payouts are recorded by Thali staff after a manual bank transfer, so a payout is only shown as
 * "Paid" when the bank reference (UTR) is on record.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  Badge, Card, DataTable, PageHeader, Pagination, Price, QueryState, RelativeTime, SkeletonList, Tabs, useCursorPages,
  type Column,
} from '../../components/ui';
import { formatBps, formatDateTime } from '../../lib/format';
import { keys, financeApi, LEDGER_LABELS, payoutDisplay, type FinanceSummary, type LedgerRow, type PayoutRow } from './api';
import { useCurrentRestaurant } from './RestaurantContext';

function Stat({ label, paise, hint, tone }: { label: string; paise: number; hint?: ReactNode; tone?: 'success' | 'default' }) {
  return (
    <Card padding="sm" className="flex flex-col gap-0.5">
      <p className="text-sm text-slate-600">{label}</p>
      <Price paise={paise} size="xl" tone={tone === 'success' ? 'success' : 'default'} />
      {hint ? <p className="text-xs text-slate-600">{hint}</p> : null}
    </Card>
  );
}

function Summary({ s, commissionBps }: { s: FinanceSummary; commissionBps: number }) {
  const t = s.totalsByType;
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Balance" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Balance" paise={s.balancePaise} hint="Everything earned minus deductions and payouts" />
        <Stat label="Available for payout" paise={s.availablePaise} tone="success" hint={s.holdDays > 0 ? `Earnings are released ${s.holdDays} ${s.holdDays === 1 ? 'day' : 'days'} after delivery` : 'Released as soon as orders are delivered'} />
        <Stat label="Payouts in progress" paise={s.pendingPayoutPaise} hint="Requested or processing, not yet confirmed" />
        <Stat label="Paid out (UTR confirmed)" paise={s.paidOutPaise} hint="Transfers with a bank reference" />
      </section>
      <section aria-label="Earnings breakdown" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Order earnings" paise={t.ORDER_EARNING ?? 0} hint="Items sold on delivered orders" />
        <Stat label="Commission" paise={t.COMMISSION ?? 0} hint={`Platform commission, ${formatBps(commissionBps)} of items`} />
        <Stat label="Refunds" paise={t.REFUND_ADJUSTMENT ?? 0} hint="Deducted when an order is refunded" />
        <Stat label="Adjustments" paise={t.MANUAL_ADJUSTMENT ?? 0} hint="Manual corrections by Thali" />
      </section>
      <p className="text-xs text-slate-600">As of <RelativeTime value={s.asOf} prefix="" /> · amounts in INR, times in IST</p>
    </div>
  );
}

function LedgerTable({ restaurantId }: { restaurantId: string }) {
  const pages = useCursorPages();
  const q = useQuery({ queryKey: keys.fin(restaurantId, 'ledger', pages.cursor), queryFn: () => financeApi.ledger(restaurantId, pages.cursor), placeholderData: keepPreviousData });
  const columns: Column<LedgerRow>[] = [
    { key: 'date', header: 'Date', cell: (e) => formatDateTime(e.createdAt), primary: true },
    { key: 'type', header: 'Type', cell: (e) => LEDGER_LABELS[e.entryType] ?? e.entryType, secondary: true },
    { key: 'memo', header: 'Details', cell: (e) => <span className="text-slate-700">{e.memo}{e.childOrderId ? <span className="block font-mono text-xs text-slate-500">Order {e.childOrderId.slice(-8)}</span> : null}</span> },
    { key: 'amount', header: 'Amount', align: 'right', cell: (e) => <Price paise={e.amountPaise} tone={e.amountPaise > 0 ? 'success' : 'default'} /> },
  ];
  return (
    <DataTable
      caption="Ledger"
      columns={columns}
      rows={q.data?.items}
      getRowId={(e) => e.id}
      loading={q.isPending}
      error={q.isError && !q.data ? q.error : undefined}
      onRetry={() => q.refetch()}
      empty={{ icon: 'wallet', title: 'No ledger entries yet', description: 'Earnings, commission and refunds appear here after your first delivered order.' }}
      footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(q.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(q.data!.nextCursor!)} page={pages.page} loading={q.isFetching} />}
    />
  );
}

function PayoutsTable({ restaurantId }: { restaurantId: string }) {
  const pages = useCursorPages();
  const q = useQuery({ queryKey: keys.fin(restaurantId, 'payouts', pages.cursor), queryFn: () => financeApi.payouts(restaurantId, pages.cursor), placeholderData: keepPreviousData });
  const columns: Column<PayoutRow>[] = [
    { key: 'date', header: 'Requested', cell: (p) => formatDateTime(p.createdAt), primary: true },
    { key: 'amount', header: 'Amount', align: 'right', cell: (p) => <Price paise={p.amountPaise} /> },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => {
        const d = payoutDisplay(p);
        return <Badge tone={d.tone} dot>{d.label}</Badge>;
      },
      secondary: true,
    },
    {
      key: 'utr',
      header: 'Bank reference (UTR)',
      cell: (p) =>
        p.utr ? <span className="font-mono text-sm">{p.utr}</span> : (
          <span className="text-slate-600">{p.status === 'FAILED' ? p.failureReason ?? 'Failed' : 'Not recorded yet'}</span>
        ),
    },
    { key: 'confirmed', header: 'Confirmed', cell: (p) => (p.confirmedAt && p.utr ? formatDateTime(p.confirmedAt) : ''), hideOnMobile: true },
  ];
  return (
    <DataTable
      caption="Payouts"
      columns={columns}
      rows={q.data?.items}
      getRowId={(p) => p.id}
      loading={q.isPending}
      error={q.isError && !q.data ? q.error : undefined}
      onRetry={() => q.refetch()}
      empty={{ icon: 'wallet', title: 'No payouts yet', description: 'Payouts are recorded by Thali after a bank transfer. They appear here with the bank reference.' }}
      footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(q.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(q.data!.nextCursor!)} page={pages.page} loading={q.isFetching} />}
    />
  );
}

export default function FinancePage() {
  const r = useCurrentRestaurant();
  const summary = useQuery({ queryKey: keys.fin(r.id, 'summary'), queryFn: () => financeApi.summary(r.id) });
  return (
    <>
      <PageHeader title="Finance" description={`Earnings and payouts for ${r.name}`} />
      <section aria-label="Summary" className="mb-6">
        <QueryState query={summary} loading={<SkeletonList count={2} />} loadingLabel="Loading finance summary…">
          {(s) => <Summary s={s} commissionBps={r.commissionBps} />}
        </QueryState>
      </section>
      <Tabs
        label="Finance details"
        tabs={[
          { id: 'ledger', label: 'Ledger', content: <LedgerTable restaurantId={r.id} /> },
          { id: 'payouts', label: 'Payouts', content: <PayoutsTable restaurantId={r.id} /> },
        ]}
      />
      <p className="mt-4 text-sm text-slate-600">
        Payouts are transferred manually by Thali. A payout is marked <strong>Paid</strong> only after the bank reference (UTR) is recorded; until then it shows as requested or processing.
      </p>
    </>
  );
}
