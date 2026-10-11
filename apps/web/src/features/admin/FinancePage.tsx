/**
 * `/admin/finance`: segmented tabs Refunds (status filter, Retry on failed, Manual refund) · Balances · Payouts
 * (Create → Confirm with UTR → Paid; Mark failed) · Payments (search → refund). `?tab=&status=` deep links
 * (the overview "Failed refunds · Retry →" lands on `?tab=refunds&status=FAILED`). Needs FINANCE or SUPER_ADMIN.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Input } from '../../components/ui/Input';
import { InfoNotice } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { Price } from '../../components/ui/Price';
import { StatusPill } from '../../components/ui/StatusPill';
import { Tabs } from '../../components/ui/Tabs';
import { formatDateTime } from '../../lib/format';
import { searchPayments, type PaymentRow } from './api';
import BalancesPanel from './BalancesPanel';
import PayoutsPanel, { type PayoutPrefill } from './PayoutsPanel';
import RefundsPanel, { ManualRefundDialog } from './RefundsPanel';
import { Mono, useAdminRoles } from './shared';
import { DemoTag } from './ui';

const TABS = ['refunds', 'balances', 'payouts', 'payments'];

function PaymentsPanel() {
  const { canFinance } = useAdminRoles();
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [refunding, setRefunding] = useState<PaymentRow | null>(null);
  const query = useQuery({ queryKey: ['admin', 'finance', 'payments', q], queryFn: () => searchPayments(q, 20), enabled: q.length > 0 });

  const columns: Column<PaymentRow>[] = [
    { key: 'id', header: 'Payment', cell: (p) => <span className="inline-flex items-center gap-2"><Mono>{p.paymentIntentId}</Mono>{p.isDemo ? <DemoTag /> : null}</span>, primary: true },
    { key: 'ref', header: 'Reference', cell: (p) => <Mono>{p.referenceId}</Mono>, secondary: true },
    { key: 'status', header: 'Status', cell: (p) => <StatusPill kind="payment" status={p.status} density="dense" /> },
    { key: 'amount', header: 'Amount', cell: (p) => <Price paise={p.amountPaise} size="sm" />, align: 'right' },
    { key: 'captured', header: 'Captured', cell: (p) => <Price paise={p.capturedPaise} size="sm" />, align: 'right', hideOnMobile: true },
    { key: 'refunded', header: 'Refunded', cell: (p) => (p.refundedPaise ? <Price paise={p.refundedPaise} size="sm" tone="ok" /> : <span className="text-fg-3">—</span>), align: 'right' },
    { key: 'created', header: 'Created', cell: (p) => <span className="text-fg-3">{formatDateTime(p.createdAt)}</span>, hideOnMobile: true },
  ];

  return (
    <div className="flex flex-col gap-3.5">
      <form
        role="search"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <Input type="search" icon="search" aria-label="Search payments" placeholder="Payment id, order reference, user id or provider id" value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full sm:w-96" />
        <Button type="submit" variant="outline" size="sm" disabled={!draft.trim()}>
          Search
        </Button>
      </form>
      {q ? (
        <DataTable
          caption="Payments"
          columns={columns}
          rows={query.data?.items}
          getRowId={(p) => p.paymentIntentId}
          loading={query.isPending}
          error={query.isError ? query.error : undefined}
          onRetry={() => query.refetch()}
          empty={{ icon: 'wallet', title: `No payments match “${q}”`, description: 'Search by the payment id, the order (checkout) reference, the user id or the provider payment id.' }}
          rowActions={(p) =>
            canFinance && p.capturedPaise - p.refundedPaise - p.refundReservedPaise > 0 ? (
              <Button size="xs" variant="outline" onClick={() => setRefunding(p)}>
                Refund
              </Button>
            ) : null
          }
        />
      ) : (
        <p className="text-[13.5px] text-fg-3">Find a payment to see what was captured and refunded, and issue a manual refund within the captured amount.</p>
      )}
      <ManualRefundDialog open={refunding !== null} prefill={refunding} onClose={() => setRefunding(null)} />
    </div>
  );
}

export default function FinancePage() {
  const { canFinance } = useAdminRoles();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get('tab') ?? '') ? params.get('tab')! : 'refunds';
  const [prefill, setPrefill] = useState<PayoutPrefill | null>(null);
  const setTab = (t: string) => setParams({ tab: t }, { replace: true });

  return (
    <>
      <PageHeader title="Finance" description="Review refunds, see what restaurants and partners are owed, and record manual payouts." />
      {!canFinance ? (
        <InfoNotice tone="warn" icon="lock" role="note" className="mb-4">
          Finance data needs the Finance admin role (or super admin). The server refuses these requests for other roles, so you will see access errors below.
        </InfoNotice>
      ) : null}
      <Tabs
        variant="segmented"
        label="Finance sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'refunds', label: 'Refunds', content: <RefundsPanel initialStatus={params.get('status') ?? undefined} /> },
          {
            id: 'balances',
            label: 'Balances',
            content: (
              <BalancesPanel
                onRequestPayout={(p) => {
                  setPrefill(p);
                  setTab('payouts');
                }}
              />
            ),
          },
          { id: 'payouts', label: 'Payouts', content: <PayoutsPanel prefill={prefill} onPrefillUsed={() => setPrefill(null)} /> },
          { id: 'payments', label: 'Payments', content: <PaymentsPanel /> },
        ]}
      />
    </>
  );
}
