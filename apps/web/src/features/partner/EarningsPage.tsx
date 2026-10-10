/**
 * Earnings & payouts `/partner/earnings` (design-spec §7.4, services/payments):
 *   KPI tiles  Today + This week (PAY-1 windows: deliveries + earned) · Available for payout · Balance ·
 *              Payout in progress · Paid out so far (all-time summary)
 *   Tabs       Earnings ledger (`GET /finance/partner/ledger`) · Payouts (`GET /finance/partner/payouts`, "Paid" only
 *              with a UTR). Payouts are made by Thali ops by bank transfer; nothing here moves money.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { KpiTile } from '../../components/ui/KpiTile';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { Price } from '../../components/ui/Price';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { formatDateTime, plural } from '../../lib/format';
import { getSummary, listLedger, listPayouts, partnerKeys, type LedgerEntry, type Payout } from './api';
import { formatRupeesShort, groupUtr, istWeekStart } from './format';
import { PayoutStatus } from './PartnerAside';

const ENTRY_LABELS: Record<string, string> = {
  DELIVERY_EARNING: 'Delivery earning',
  PAYOUT: 'Payout',
  MANUAL_ADJUSTMENT: 'Adjustment',
  REFUND_ADJUSTMENT: 'Refund adjustment',
  ORDER_EARNING: 'Order earning',
  COMMISSION: 'Commission',
};

const ledgerColumns: Column<LedgerEntry>[] = [
  { key: 'type', header: 'Entry', cell: (e) => ENTRY_LABELS[e.entryType] ?? e.entryType, primary: true },
  { key: 'memo', header: 'Details', cell: (e) => e.memo || (e.childOrderId ? `Order ${e.childOrderId}` : '—'), secondary: true },
  { key: 'when', header: 'Date (IST)', cell: (e) => <span className="font-mono text-[12.5px]">{formatDateTime(e.createdAt)}</span> },
  { key: 'amount', header: 'Amount', cell: (e) => <Price paise={e.amountPaise} tone={e.amountPaise < 0 ? 'muted' : 'ok'} />, align: 'right' },
];

const payoutColumns: Column<Payout>[] = [
  { key: 'amount', header: 'Amount', cell: (p) => <Price paise={p.amountPaise} />, primary: true },
  { key: 'status', header: 'Status', cell: (p) => <PayoutStatus payout={p} />, secondary: true },
  {
    key: 'utr',
    header: 'Bank reference (UTR)',
    cell: (p) => (p.utr ? <span className="font-mono text-[12.5px]">{groupUtr(p.utr)}</span> : p.failureReason ? <span className="text-bad">Failed: {p.failureReason}</span> : <span className="text-fg-3">Pending</span>),
  },
  { key: 'when', header: 'Requested (IST)', cell: (p) => <span className="font-mono text-[12.5px]">{formatDateTime(p.createdAt)}</span> },
  { key: 'paid', header: 'Paid (IST)', cell: (p) => <span className="font-mono text-[12.5px]">{p.utr && p.confirmedAt ? formatDateTime(p.confirmedAt) : '—'}</span>, hideOnMobile: true },
];

function WindowTile({ label, from }: { label: string; from?: string }) {
  const q = useQuery({ queryKey: partnerKeys.summary(from), queryFn: () => getSummary(from ? { from } : undefined) });
  const w = q.data?.window;
  return (
    <KpiTile
      label={label}
      loading={q.isPending}
      unavailable={q.isError || (q.data !== undefined && !w)}
      onRetry={() => void q.refetch()}
      value={w ? formatRupeesShort(w.earningsPaise) : undefined}
      sub={w ? `${plural(w.deliveries, 'delivery', 'deliveries')} · earned` : undefined}
    />
  );
}

function SummaryTiles() {
  const today = useQuery({ queryKey: partnerKeys.summary(), queryFn: () => getSummary() });
  const s = today.data;
  const common = { loading: today.isPending, unavailable: today.isError, onRetry: () => void today.refetch() };
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-3">
        <WindowTile label="Today" />
        <WindowTile label="This week" from={istWeekStart()} />
        <KpiTile label="Available for payout" highlight {...common} value={s ? formatRupeesShort(s.availablePaise) : undefined} sub={s ? `Earnings unlock after ${plural(s.holdDays, 'day')}` : undefined} />
        <KpiTile label="Balance" {...common} value={s ? formatRupeesShort(s.balancePaise) : undefined} sub="Including earnings on hold" />
        <KpiTile label="Payout in progress" {...common} value={s ? formatRupeesShort(s.pendingPayoutPaise) : undefined} />
        <KpiTile label="Paid out so far" {...common} value={s ? formatRupeesShort(s.paidOutPaise) : undefined} />
      </div>
      {s ? <p className="text-xs text-fg-3">As of {formatDateTime(s.asOf)} IST. Weeks start Monday. Payouts are made by Thali by bank transfer.</p> : null}
    </div>
  );
}

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
  const [tab, setTab] = useState<'ledger' | 'payouts'>('ledger');
  return (
    <>
      <PageHeader title="Earnings" documentTitle="Earnings & payouts" description="What you’ve earned and what Thali has paid out." />
      <div className="flex flex-col gap-6">
        <SummaryTiles />
        <section aria-label="Earnings details" className="flex flex-col gap-3">
          <SegmentedTabs
            label="Earnings details"
            semantics="tabs"
            idPrefix="earn"
            className="self-start"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'ledger', label: 'Earnings ledger' },
              { value: 'payouts', label: 'Payouts' },
            ]}
          />
          <div role="tabpanel" id={`earn-panel-${tab}`} aria-labelledby={`earn-tab-${tab}`}>
            {tab === 'ledger' ? <LedgerTab /> : <PayoutsTab />}
          </div>
        </section>
      </div>
    </>
  );
}
