/** Refund review: list by status, retry failed refunds, and issue a manual refund within the captured amount. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Dialog } from '../../components/ui/Dialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Input, Textarea } from '../../components/ui/Input';
import { Pagination, useCursorPages } from '../../components/ui/Pagination';
import { RadioGroup } from '../../components/ui/Radio';
import { formatPaise, Price } from '../../components/ui/Price';
import { Select } from '../../components/ui/Select';
import { StatusPill, humanize } from '../../components/ui/StatusPill';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { createManualRefund, listRefunds, qk, retryRefund, rupeesToPaise, searchPayments, type ManualRefundBody, type PaymentRow, type Refund } from './api';
import { Mono, useAdminMutation, useAdminRoles } from './shared';
import { FilterPills } from './ui';

const REASONS = [
  { value: 'ADMIN', label: 'Goodwill / admin decision' },
  { value: 'DELIVERY_FAILED', label: 'Delivery failed' },
  { value: 'CUSTOMER_CANCELLED', label: 'Customer cancelled' },
];

export function ManualRefundDialog({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill?: PaymentRow | null }) {
  const idem = useIdempotencyKey();
  const [intentId, setIntentId] = useState('');
  const [payment, setPayment] = useState<PaymentRow | null>(null);
  const [candidates, setCandidates] = useState<PaymentRow[]>([]);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<ManualRefundBody['reason']>('ADMIN');
  const [note, setNote] = useState('');
  const [childOrderId, setChildOrderId] = useState('');
  const [restaurantId, setRestaurantId] = useState('');
  const [charge, setCharge] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = useAdminMutation((v: { body: ManualRefundBody; key: string }) => createManualRefund(v.body, v.key), {
    success: 'Refund created and sent to the payment provider',
    invalidate: [['admin', 'finance']],
  });

  useEffect(() => {
    if (!open) return;
    setIntentId(prefill?.paymentIntentId ?? ''); setPayment(prefill ?? null); setCandidates([]); setLookupError(null); setAmount(''); setReason('ADMIN'); setNote('');
    setChildOrderId(''); setRestaurantId(''); setCharge(''); setError(null);
  }, [open, prefill]);
  const { renew } = idem;
  useEffect(() => renew(), [intentId, amount, reason, note, childOrderId, restaurantId, charge, renew]);

  const lookup = async () => {
    const q = intentId.trim();
    if (!q) return;
    setLooking(true);
    setLookupError(null);
    setPayment(null);
    setCandidates([]);
    try {
      const page = await searchPayments(q);
      // Only an exact payment id / order reference is selected automatically; anything else (the search also
      // matches user and provider ids) must be picked explicitly so a refund never lands on the wrong payment.
      const exact = page.items.find((p) => p.paymentIntentId === q || p.referenceId === q);
      if (exact) setPayment(exact);
      else if (page.items.length === 0) setLookupError('No payment found for that id.');
      else setCandidates(page.items);
    } catch (e) {
      setLookupError(errorMessage(e));
    } finally {
      setLooking(false);
    }
  };

  const remaining = payment ? Math.max(0, payment.capturedPaise - payment.refundedPaise - payment.refundReservedPaise) : 0;
  const paise = rupeesToPaise(amount);
  const chargePaise = charge.trim() === '' ? 0 : rupeesToPaise(charge);
  let amountError: string | undefined;
  if (amount !== '') {
    if (paise === null || paise <= 0) amountError = 'Enter a positive amount in rupees, like 250 or 250.50.';
    else if (payment && paise > remaining) amountError = `Refund cannot exceed ${formatPaise(remaining)}, the amount still refundable on this payment.`;
  }
  let chargeError: string | undefined;
  if (charge !== '') {
    if (chargePaise === null) chargeError = 'Enter an amount in rupees.';
    else if (paise !== null && chargePaise > paise) chargeError = 'The restaurant charge cannot exceed the refund.';
    else if (chargePaise > 0 && !restaurantId.trim()) chargeError = 'Add the restaurant id to charge the restaurant.';
  }
  const valid = payment !== null && paise !== null && paise > 0 && paise <= remaining && note.trim().length > 0 && chargePaise !== null && !chargeError;
  const server = fieldErrors(error);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || paise === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await create.mutateAsync({
        key: idem.key,
        body: {
          paymentIntentId: payment!.paymentIntentId,
          amountPaise: paise,
          reason,
          note: note.trim(),
          ...(childOrderId.trim() ? { childOrderId: childOrderId.trim() } : {}),
          ...(restaurantId.trim() ? { restaurantId: restaurantId.trim() } : {}),
          ...(chargePaise ? { chargeRestaurantPaise: chargePaise } : {}),
        },
      });
      idem.renew();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Manual refund"
      description="Refunds go to the customer's original payment method and can never exceed what was captured."
      footer={
        <FormActions>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid} loading={busy}>
            Issue refund
          </Button>
        </FormActions>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Field label="Payment id" required hint="The payment reference shown on the order page" error={lookupError ?? undefined}>
            <Input value={intentId} onChange={(e) => { setIntentId(e.target.value); setPayment(null); setCandidates([]); }} className="font-mono" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void lookup(); } }} />
          </Field>
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => void lookup()} loading={looking} disabled={!intentId.trim()}>
              Look up payment
            </Button>
          </div>
          {candidates.length > 0 && !payment ? (
            <RadioGroup
              legend="No exact match. Choose the payment to refund"
              name="refund-payment"
              variant="cards"
              value={null}
              onChange={(id) => setPayment(candidates.find((c) => c.paymentIntentId === id) ?? null)}
              options={candidates.map((c) => ({
                value: c.paymentIntentId,
                label: <span className="font-mono text-sm">{c.paymentIntentId}</span>,
                description: `Reference ${c.referenceId} · ${formatPaise(c.amountPaise)} · ${humanize(c.status)}`,
              }))}
            />
          ) : null}
          {payment ? (
            <p role="status" className="rounded-control bg-bg-2 p-3 text-[13px] text-fg">
              <span className="block">{`Selected payment ${payment.paymentIntentId} (reference ${payment.referenceId})`}</span>
              {`Captured ${formatPaise(payment.capturedPaise)}, refunded ${formatPaise(payment.refundedPaise)}${payment.refundReservedPaise ? `, in progress ${formatPaise(payment.refundReservedPaise)}` : ''}. Still refundable: ${formatPaise(remaining)}.`}
            </p>
          ) : null}
        </div>
        <Field label="Refund amount" required error={amountError ?? server.amountPaise}>
          <Input inputMode="decimal" prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={!payment} />
        </Field>
        <Field label="Reason" required>
          <Select value={reason} onChange={(e) => setReason(e.target.value as ManualRefundBody['reason'])} options={REASONS} />
        </Field>
        <Field label="Note" required hint="Recorded in the audit log" error={server.note}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
        </Field>
        <details className="rounded-control border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium text-fg">Link to an order or charge the restaurant (optional)</summary>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="Restaurant order id" optional>
              <Input value={childOrderId} onChange={(e) => setChildOrderId(e.target.value)} className="font-mono" />
            </Field>
            <Field label="Restaurant id" optional>
              <Input value={restaurantId} onChange={(e) => setRestaurantId(e.target.value)} className="font-mono" />
            </Field>
            <Field label="Charge to the restaurant" optional hint="Deducted from the restaurant's balance" error={chargeError}>
              <Input inputMode="decimal" prefix="₹" value={charge} onChange={(e) => setCharge(e.target.value)} />
            </Field>
          </div>
        </details>
        <InlineError error={error && Object.keys(server).length === 0 ? error : null} />
      </form>
    </Dialog>
  );
}

const STATUS_PILLS = [
  { value: 'FAILED', label: 'Failed' },
  { value: 'REQUESTED', label: 'Requested' },
  { value: 'PROCESSING', label: 'Processing' },
  { value: 'SUCCEEDED', label: 'Succeeded' },
  { value: 'ALL', label: 'All' },
];

export default function RefundsPanel({ initialStatus }: { initialStatus?: string } = {}) {
  const { canFinance } = useAdminRoles();
  const [status, setStatus] = useState(STATUS_PILLS.some((s) => s.value === initialStatus) ? initialStatus! : 'FAILED');
  const [manual, setManual] = useState(false);
  const pages = useCursorPages();
  const query = useQuery({
    queryKey: qk.refunds({ status, cursor: pages.cursor }),
    queryFn: () => listRefunds({ status: status === 'ALL' ? undefined : status, cursor: pages.cursor }),
    placeholderData: keepPreviousData,
  });
  const retry = useAdminMutation((id: string) => retryRefund(id), { success: 'Refund retry started', invalidate: [['admin', 'finance', 'refunds']] });

  const columns: Column<Refund>[] = [
    { key: 'amount', header: 'Amount', cell: (r) => <Price paise={r.amountPaise} />, primary: true },
    { key: 'status', header: 'Status', cell: (r) => <StatusPill kind="refund" status={r.status} density="dense" /> },
    { key: 'reason', header: 'Reason', cell: (r) => humanize(r.reason) },
    {
      key: 'attempts',
      header: 'Attempts',
      cell: (r) => (
        <span>
          {r.attempts}/{r.maxAttempts}
          {r.lastError ? <span className="block max-w-xs whitespace-normal break-words font-mono text-[12px] text-bad">{r.lastError}</span> : null}
        </span>
      ),
    },
    { key: 'order', header: 'Order', cell: (r) => (r.childOrderId ? <Mono>{r.childOrderId}</Mono> : <Mono>{r.checkoutGroupId}</Mono>), hideOnMobile: true },
    { key: 'created', header: 'Created', cell: (r) => formatDateTime(r.createdAt), hideOnMobile: true },
  ];

  return (
    <div>
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <FilterPills label="Refund status" value={status} onChange={(v) => { setStatus(v); pages.reset(); }} options={STATUS_PILLS} />
        {canFinance ? <Button icon="plus" size="sm" onClick={() => setManual(true)}>Manual refund</Button> : null}
      </div>
      <DataTable
        caption="Refunds"
        columns={columns}
        rows={query.data?.items}
        getRowId={(r) => r.id}
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => query.refetch()}
        empty={{ icon: 'receipt', title: status === 'FAILED' ? 'No failed refunds' : 'No refunds in this status', description: status === 'FAILED' ? 'Failed refunds that need a retry appear here.' : undefined }}
        rowActions={(r) =>
          r.status === 'FAILED' && canFinance ? (
            <Button size="xs" variant="outline" icon="refresh" loading={retry.isPending && retry.variables === r.id} onClick={() => retry.mutate(r.id)}>
              Retry refund
            </Button>
          ) : null
        }
        footer={<Pagination hasPrev={pages.hasPrev} hasNext={Boolean(query.data?.nextCursor)} onPrev={pages.prev} onNext={() => pages.next(query.data!.nextCursor!)} page={pages.page} loading={query.isFetching} />}
      />
      <ManualRefundDialog open={manual} onClose={() => setManual(false)} />
    </div>
  );
}
