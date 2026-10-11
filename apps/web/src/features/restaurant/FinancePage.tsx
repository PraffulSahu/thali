/**
 * Finance (design-spec §7.3): today's window (PAY-1 `window.earningsPaise` + per-type, IST midnight → now), all-time
 * tiles (earnings, commission, refunds/adjustments, balance, available for payout highlighted), then the ledger and
 * payouts tables. Payouts are manual bank transfers by Thali: "Paid" only with a bank reference (UTR).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  Badge, DataTable, ErrorState, KpiTile, PageHeader, Pagination, Price, RelativeTime, Tabs, useCursorPages, type Column,
} from '../../components/ui';
import { formatBps, formatDateTime } from '../../lib/format';
import { keys, financeApi, istTodayRange, LEDGER_LABELS, payoutDisplay, type FinanceSummary, type LedgerRow, type PayoutRow } from './api';
import { useCurrentRestaurant } from './RestaurantContext';

const money = (paise: number | undefined) => <Price paise={paise ?? 0} size="xl" className="text-[26px]! font-semibold max-sm:text-[22px]!" />;

function grid(children: ReactNode, label: string) {
  return (
    <section aria-label={label} className="grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-2.5 max-sm:grid-cols-2">
      {children}
    </section>
  );
}

function TodayTiles({ s }: { s: FinanceSummary }) {
  const w = s.window;
  if (!w) {
    return grid(
      <>
        <KpiTile label="Earned today" unavailable />
        <KpiTile label="Order earnings today" unavailable />
        <KpiTile label="Commission today" unavailable />
        <KpiTile label="Refunds today" unavailable />
      </>,
      'Today',
    );
  }
  const t = w.entriesByType;
  return grid(
    <>
      <KpiTile label="Earned today" value={money(w.earningsPaise)} sub="Order earnings − commission − refunds" />
      <KpiTile label="Order earnings today" value={money(t.ORDER_EARNING)} />
      <KpiTile label="Commission today" value={money(t.COMMISSION)} />
      <KpiTile label="Refunds today" value={money(t.REFUND_ADJUSTMENT)} />
    </>,
    'Today',
  );
}

function AllTimeTiles({ s, commissionBps }: { s: FinanceSummary; commissionBps: number }) {
  const t = s.totalsByType;
  const adjustments = (t.REFUND_ADJUSTMENT ?? 0) + (t.MANUAL_ADJUSTMENT ?? 0);
  return grid(
    <>
      <KpiTile label="Earnings" value={money(t.ORDER_EARNING)} sub="Items sold on delivered orders" />
      <KpiTile label="Commission" value={money(t.COMMISSION)} sub={`Platform commission, ${formatBps(commissionBps)} of items`} />
      <KpiTile label="Refunds / adjustments" value={money(adjustments)} sub={`Refunds ${formatPlain(t.REFUND_ADJUSTMENT)} · manual ${formatPlain(t.MANUAL_ADJUSTMENT)}`} />
      <KpiTile label="Balance" value={money(s.balancePaise)} sub="Earned minus deductions and payouts" />
      <KpiTile
        label="Available for payout"
        highlight
        value={money(s.availablePaise)}
        sub={s.holdDays > 0 ? `Released ${s.holdDays} ${s.holdDays === 1 ? 'day' : 'days'} after delivery` : 'Released when orders are delivered'}
      />
    </>,
    'All time',
  );
}

function formatPlain(paise: number | undefined) {
  const p = paise ?? 0;
  const abs = Math.abs(p);
  return `${p < 0 ? '−' : ''}₹${(abs / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function LedgerTable({ restaurantId }: { restaurantId: string }) {
  const pages = useCursorPages();
  const q = useQuery({ queryKey: keys.fin(restaurantId, 'ledger', pages.cursor), queryFn: () => financeApi.ledger(restaurantId, pages.cursor), placeholderData: keepPreviousData });
  const columns: Column<LedgerRow>[] = [
    { key: 'date', header: 'Date', cell: (e) => <span className="font-mono text-[12.5px] text-fg-2">{formatDateTime(e.createdAt)}</span>, secondary: true },
    { key: 'type', header: 'Type', cell: (e) => <span className="font-medium text-fg">{LEDGER_LABELS[e.entryType] ?? e.entryType}</span>, primary: true },
    {
      key: 'memo',
      header: 'Details',
      cell: (e) => (
        <span className="text-fg-2">
          {e.memo}
          {e.childOrderId ? <span className="block font-mono text-xs text-fg-3">Order …{e.childOrderId.slice(-8)}</span> : null}
        </span>
      ),
      hideOnMobile: true,
    },
    { key: 'amount', header: 'Amount', align: 'right', cell: (e) => <Price paise={e.amountPaise} size="sm" tone={e.amountPaise > 0 ? 'ok' : 'default'} /> },
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
    { key: 'date', header: 'Requested', cell: (p) => <span className="font-mono text-[12.5px] text-fg-2">{formatDateTime(p.createdAt)}</span>, secondary: true },
    { key: 'amount', header: 'Amount', align: 'right', cell: (p) => <Price paise={p.amountPaise} size="sm" />, primary: true },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => {
        const d = payoutDisplay(p);
        return (
          <Badge tone={d.tone} dot density="dense">
            {d.label}
          </Badge>
        );
      },
    },
    {
      key: 'utr',
      header: 'Bank reference (UTR)',
      cell: (p) =>
        p.utr ? <span className="font-mono text-[13px]">{p.utr}</span> : <span className="text-fg-3">{p.status === 'FAILED' ? p.failureReason ?? 'Failed' : 'Not recorded yet'}</span>,
    },
    { key: 'confirmed', header: 'Confirmed', cell: (p) => (p.confirmedAt && p.utr ? <span className="font-mono text-[12.5px] text-fg-2">{formatDateTime(p.confirmedAt)}</span> : ''), hideOnMobile: true },
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
      empty={{ icon: 'wallet', title: 'No payouts yet', description: 'Payouts are recorded by Thali after a bank transfer and appear here with the bank reference.' }}
      footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(q.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(q.data!.nextCursor!)} page={pages.page} loading={q.isFetching} />}
    />
  );
}

export default function FinancePage() {
  const r = useCurrentRestaurant();
  const summary = useQuery({ queryKey: keys.fin(r.id, 'summary'), queryFn: () => financeApi.summary(r.id, { from: istTodayRange().from }), refetchInterval: 60_000 });
  const s = summary.data;
  return (
    <>
      <PageHeader
        title="Finance"
        className="mb-5"
        meta={
          <>
            <span>Amounts in INR · times in IST</span>
            {s ? <RelativeTime value={s.asOf} prefix="as of" /> : null}
          </>
        }
      />
      {s ? (
        <div className="mb-6 flex flex-col gap-5">
          <div className="flex flex-col gap-2.5">
            <h2 className="lbl">Today</h2>
            <TodayTiles s={s} />
          </div>
          <div className="flex flex-col gap-2.5">
            <h2 className="lbl">All time</h2>
            <AllTimeTiles s={s} commissionBps={r.commissionBps} />
            <p className="text-[13px] text-fg-3">
              Payouts in progress <Price paise={s.pendingPayoutPaise} size="sm" className="text-fg" /> · Paid out with a UTR <Price paise={s.paidOutPaise} size="sm" className="text-fg" />
            </p>
          </div>
        </div>
      ) : summary.isError ? (
        <ErrorState error={summary.error} title="Couldn't load your finance summary" onRetry={() => void summary.refetch()} retrying={summary.isFetching} className="mb-6" />
      ) : (
        <div className="mb-6 flex flex-col gap-5" aria-hidden="true">
          {grid([0, 1, 2, 3].map((i) => <KpiTile key={i} label=" " loading />), 'Loading')}
          {grid([0, 1, 2, 3, 4].map((i) => <KpiTile key={i} label=" " loading />), 'Loading')}
        </div>
      )}
      <Tabs
        label="Finance details"
        variant="segmented"
        tabs={[
          { id: 'ledger', label: 'Ledger', content: <LedgerTable restaurantId={r.id} /> },
          { id: 'payouts', label: 'Payouts', content: <PayoutsTable restaurantId={r.id} /> },
        ]}
      />
      <p className="mt-4 text-[13px] text-fg-3">
        Payouts are transferred manually by Thali. A payout is marked <strong className="font-medium text-fg-2">Paid</strong> only once the bank reference (UTR) is recorded.
      </p>
    </>
  );
}
