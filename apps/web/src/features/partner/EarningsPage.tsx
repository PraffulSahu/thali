/**
 * Earnings and payouts (services/payments `GET /finance/partner/summary|ledger|payouts`).
 * Payouts are recorded manually by Thali ops (bank transfer, UTR); nothing here can move money.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Card } from '../../components/ui/Card';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { Price } from '../../components/ui/Price';
import { QueryState } from '../../components/ui/QueryState';
import { StatusPill } from '../../components/ui/StatusPill';
import { Tabs } from '../../components/ui/Tabs';
import { formatDateTime, plural } from '../../lib/format';
import { getSummary, listLedger, listPayouts, partnerKeys, type FinanceSummary, type LedgerEntry, type Payout } from './api';

const ENTRY_LABELS: Record<string, string> = {
  DELIVERY_EARNING: 'Delivery earning',
  PAYOUT: 'Payout',
  MANUAL_ADJUSTMENT: 'Adjustment',
  REFUND_ADJUSTMENT: 'Refund adjustment',
  ORDER_EARNING: 'Order earning',
  COMMISSION: 'Commission',
};

function Stat({ label, paise, hint, strong }: { label: string; paise: number; hint?: string; strong?: boolean }) {
  return (
    <Card padding="sm">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="mt-1">
        <Price paise={paise} size={strong ? 'xl' : 'lg'} />
        {hint ? <span className="mt-0.5 block text-xs text-slate-600">{hint}</span> : null}
      </dd>
    </Card>
  );
}

function Summary({ s }: { s: FinanceSummary }) {
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Available to pay out" paise={s.availablePaise} strong hint={`Earnings unlock after ${plural(s.holdDays, 'day')}`} />
        <Stat label="Balance" paise={s.balancePaise} hint="Including earnings still on hold" />
        <Stat label="Payout in progress" paise={s.pendingPayoutPaise} />
        <Stat label="Paid out so far" paise={s.paidOutPaise} />
      </dl>
      <p className="text-xs text-slate-600">As of {formatDateTime(s.asOf)}. Payouts are made by Thali by bank transfer.</p>
    </div>
  );
}

const ledgerColumns: Column<LedgerEntry>[] = [
  { key: 'type', header: 'Entry', cell: (e) => ENTRY_LABELS[e.entryType] ?? e.entryType, primary: true },
  { key: 'memo', header: 'Details', cell: (e) => e.memo || (e.childOrderId ? `Order ${e.childOrderId}` : ''), secondary: true },
  { key: 'when', header: 'Date', cell: (e) => <span className="tabular-nums">{formatDateTime(e.createdAt)}</span> },
  { key: 'amount', header: 'Amount', cell: (e) => <Price paise={e.amountPaise} tone={e.amountPaise < 0 ? 'muted' : 'success'} />, align: 'right' },
];

const payoutColumns: Column<Payout>[] = [
  { key: 'amount', header: 'Amount', cell: (p) => <Price paise={p.amountPaise} />, primary: true },
  { key: 'status', header: 'Status', cell: (p) => <StatusPill kind="payout" status={p.status} />, secondary: true },
  { key: 'utr', header: 'Bank reference (UTR)', cell: (p) => p.utr ?? (p.failureReason ? `Failed: ${p.failureReason}` : 'Pending') },
  { key: 'when', header: 'Requested', cell: (p) => <span className="tabular-nums">{formatDateTime(p.createdAt)}</span> },
];

function LedgerTab() {
  const pages = useCursorPages();
  const q = useQuery({ queryKey: partnerKeys.ledger(pages.cursor), queryFn: () => listLedger(pages.cursor), placeholderData: keepPreviousData });
  return (
    <DataTable
      caption="Earnings ledger"
      columns={ledgerColumns}
      rows={q.data?.items}
      getRowId={(e) => e.id}
      loading={q.isPending}
      error={q.isError ? q.error : undefined}
      onRetry={q.refetch}
      empty={{ icon: 'wallet', title: 'No earnings yet', description: 'Each completed delivery adds an entry here.' }}
      footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(q.data?.nextCursor)} onPrev={pages.prev} onNext={() => q.data?.nextCursor && pages.next(q.data.nextCursor)} page={pages.page} loading={q.isFetching} />}
    />
  );
}

function PayoutsTab() {
  const pages = useCursorPages();
  const q = useQuery({ queryKey: partnerKeys.payouts(pages.cursor), queryFn: () => listPayouts(pages.cursor), placeholderData: keepPreviousData });
  return (
    <DataTable
      caption="Payouts"
      columns={payoutColumns}
      rows={q.data?.items}
      getRowId={(p) => p.id}
      loading={q.isPending}
      error={q.isError ? q.error : undefined}
      onRetry={q.refetch}
      empty={{ icon: 'wallet', title: 'No payouts yet', description: 'When Thali pays out your available balance, the transfer shows up here with its bank reference.' }}
      footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(q.data?.nextCursor)} onPrev={pages.prev} onNext={() => q.data?.nextCursor && pages.next(q.data.nextCursor)} page={pages.page} loading={q.isFetching} />}
    />
  );
}

export default function EarningsPage() {
  const summary = useQuery({ queryKey: partnerKeys.summary, queryFn: getSummary });
  return (
    <>
      <PageHeader title="Earnings" description="What you have earned and what Thali has paid out." />
      <div className="space-y-6">
        <QueryState query={summary}>{(s) => <Summary s={s} />}</QueryState>
        <Tabs
          label="Earnings details"
          tabs={[
            { id: 'ledger', label: 'Earnings', content: <LedgerTab /> },
            { id: 'payouts', label: 'Payouts', content: <PayoutsTab /> },
          ]}
        />
      </div>
    </>
  );
}
