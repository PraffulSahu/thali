/**
 * `/admin/orders/:checkoutId`: order investigation. Shows each restaurant's child order, the append-only
 * `order_events` timeline, and the admin actions the state machine allows: cancel with a refund (never more
 * than what is still refundable) and the few other admin transitions.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { canTransition, childOrderTransitions } from '@thali/contracts';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardSection } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog } from '../../components/ui/Dialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Input, Textarea } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { formatPaise, Price } from '../../components/ui/Price';
import { QueryState } from '../../components/ui/QueryState';
import { StatusPill, humanize, statusLabel } from '../../components/ui/StatusPill';
import { fieldErrors } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { cancelChildOrder, getOrder, paiseToRupees, qk, rupeesToPaise, transitionChildOrder, type AdminChildOrder, type AdminOrderDetail } from './api';
import { KeyValues, Mono, SectionTitle, useAdminMutation, useAdminRoles } from './shared';

const CHILD_STATUSES = [
  'AWAITING_PAYMENT', 'PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED',
  'DELIVERY_FAILED', 'PAYMENT_FAILED', 'EXPIRED', 'REJECTED', 'CANCELLED',
] as const;
type ChildStatus = (typeof CHILD_STATUSES)[number];

const canCancel = (status: string) => canTransition(childOrderTransitions, status as ChildStatus, 'CANCELLED', 'ADMIN');
const adminMoves = (status: string) =>
  CHILD_STATUSES.filter((to) => to !== 'CANCELLED' && canTransition(childOrderTransitions, status as ChildStatus, to, 'ADMIN'));

export const remainingRefundPaise = (c: Pick<AdminChildOrder, 'totalPaise' | 'refundedPaise'>) => Math.max(0, c.totalPaise - c.refundedPaise);

/** Validates the refund input against what is still refundable. Returns the paise amount or an error. */
export function checkRefundInput(input: string, remaining: number): { paise: number; error: null } | { paise: null; error: string } {
  if (input.trim() === '') return { paise: null, error: 'Enter the refund amount in rupees (0 for no refund).' };
  const paise = rupeesToPaise(input);
  if (paise === null) return { paise: null, error: 'Enter a valid amount in rupees, like 120 or 120.50.' };
  if (paise > remaining) return { paise: null, error: `Refund cannot exceed ${formatPaise(remaining)}, the amount still refundable.` };
  return { paise, error: null };
}

function CancelDialog({ child, open, onClose, onSubmit }: { child: AdminChildOrder; open: boolean; onClose: () => void; onSubmit: (v: { reason: string; refundPaise: number }) => Promise<unknown> }) {
  const remaining = remainingRefundPaise(child);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState(paiseToRupees(remaining));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setAmount(paiseToRupees(remaining));
      setError(null);
    }
  }, [open, remaining]);

  const check = checkRefundInput(amount, remaining);
  const valid = reason.trim().length >= 3 && check.error === null;
  const serverErrors = fieldErrors(error);

  const submit = async () => {
    if (!valid || check.paise === null) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ reason: reason.trim(), refundPaise: check.paise });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      dismissible={!busy}
      title={`Cancel the ${child.restaurantName} order?`}
      description="The order is cancelled and the customer is refunded the amount below. This cannot be undone."
      size="sm"
      footer={
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Keep order
          </Button>
          <Button variant="danger" onClick={() => void submit()} disabled={!valid} loading={busy}>
            Cancel order
          </Button>
        </FormActions>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="rounded-control bg-surface-muted p-3 text-sm">
          <p className="font-semibold text-slate-900">{`Remaining to refund: ${formatPaise(remaining)}`}</p>
          <p className="text-slate-600">{`Order total ${formatPaise(child.totalPaise)}, already refunded ${formatPaise(child.refundedPaise)}`}</p>
        </div>
        {child.refundStatus === 'REQUESTED' || child.refundStatus === 'PROCESSING' ? (
          <p role="status" className="rounded-control bg-warn-50 px-3 py-2 text-sm text-warn-800">
            A refund for this order is already in progress. The server rejects a total above the captured amount.
          </p>
        ) : null}
        <Field label="Reason" required hint="Recorded in the audit log and shown to the customer" error={serverErrors.reason}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
        </Field>
        <Field label="Refund amount" required error={check.error && amount !== '' ? check.error : serverErrors.refundPaise}>
          <Input inputMode="decimal" prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <InlineError error={error && Object.keys(serverErrors).length === 0 ? error : null} />
      </form>
    </Dialog>
  );
}

function ChildCard({ child, checkoutId }: { child: AdminChildOrder; checkoutId: string }) {
  const { canOps, canSupport } = useAdminRoles();
  const [cancelling, setCancelling] = useState(false);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const invalidate = [qk.order(checkoutId) as unknown as unknown[], ['admin', 'orders']];
  const cancel = useAdminMutation((v: { reason: string; refundPaise: number }) => cancelChildOrder(child.id, v), {
    success: 'Order cancelled and refund requested',
    invalidate,
  });
  const move = useAdminMutation((v: { to: string; reason: string }) => transitionChildOrder(child.id, v), {
    success: (_d, v) => `Order moved to ${statusLabel('childOrder', v.to).toLowerCase()}`,
    invalidate,
  });
  const cancellable = canCancel(child.status);
  const moves = adminMoves(child.status);
  const allowed = canOps || canSupport;

  return (
    <Card as="li" className="list-none">
      <CardHeader
        title={child.restaurantName}
        description={child.code}
        actions={<StatusPill kind="childOrder" status={child.status} />}
      />
      <CardSection>
        {child.lines.length ? (
          <ul className="mb-3 text-[0.9375rem] text-slate-800">
            {child.lines.map((l, i) => (
              <li key={i}>
                {l.quantity} × {l.name}
              </li>
            ))}
          </ul>
        ) : null}
        <KeyValues
          items={[
            { label: 'Order total', value: <Price paise={child.totalPaise} /> },
            { label: 'Refunded so far', value: <Price paise={child.refundedPaise} /> },
            { label: 'Refund status', value: <StatusPill kind="childRefund" status={child.refundStatus} /> },
            { label: 'Delivery', value: child.deliveryStatus ? <StatusPill kind="delivery" status={child.deliveryStatus} /> : 'Not dispatched' },
          ]}
        />
        {allowed && (cancellable || moves.length) ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {cancellable ? (
              <Button variant="danger" onClick={() => setCancelling(true)}>
                Cancel and refund
              </Button>
            ) : null}
            {moves.map((to) => (
              <Button key={to} variant="secondary" onClick={() => setMoveTo(to)}>
                {to === 'ACCEPTED' ? 'Accept for restaurant' : to === 'REJECTED' ? 'Reject for restaurant' : `Mark ${statusLabel('childOrder', to).toLowerCase()}`}
              </Button>
            ))}
          </div>
        ) : !allowed ? (
          <p className="mt-3 text-sm text-slate-600">Your admin role can view orders but not change them.</p>
        ) : (
          <p className="mt-3 text-sm text-slate-600">No admin actions are available in this state.</p>
        )}
      </CardSection>
      <CancelDialog child={child} open={cancelling} onClose={() => setCancelling(false)} onSubmit={(v) => cancel.mutateAsync(v)} />
      <ConfirmDialog
        open={moveTo !== null}
        onClose={() => setMoveTo(null)}
        title={moveTo ? `Move to “${statusLabel('childOrder', moveTo)}”?` : ''}
        description={`This changes the ${child.restaurantName} order status and is audited.`}
        confirmLabel="Change status"
        reason={{ label: 'Reason', minLength: 3 }}
        onConfirm={(reason) => move.mutateAsync({ to: moveTo!, reason: reason ?? '' })}
      />
    </Card>
  );
}

function Timeline({ order }: { order: AdminOrderDetail }) {
  const names = new Map(order.children.map((c) => [c.id, c.restaurantName]));
  if (order.timeline.length === 0) return <p className="text-sm text-slate-600">No events recorded yet.</p>;
  return (
    <ol aria-label="Order timeline" className="flex flex-col border-l-2 border-slate-200 pl-4">
      {order.timeline.map((e) => (
        <li key={e.id} className="relative pb-5 last:pb-0">
          <span aria-hidden="true" className="absolute -left-[1.4rem] top-1.5 size-2.5 rounded-full bg-brand-500 ring-4 ring-surface" />
          <p className="flex flex-wrap items-center gap-2 text-[0.9375rem] font-medium text-slate-900">
            <span>{e.type}</span>
            {e.childOrderId && names.get(e.childOrderId) ? <Badge>{names.get(e.childOrderId)}</Badge> : null}
          </p>
          <p className="text-sm text-slate-600">
            {formatDateTime(e.at)} · {humanize(e.actor)}
            {e.actorId ? <> · <Mono>{e.actorId}</Mono></> : null}
          </p>
          {Object.keys(e.data).length ? (
            <p className="mt-1 break-words text-sm text-slate-700">
              {Object.entries(e.data)
                .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                .join(' · ')}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export default function OrderInvestigation() {
  const { checkoutId = '' } = useParams();
  const query = useQuery({ queryKey: qk.order(checkoutId), queryFn: () => getOrder(checkoutId) });
  return (
    <QueryState query={query}>
      {(order) => (
        <>
          <PageHeader
            title={order.code}
            documentTitle={`Order ${order.code}`}
            back={{ to: '/admin/orders', label: 'All orders' }}
            status={<StatusPill kind="checkout" status={order.status} />}
          />
          <div className="flex flex-col gap-6">
            <Card>
              <KeyValues
                items={[
                  { label: 'Placed', value: formatDateTime(order.createdAt) },
                  { label: 'Order total', value: order.totalPaise === null ? '-' : <Price paise={order.totalPaise} /> },
                  { label: 'Payment', value: order.paymentStatus ? <StatusPill kind="payment" status={order.paymentStatus} /> : '-' },
                  { label: 'Payment reference', value: order.paymentIntentId ? <Mono>{order.paymentIntentId}</Mono> : '-' },
                  { label: 'Customer', value: order.customer ? [order.customer.name, order.customer.phone].filter(Boolean).join(' · ') || order.customer.id : '-' },
                  { label: 'Deliver to', value: order.deliveryAddress ?? '-' },
                ]}
              />
            </Card>
            <section aria-label="Restaurant orders">
              <SectionTitle>Restaurant orders ({order.children.length})</SectionTitle>
              {order.children.length === 0 ? (
                <p className="text-sm text-slate-600">This checkout has no restaurant orders (it never reached payment).</p>
              ) : (
                <ul className="flex flex-col gap-4">
                  {order.children.map((c) => (
                    <ChildCard key={c.id} child={c} checkoutId={checkoutId} />
                  ))}
                </ul>
              )}
            </section>
            <Card>
              <SectionTitle>Timeline</SectionTitle>
              <Timeline order={order} />
            </Card>
          </div>
        </>
      )}
    </QueryState>
  );
}
