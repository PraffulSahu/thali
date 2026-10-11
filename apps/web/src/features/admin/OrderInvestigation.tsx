/**
 * `/admin/orders/:checkoutId`: order investigation (board 13 layout in the dense admin tier). Main column: one card
 * per restaurant order with its own events, then the full append-only `order_events` timeline. Aside: payment,
 * customer and refund summary. Admin actions the state machine allows: cancel with a refund (never more than what
 * is still refundable) and the few other admin transitions (OPS / SUPPORT / FINANCE; others see why).
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { canTransition, childOrderTransitions } from '@thali/contracts';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog } from '../../components/ui/Dialog';
import { InlineError } from '../../components/ui/ErrorState';
import { Field } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Input, Textarea } from '../../components/ui/Input';
import { SectionCard } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { formatPaise } from '../../components/ui/Price';
import { QueryState } from '../../components/ui/QueryState';
import { StatusPill, humanize, statusLabel } from '../../components/ui/StatusPill';
import { fieldErrors } from '../../lib/errors';
import { formatDateTime, formatTime } from '../../lib/format';
import { cancelChildOrder, getOrder, paiseToRupees, qk, rupeesToPaise, transitionChildOrder, type AdminChildOrder, type AdminOrderDetail } from './api';
import { Mono, useAdminMutation, useAdminRoles } from './shared';
import { RoleNote } from './ui';

const CHILD_STATUSES = [
  'AWAITING_PAYMENT', 'PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED',
  'DELIVERY_FAILED', 'PAYMENT_FAILED', 'EXPIRED', 'REJECTED', 'CANCELLED',
] as const;
type ChildStatus = (typeof CHILD_STATUSES)[number];

const canCancel = (status: string) => canTransition(childOrderTransitions, status as ChildStatus, 'CANCELLED', 'ADMIN');
const adminMoves = (status: string) =>
  CHILD_STATUSES.filter((to) => to !== 'CANCELLED' && canTransition(childOrderTransitions, status as ChildStatus, to, 'ADMIN'));

/**
 * Mirrors orders `committedRefundPaise`: what is already promised back for this child — the larger of what orders
 * requested and the non-FAILED refunds payments reported (in-flight refunds count, not only succeeded ones).
 */
export const committedRefundPaise = (c: Pick<AdminChildOrder, 'refundedPaise' | 'refundRequestedPaise' | 'refunds'>) => {
  const seen = (c.refunds ?? []).filter((r) => r.status !== 'FAILED').reduce((s, r) => s + r.amountPaise, 0);
  return Math.max(c.refundRequestedPaise ?? 0, seen, c.refundedPaise);
};
/** Mirrors orders `remainingRefundable`: total − committed refunds (never negative). */
export const remainingRefundPaise = (c: Pick<AdminChildOrder, 'totalPaise' | 'refundedPaise' | 'refundRequestedPaise' | 'refunds'>) =>
  Math.max(0, c.totalPaise - committedRefundPaise(c));

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
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Keep order
          </Button>
          <Button variant="danger" onClick={() => void submit()} disabled={!valid} loading={busy}>
            Cancel order
          </Button>
        </FormActions>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="rounded-control bg-bg-2 p-3 text-sm">
          <p className="font-semibold text-fg">{`Remaining to refund: ${formatPaise(remaining)}`}</p>
          <p className="text-fg-3">
            {`Order total ${formatPaise(child.totalPaise)}, already refunded ${formatPaise(child.refundedPaise)}`}
            {committedRefundPaise(child) > child.refundedPaise ? `, in progress ${formatPaise(committedRefundPaise(child) - child.refundedPaise)}` : ''}
          </p>
        </div>
        {child.refundStatus === 'REQUESTED' || child.refundStatus === 'PROCESSING' ? (
          <p role="status" className="rounded-control bg-warn-bg px-3 py-2 text-sm text-warn">
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

function Money({ label, children, strong, tone }: { label: string; children: React.ReactNode; strong?: boolean; tone?: 'info' | 'ok' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[13.5px] text-fg-3">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-[18px] font-semibold text-fg' : tone === 'info' ? 'text-[13.5px] text-info' : tone === 'ok' ? 'text-[13.5px] text-ok' : 'text-[13.5px] text-fg'}`}>{children}</dd>
    </div>
  );
}

function EventList({ events, names, label }: { events: AdminOrderDetail['timeline']; names: Map<string, string>; label: string }) {
  if (events.length === 0) return <p className="text-[13px] text-fg-3">No events recorded yet.</p>;
  return (
    <ol aria-label={label} className="flex flex-col">
      {events.map((e, i) => (
        <li key={e.id} className="relative grid grid-cols-[64px_14px_1fr] gap-x-2.5 pb-3.5 last:pb-0">
          <span className="pt-px text-right font-mono text-[11.5px] text-fg-3">{formatTime(e.at)}</span>
          <span aria-hidden="true" className="relative flex justify-center">
            <span className="mt-1 size-2 rounded-full bg-acc" />
            {i < events.length - 1 ? <span className="absolute bottom-[-14px] top-3.5 w-px bg-line" /> : null}
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium text-fg">
              <span className="font-mono text-[12.5px]">{e.type}</span>
              {e.childOrderId && names.get(e.childOrderId) && label === 'Order timeline' ? <span className="text-[12px] font-normal text-fg-3">· {names.get(e.childOrderId)}</span> : null}
            </span>
            <span className="block text-[12px] text-fg-3">
              {formatDateTime(e.at)} · {humanize(e.actor)}
              {e.actorId ? <> · <Mono className="text-[11.5px]">{e.actorId}</Mono></> : null}
            </span>
            {Object.keys(e.data).length ? (
              <span className="mt-0.5 block break-words text-[12.5px] text-fg-2">
                {Object.entries(e.data)
                  .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                  .join(' · ')}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ChildCard({ child, checkoutId, events, names }: { child: AdminChildOrder; checkoutId: string; events: AdminOrderDetail['timeline']; names: Map<string, string> }) {
  const { canOps, canSupport, canFinance } = useAdminRoles();
  const [cancelling, setCancelling] = useState(false);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const invalidate = [qk.order(checkoutId) as unknown as unknown[], ['admin', 'orders'], ['admin', 'checkouts']];
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
  const allowed = canOps || canSupport || canFinance;
  const committed = committedRefundPaise(child);

  return (
    <li className="list-none overflow-hidden rounded-field border border-line bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0">
          <h3 className="text-[16px] text-fg">{child.restaurantName}</h3>
          {child.code ? <p className="font-mono text-[12px] text-fg-3">{child.code}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill kind="childOrder" status={child.status} density="dense" />
          {child.deliveryStatus ? <StatusPill kind="delivery" status={child.deliveryStatus} density="dense" /> : null}
        </div>
      </header>
      <div className="grid gap-4 px-4 py-3.5 md:grid-cols-2">
        <div>
          {child.lines.length ? (
            <ul className="flex flex-col gap-1 text-[13.5px] text-fg">
              {child.lines.map((l, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span>
                    <span className="font-mono text-fg-3">{l.quantity}×</span> {l.name}
                  </span>
                  {l.lineTotalPaise !== undefined ? <span className="tabular-nums text-fg-2">{formatPaise(l.lineTotalPaise)}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-fg-3">No line items on record.</p>
          )}
        </div>
        <dl>
          <Money label="Order total">{formatPaise(child.totalPaise)}</Money>
          <Money label="Refunded" tone={child.refundedPaise > 0 ? 'ok' : undefined}>{child.refundedPaise > 0 ? formatPaise(child.refundedPaise) : '—'}</Money>
          {committed > child.refundedPaise ? <Money label="Refund in progress" tone="info">{formatPaise(committed - child.refundedPaise)}</Money> : null}
          <div className="flex items-center justify-between gap-3 py-1">
            <dt className="text-[13.5px] text-fg-3">Refund status</dt>
            <dd><StatusPill kind="childRefund" status={child.refundStatus} density="dense" /></dd>
          </div>
        </dl>
      </div>
      <div className="border-t border-line px-4 py-3.5">
        <p className="lbl mb-2 text-[11px]!">Events</p>
        <EventList events={events} names={names} label={`${child.restaurantName} events`} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-bg-2 px-4 py-3">
        {allowed && (cancellable || moves.length) ? (
          <>
            {cancellable ? (
              <Button size="sm" variant="danger-outline" onClick={() => setCancelling(true)}>
                Cancel and refund
              </Button>
            ) : null}
            {moves.map((to) => (
              <Button key={to} size="sm" variant="outline" onClick={() => setMoveTo(to)}>
                {to === 'ACCEPTED' ? 'Accept for restaurant' : to === 'REJECTED' ? 'Reject for restaurant' : `Mark ${statusLabel('childOrder', to).toLowerCase()}`}
              </Button>
            ))}
          </>
        ) : !allowed ? (
          <RoleNote>Your admin role can view orders but not change them.</RoleNote>
        ) : (
          <p className="text-[13px] text-fg-3">No admin actions are available in this state.</p>
        )}
      </div>
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
    </li>
  );
}

export default function OrderInvestigation() {
  const { checkoutId = '' } = useParams();
  const query = useQuery({ queryKey: qk.order(checkoutId), queryFn: () => getOrder(checkoutId) });
  return (
    <QueryState query={query}>
      {(order) => {
        const names = new Map(order.children.map((c) => [c.id, c.restaurantName]));
        const refunded = order.children.reduce((n, c) => n + c.refundedPaise, 0);
        const inFlight = order.children.reduce((n, c) => n + Math.max(0, committedRefundPaise(c) - c.refundedPaise), 0);
        return (
          <>
            <PageHeader
              title={<span className="font-mono text-[24px] font-semibold tracking-normal sm:text-[26px]">{order.code}</span>}
              documentTitle={`Order ${order.code}`}
              back={{ to: '/admin/orders', label: 'All orders' }}
              status={<StatusPill kind="checkout" status={order.status} />}
              meta={order.createdAt ? <span>Placed {formatDateTime(order.createdAt)} IST</span> : undefined}
            />
            <div className="flex flex-wrap items-start gap-[18px]">
              <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-[18px]">
                <section aria-label="Restaurant orders" className="flex flex-col gap-3">
                  <h2 className="text-[17px] text-fg">Restaurant orders ({order.children.length})</h2>
                  {order.children.length === 0 ? (
                    <p className="rounded-field border border-dashed border-line-2 bg-card px-4 py-6 text-center text-[13.5px] text-fg-3">This checkout has no restaurant orders (it never reached payment).</p>
                  ) : (
                    <ul className="flex flex-col gap-3">
                      {order.children.map((c) => (
                        <ChildCard key={c.id} child={c} checkoutId={checkoutId} names={names} events={order.timeline.filter((e) => e.childOrderId === c.id)} />
                      ))}
                    </ul>
                  )}
                </section>
                <SectionCard title="Timeline" count={order.timeline.length} bodyClassName="px-4 py-3.5">
                  <EventList events={order.timeline} names={names} label="Order timeline" />
                </SectionCard>
              </div>
              <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-[18px] lg:max-w-[380px]">
                <SectionCard title="Payment" bodyClassName="px-4 py-3">
                  <dl>
                    <Money label="Order total" strong>{order.totalPaise === null ? '—' : formatPaise(order.totalPaise)}</Money>
                    <Money label="Refunded" tone={refunded > 0 ? 'ok' : undefined}>{refunded > 0 ? formatPaise(refunded) : '—'}</Money>
                    {inFlight > 0 ? <Money label="Refund in progress" tone="info">{formatPaise(inFlight)}</Money> : null}
                    <div className="flex items-center justify-between gap-3 py-1">
                      <dt className="text-[13.5px] text-fg-3">Payment</dt>
                      <dd>{order.paymentStatus ? <StatusPill kind="payment" status={order.paymentStatus} density="dense" /> : '—'}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 py-1">
                      <dt className="text-[13.5px] text-fg-3">Reference</dt>
                      <dd className="min-w-0 text-right">{order.paymentIntentId ? <Mono>{order.paymentIntentId}</Mono> : '—'}</dd>
                    </div>
                  </dl>
                </SectionCard>
                <SectionCard title="Customer" bodyClassName="flex flex-col gap-2 px-4 py-3 text-[13.5px]">
                  <p className="text-fg">{order.customer ? [order.customer.name, order.customer.phone].filter(Boolean).join(' · ') || order.customer.id : '—'}</p>
                  <div>
                    <p className="lbl text-[11px]!">Deliver to</p>
                    <p className="mt-1 text-fg-2">{order.deliveryAddress ?? '—'}</p>
                  </div>
                </SectionCard>
              </aside>
            </div>
          </>
        );
      }}
    </QueryState>
  );
}
