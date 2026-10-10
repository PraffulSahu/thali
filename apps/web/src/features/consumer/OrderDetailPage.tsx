/**
 * Order detail (PRD C-10/C-11/C-12, §4.5, context §7): one card per restaurant (child order) with its own
 * status timeline, delivery tracking ("Delivered separately"), refund state ("Refund initiated" while
 * REQUESTED/PROCESSING vs "Refunded" once SUCCEEDED), explanations for rejected/cancelled parts, adjusted
 * totals, cancel (only while PLACED), reorder and a support link. Live via `order.updated` /
 * `delivery.location` SSE with polling fallback.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  ConfirmDialog,
  Dialog,
  FoodMarker,
  Icon,
  PageHeader,
  Price,
  QueryState,
  RealtimeStatus,
  SkeletonList,
  StatusPill,
  useToast,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { statusLabel } from '../../components/ui/StatusPill';
import { useRealtime } from '../../hooks/useRealtime';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatINR, formatTime, plural } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  cancelChild,
  CART_KEY,
  fetchOrder,
  refundLabel,
  reorder,
  type AdjustedTotals,
  type CheckoutView,
  type ChildOrder,
  type OrderExplanation,
  type ReorderChange,
  type TrackingView,
} from './api';
import { BreakdownRows, DemoBadge, EtaText, Row, SeparateDeliveryNote } from './parts';
import { TrackingMap, trackingKey } from './TrackingMap';

const STEPS: { status: string; label: string }[] = [
  { status: 'PLACED', label: 'Placed' },
  { status: 'ACCEPTED', label: 'Accepted' },
  { status: 'PREPARING', label: 'Preparing' },
  { status: 'READY_FOR_PICKUP', label: 'Ready' },
  { status: 'PICKED_UP', label: 'Picked up' },
  { status: 'OUT_FOR_DELIVERY', label: 'On the way' },
  { status: 'DELIVERED', label: 'Delivered' },
];
const TRACKABLE = new Set(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY']);
const REFUND_PENDING = new Set<string>(['REQUESTED', 'PROCESSING']);

export const orderKey = (checkoutId: string) => ['order', checkoutId] as const;

/** Amount of this part's refund: the explanation's `refundPaise` (server), else the child's `refundRequestedPaise`. */
export function childRefundAmount(c: ChildOrder, explanation?: OrderExplanation): number {
  const requested = explanation?.refundPaise ?? c.refundRequestedPaise ?? 0;
  if (c.refundStatus === 'SUCCEEDED') return c.refundedPaise || requested;
  return Math.max(0, requested - (c.refundedPaise ?? 0)) || requested;
}

/** Local explanation only for states the server doesn't explain (it explains REJECTED/CANCELLED/DELIVERY_FAILED). */
function localExplanation(c: ChildOrder): string | null {
  switch (c.status) {
    case 'EXPIRED':
      return 'Payment was not completed in time, so this order was not placed. You were not charged.';
    case 'PAYMENT_FAILED':
      return 'Payment failed, so this order was not placed.';
    default:
      return null;
  }
}

function Timeline({ child }: { child: ChildOrder }) {
  if (child.statusHistory?.length) {
    return (
      <ol className="space-y-1 border-l-2 border-slate-200 pl-3 text-sm" aria-label="Status history">
        {child.statusHistory.map((h, i) => (
          <li key={`${h.to}-${h.at}-${i}`} className="relative">
            <span className="absolute -left-[1.05rem] top-1.5 size-2 rounded-full bg-brand-500" aria-hidden />
            <span className="font-medium text-slate-900">{statusLabel('childOrder', h.to)}</span>{' '}
            {h.at ? (
              <time className="text-slate-600" dateTime={h.at}>
                {formatTime(h.at)}
              </time>
            ) : null}
            {h.reason ? <span className="block text-slate-600">{h.reason}</span> : null}
          </li>
        ))}
      </ol>
    );
  }
  const idx = STEPS.findIndex((s) => s.status === child.status);
  if (idx < 0) return null;
  return (
    <ol className="flex flex-wrap gap-x-1 gap-y-2 text-xs" aria-label="Order progress">
      {STEPS.map((s, i) => (
        <li key={s.status} className="flex items-center gap-1" aria-current={i === idx ? 'step' : undefined}>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-pill px-2 py-0.5',
              i < idx && 'bg-success-50 text-success-800',
              i === idx && 'bg-brand-600 font-semibold text-white',
              i > idx && 'bg-slate-100 text-slate-600',
            )}
          >
            {i < idx ? <Icon name="check" size={12} /> : null}
            {s.label}
          </span>
          {i < STEPS.length - 1 ? <span className="text-slate-300" aria-hidden>›</span> : null}
        </li>
      ))}
    </ol>
  );
}

function ChildCard({ order, child, explanation }: { order: CheckoutView; child: ChildOrder; explanation: OrderExplanation | undefined }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const refund = refundLabel(child.refundStatus);
  const trackable = TRACKABLE.has(child.status) && (child.deliveryStatus !== null || ['PICKED_UP', 'OUT_FOR_DELIVERY'].includes(child.status));
  const showCode = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY'].includes(child.status);
  const supportHref = `/support?checkoutId=${order.id}&childOrderId=${child.id}`;
  return (
    <Card as="section" aria-label={child.restaurantName}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{child.restaurantName}</h2>
          <p className="text-xs text-slate-600">Order {child.code}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill kind="childOrder" status={child.status} />
          {child.deliveryStatus ? <StatusPill kind="delivery" status={child.deliveryStatus} /> : null}
        </div>
      </div>
      <SeparateDeliveryNote note={child.delivery?.note} className="mt-1" />

      <div className="mt-3 space-y-3">
        <Timeline child={child} />
        {explanation || localExplanation(child) ? (
          <p className="rounded-control bg-warn-50 px-3 py-2 text-sm text-warn-800">{explanation?.message ?? localExplanation(child)}</p>
        ) : null}
        {refund ? (
          <p className={cn('flex items-center gap-1.5 text-sm font-semibold', child.refundStatus === 'SUCCEEDED' ? 'text-success-800' : child.refundStatus === 'FAILED' ? 'text-danger-700' : 'text-info-800')}>
            {refund} <Price paise={childRefundAmount(child, explanation)} size="sm" tone={child.refundStatus === 'SUCCEEDED' ? 'success' : 'default'} />
          </p>
        ) : null}
        {child.refundStatus === 'FAILED' ? <p className="text-sm text-slate-600">The refund attempt failed and is being retried. Contact support if it doesn&rsquo;t arrive.</p> : null}
        {REFUND_PENDING.has(child.refundStatus) ? <p className="text-xs text-slate-600">Refunds usually reach your account in 5–7 working days.</p> : null}

        {showCode ? (
          <p className="text-sm text-slate-700">
            Delivery code <span className="ml-1 rounded-control bg-slate-900 px-2 py-0.5 font-mono text-base font-bold tracking-[0.3em] text-white">{child.deliveryCode}</span>
            <span className="block text-xs text-slate-600">Share it with the delivery partner only when you receive this order.</span>
          </p>
        ) : null}
        {TRACKABLE.has(child.status) && child.eta.etaMinutes != null && !trackable ? (
          <EtaText minutes={child.eta.etaMinutes} distanceKm={child.eta.distanceKm} source={child.eta.etaSource} />
        ) : null}
        {trackable ? <TrackingMap childId={child.id} drop={order.deliveryAddress?.location ?? null} /> : null}

        <details className="text-sm">
          <summary className="min-h-touch cursor-pointer py-2 font-medium text-slate-800">Items and bill ({child.lines.length})</summary>
          <ul className="mb-2 space-y-1">
            {child.lines.map((l, i) => (
              <li key={`${l.itemId}-${i}`} className="flex items-start justify-between gap-2">
                <span className="flex items-start gap-2">
                  <FoodMarker veg={l.isVeg} size={12} className="mt-1" />
                  <span>
                    {l.quantity} × {l.name}
                    {l.addOns.length ? <span className="block text-xs text-slate-600">{l.addOns.map((a) => a.name).join(', ')}</span> : null}
                  </span>
                </span>
                <Price paise={l.lineTotalPaise} size="sm" />
              </li>
            ))}
          </ul>
          <BreakdownRows b={child.breakdown} totalLabel="Restaurant total" />
        </details>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
        {(child.canCancel ?? child.status === 'PLACED') ? (
          <Button size="sm" variant="danger" onClick={() => setConfirm(true)} aria-label={`Cancel ${child.restaurantName} order`}>
            Cancel this order
          </Button>
        ) : null}
        <ButtonLink to={supportHref} size="sm" variant="ghost" icon="ticket">
          Get help
        </ButtonLink>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Cancel your ${child.restaurantName} order?`}
        description={`The restaurant hasn't accepted it yet, so you'll get a full refund of ${formatINR(child.breakdown.totalPaise)}. Your other restaurants' orders continue.`}
        confirmLabel="Yes, cancel"
        cancelLabel="Keep order"
        tone="danger"
        onConfirm={async () => {
          await cancelChild(child.id);
          await qc.invalidateQueries({ queryKey: orderKey(order.id) });
          void qc.invalidateQueries({ queryKey: ['orders'] });
        }}
      />
    </Card>
  );
}

function changeText(c: ReorderChange): string {
  if (c.message) return c.message;
  if (c.kind === 'PRICE_CHANGED' && c.oldUnitPricePaise != null && c.newUnitPricePaise != null) {
    return `${c.name}: price changed from ${formatINR(c.oldUnitPricePaise)} to ${formatINR(c.newUnitPricePaise)}`;
  }
  return `${c.name} (${c.restaurantName}): ${c.added ? 'added with changes' : 'not added'}`;
}

export function ReorderButton({ checkoutId, size = 'sm' }: { checkoutId: string; size?: 'sm' | 'md' }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [result, setResult] = useState<{ changes: ReorderChange[]; addedCount: number } | null>(null);
  const m = useMutation({
    mutationFn: () => reorder(checkoutId),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: CART_KEY });
      if (res.changes.length) setResult({ changes: res.changes, addedCount: res.addedCount });
      else {
        toast({ title: `Added ${plural(res.addedCount, 'item')} to your cart`, tone: 'success' });
        navigate('/cart');
      }
    },
    onError: (e) => toast({ title: "Couldn't reorder", description: errorMessage(e), tone: 'danger' }),
  });
  return (
    <>
      <Button size={size} variant="secondary" icon="refresh" loading={m.isPending} onClick={() => m.mutate()}>
        Reorder
      </Button>
      <Dialog
        open={result !== null}
        onClose={() => setResult(null)}
        title="Some things changed"
        description={
          result && result.addedCount > 0
            ? `We re-checked prices and availability: ${plural(result.addedCount, 'item')} added to your cart. See what changed below.`
            : 'We re-checked prices and availability. Nothing could be added to your cart right now.'
        }
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="secondary" onClick={() => setResult(null)}>
              Close
            </Button>
            <ButtonLink to="/cart" onClick={() => setResult(null)}>
              Go to cart
            </ButtonLink>
          </div>
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          {(result?.changes ?? []).map((c, i) => (
            <li key={`${c.restaurantId}-${c.itemId}-${i}`}>{changeText(c)}</li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

function TotalsCard({ order, totals: t }: { order: CheckoutView; totals: AdjustedTotals }) {
  const pending = t.refundPendingPaise > 0;
  return (
    <Card as="section" aria-label="Payment summary">
      <h2 className="mb-2 text-lg font-semibold text-slate-900">Payment summary</h2>
      <BreakdownRows b={order.pricing} totalLabel="Order total" />
      <dl className="mt-3 border-t border-slate-200 pt-2">
        <Row label="Paid">
          <Price paise={t.paidPaise} />
        </Row>
        {t.refundedPaise > 0 ? (
          <Row label="Refunded" tone="success">
            −{formatINR(t.refundedPaise)}
          </Row>
        ) : null}
        {t.refundedPaise > 0 || pending ? (
          <Row label="Net paid" strong={!pending}>
            <Price paise={t.netPaise} />
          </Row>
        ) : null}
        {pending ? (
          <>
            <Row label="Refund pending">−{formatINR(t.refundPendingPaise)}</Row>
            <Row label="Net after pending refund" strong>
              <Price paise={t.netPaise - t.refundPendingPaise} />
            </Row>
          </>
        ) : null}
      </dl>
      {order.isDemo ? <p className="mt-2 text-xs text-info-800">Demo order — paid with simulated money.</p> : null}
    </Card>
  );
}

function OrderView({ checkoutId }: { checkoutId: string }) {
  const qc = useQueryClient();
  const order = useQuery({ queryKey: orderKey(checkoutId), queryFn: () => fetchOrder(checkoutId) });
  const { status } = useRealtime<{ checkoutId?: string; childOrderId?: string; lat?: number; lng?: number; at?: string; simulated?: boolean }>(
    ['order.updated', 'delivery.location'],
    (e) => {
      if (e.type === 'delivery.location' && e.data.childOrderId && typeof e.data.lat === 'number' && typeof e.data.lng === 'number') {
        const loc = { lat: e.data.lat, lng: e.data.lng };
        qc.setQueryData<TrackingView>(trackingKey(e.data.childOrderId), (prev) =>
          prev ? { ...prev, location: loc, lastLocationAt: e.data.at ?? new Date().toISOString(), stale: false, simulated: !!e.data.simulated } : prev,
        );
        return;
      }
      if (e.data.checkoutId === checkoutId || order.data?.checkout.children.some((c) => c.id === e.data.childOrderId)) {
        void order.refetch();
        if (e.data.childOrderId) void qc.invalidateQueries({ queryKey: trackingKey(e.data.childOrderId) });
      }
    },
    { fallbackRefetch: order.refetch },
  );

  return (
    <QueryState query={order} loading={<SkeletonList count={2} />} errorTitle="Couldn't load this order">
      {(detail) => {
        const o = detail.checkout;
        const byChild = new Map(detail.explanations.map((x) => [x.childOrderId, x]));
        return (
          <>
            <PageHeader
              title={`Order ${o.code}`}
              back={{ to: '/orders', label: 'Orders' }}
              status={
                <span className="flex flex-wrap items-center gap-2">
                  <StatusPill kind="checkout" status={o.status} />
                  <DemoBadge show={o.isDemo} label="Demo order" />
                </span>
              }
              description={o.placedAt ? `Placed ${formatDateTime(o.placedAt)}` : o.createdAt ? `Created ${formatDateTime(o.createdAt)}` : undefined}
              actions={<ReorderButton checkoutId={o.id} />}
            />
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              {o.children.length > 1 ? (
                <p className="text-sm text-slate-700">
                  <Badge tone="info">{o.children.length} restaurants</Badge> {o.deliveryExplanation ?? 'Each restaurant delivers its part separately.'}
                </p>
              ) : (
                <span />
              )}
              <RealtimeStatus status={status} />
            </div>
            {o.status === 'AWAITING_PAYMENT' ? (
              <Card tone="warn" className="mb-4">
                <p className="text-sm text-warn-800">
                  We&rsquo;re still waiting for payment confirmation.{' '}
                  <Link className="font-semibold underline" to={`/checkout/status/${o.id}`}>
                    View payment status
                  </Link>
                </p>
              </Card>
            ) : null}
            <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
              <div className="space-y-4">
                {o.children.map((c) => (
                  <ChildCard key={c.id} order={o} child={c} explanation={byChild.get(c.id)} />
                ))}
              </div>
              <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
                <TotalsCard order={o} totals={detail.adjustedTotals} />
                {o.deliveryAddress ? (
                  <Card>
                    <h2 className="mb-1 text-sm font-semibold text-slate-900">Delivering to</h2>
                    <p className="text-sm text-slate-700">{[o.deliveryAddress.line1, o.deliveryAddress.line2, o.deliveryAddress.city, o.deliveryAddress.pincode].filter(Boolean).join(', ')}</p>
                  </Card>
                ) : null}
                <ButtonLink to={`/support?checkoutId=${o.id}`} variant="secondary" fullWidth icon="ticket">
                  Help with this order
                </ButtonLink>
              </aside>
            </div>
          </>
        );
      }}
    </QueryState>
  );
}

export default function OrderDetailPage() {
  const { checkoutId = '' } = useParams();
  return (
    <RequireAuth signInMessage="Sign in to see your order.">
      <OrderView checkoutId={checkoutId} />
    </RequireAuth>
  );
}
