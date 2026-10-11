/**
 * Order tracking (board 13, design-spec §5.13; PRD C-10/C-11/C-12): `GET /orders/:checkoutId`, one card per
 * restaurant (child order):
 *   headline by status ("On the way — about 9 min" from DLV-3 `remaining`, else the static child ETA; source line)
 *   · status pill · map (restaurant point ORD-4, rider, drop; SIMULATED tag) · 7-step timeline with IST times ·
 *   rider row ("Ravi · Scooter", "Location updated 3s ago") · delivery code boxes · Cancel (only `canCancel`) ·
 *   rejected/cancelled explanation + refund progress (Initiated → Processing → Refunded) + struck items.
 * Aside: payment card (Paid / Refunded / Refund pending / Net paid / Net after pending refund), delivering to,
 * Get help (→ support ticket prefilled), Reorder (changes dialog → Go to cart), rate each delivered part once
 * (MKT-14 `ratings/mine` decides "Rate" vs "You rated 4 ★"). Live via `order.updated` / `delivery.location` SSE
 * with 10 s polling fallback.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Avatar,
  Button,
  ButtonLink,
  CodeDigits,
  ConfirmDialog,
  Dialog,
  ErrorState,
  ExplanationBox,
  InfoNotice,
  Lbl,
  LiveIndicator,
  ORDER_STEPS,
  REFUND_STEPS,
  RelativeTime,
  Skeleton,
  SkeletonCard,
  StatusPill,
  Stepper,
  useToast,
  VegMark,
} from '../../components/ui';
import { RequireAuth } from '../../components/layout/RequireRole';
import { humanize } from '../../components/ui/StatusPill';
import { useRealtime } from '../../hooks/useRealtime';
import { useNow } from '../../hooks/useNow';
import { errorMessage, isApiError } from '../../lib/errors';
import { formatINR, plural } from '../../lib/format';
import { cn } from '../../lib/cn';
import {
  cancelChild,
  CART_KEY,
  fetchMyRatings,
  fetchOrder,
  isDemoEstimate,
  rateRestaurant,
  reorder,
  type AdjustedTotals,
  type CheckoutView,
  type ChildOrder,
  type MyRating,
  type OrderExplanation,
  type ReorderChange,
  type TrackingView,
} from './api';
import { PageContainer } from './ConsumerLayout';
import { Accent, BillList, istTime, relativeDay } from './parts';
import { TrackingMap, trackingKey, useTracking } from './TrackingMap';

export const orderKey = (checkoutId: string) => ['order', checkoutId] as const;
const ACTIVE = new Set(['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY']);
const TERMINAL_BAD = new Set(['REJECTED', 'CANCELLED', 'DELIVERY_FAILED', 'EXPIRED', 'PAYMENT_FAILED']);
const RIDER_STATUSES = new Set(['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY']);
const STEP_STATUS = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED'];
const rupees = (p: number) => formatINR(p);

/**
 * Refund amount still to show for this part: refunded total once SUCCEEDED; while pending, what is still on its
 * way (requested − already refunded, i.e. the remaining part of a partial refund), else the full request.
 * `requested` = the explanation's `refundPaise` (server), else the child's `refundRequestedPaise`.
 */
export function childRefundAmount(c: ChildOrder, explanation?: OrderExplanation): number {
  const requested = explanation?.refundPaise ?? c.refundRequestedPaise ?? 0;
  if (c.refundStatus === 'SUCCEEDED') return c.refundedPaise || requested;
  return Math.max(0, requested - (c.refundedPaise ?? 0)) || requested;
}

function riderAssigned(c: ChildOrder): boolean {
  return (c.deliveryStatus != null && RIDER_STATUSES.has(c.deliveryStatus)) || c.status === 'PICKED_UP' || c.status === 'OUT_FOR_DELIVERY';
}

/** Step times from the status history (first time each status was reached). */
function stepTimes(c: ChildOrder): (string | undefined)[] {
  const at = new Map<string, string>();
  for (const h of c.statusHistory ?? []) if (h.at && !at.has(h.to)) at.set(h.to, h.at);
  if (c.placedAt && !at.has('PLACED')) at.set('PLACED', c.placedAt);
  return STEP_STATUS.map((s) => (at.get(s) ? istTime(at.get(s)!).replace(/ (AM|PM)$/, '') : undefined));
}

function Headline({ child, tracking, now }: { child: ChildOrder; tracking?: TrackingView; now: number }) {
  const R = child.restaurantName;
  const h = (text: React.ReactNode, accent?: React.ReactNode) => (
    <p className="text-[26px] font-semibold leading-[1.1] tracking-[-0.03em] max-sm:text-[22px]">
      {text}
      {accent ? <Accent>{accent}</Accent> : null}
    </p>
  );
  switch (child.status) {
    case 'AWAITING_PAYMENT':
      return h('Waiting for payment');
    case 'PLACED':
      return h(`Waiting for ${R} to accept`);
    case 'ACCEPTED':
    case 'PREPARING': {
      const mins = child.readyEta ? Math.max(1, Math.round((Date.parse(child.readyEta) - now) / 60000)) : child.prepMinutes;
      return mins ? h('Being prepared — ', `ready in about ${mins} min`) : h('Being prepared');
    }
    case 'READY_FOR_PICKUP':
      return h('Ready — waiting for pickup');
    case 'PICKED_UP':
    case 'OUT_FOR_DELIVERY': {
      const mins = tracking?.remaining?.minutes ?? child.eta.etaMinutes;
      return mins != null ? h('On the way — ', `about ${mins} min`) : h('On the way');
    }
    case 'DELIVERED': {
      const at = child.deliveredAt ?? child.statusHistory?.find((x) => x.to === 'DELIVERED')?.at;
      return h(at ? `Delivered at ${istTime(at)}` : 'Delivered');
    }
    case 'REJECTED':
      return <p className="text-[22px] font-semibold leading-[1.15] tracking-[-0.025em]">Couldn&rsquo;t be prepared</p>;
    case 'CANCELLED':
      return <p className="text-[22px] font-semibold leading-[1.15] tracking-[-0.025em]">Cancelled</p>;
    case 'DELIVERY_FAILED':
      return <p className="text-[22px] font-semibold leading-[1.15] tracking-[-0.025em]">Delivery failed</p>;
    case 'EXPIRED':
      return <p className="text-[22px] font-semibold leading-[1.15] tracking-[-0.025em]">Expired</p>;
    default:
      return h(humanize(child.status));
  }
}

function etaSourceLine(child: ChildOrder, tracking?: TrackingView): string | null {
  if (child.status === 'PICKED_UP' || child.status === 'OUT_FOR_DELIVERY') {
    const src = tracking?.remaining?.source ?? tracking?.estimateSource ?? child.eta.etaSource;
    return isDemoEstimate(src) ? 'Arrival time is a demo estimate' : 'Arrival time is an estimate';
  }
  if (child.status === 'ACCEPTED' || child.status === 'PREPARING') return 'Ready time is the restaurant’s estimate';
  if (child.deliveryStatus === 'AT_PICKUP') return 'Your rider is at the restaurant';
  return null;
}

function RefundProgress({ child, amount }: { child: ChildOrder; amount: number }) {
  const failed = child.refundStatus === 'FAILED';
  const current = child.refundStatus === 'SUCCEEDED' ? 3 : 1;
  return (
    <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-2.5">
      <span className="text-[13px] font-medium">
        Refund {rupees(amount)}
        {child.refundStatus !== 'SUCCEEDED' && (child.refundedPaise ?? 0) > 0 ? <span className="font-normal text-fg-3"> still to come · {rupees(child.refundedPaise)} already refunded</span> : null}
      </span>
      <Stepper
        label={`Refund ${rupees(amount)}`}
        tone="refund"
        steps={REFUND_STEPS}
        current={current}
        responsive={false}
        terminal={failed ? { label: 'Refund failed — we’re retrying', tone: 'bad' } : undefined}
      />
      {child.refundStatus === 'REQUESTED' || child.refundStatus === 'PROCESSING' ? <p className="text-xs text-fg-3">Refunds usually reach your account in 5–7 working days.</p> : null}
    </div>
  );
}

function ChildCard({ order, child, n, explanation, otherActive }: { order: CheckoutView; child: ChildOrder; n: number; explanation: OrderExplanation | undefined; otherActive: string | null }) {
  const qc = useQueryClient();
  const now = useNow(30_000);
  const [confirm, setConfirm] = useState(false);
  const withRider = riderAssigned(child) && child.status !== 'DELIVERED' && !TERMINAL_BAD.has(child.status);
  const tracking = useTracking(child.id, withRider);
  const t = tracking.data;
  const terminal = TERMINAL_BAD.has(child.status);
  const refunding = child.refundStatus && child.refundStatus !== 'NONE';
  const riderName = t?.partner?.firstName ?? child.partner?.name ?? null;
  const vehicle = t?.partner?.vehicleType ?? child.partner?.vehicleType ?? null;
  const sourceLine = etaSourceLine(child, t);
  const showMap = withRider && (child.status === 'PICKED_UP' || child.status === 'OUT_FOR_DELIVERY' || !!t?.location);
  const showCode = withRider;
  const times = stepTimes(child);
  const stepIdx = child.status === 'DELIVERED' ? STEP_STATUS.length : Math.max(0, STEP_STATUS.indexOf(child.status));
  const explanationText =
    explanation?.message ??
    (child.status === 'EXPIRED' ? 'Payment was not completed in time, so this part was not placed. You were not charged.' : child.status === 'PAYMENT_FAILED' ? 'Payment failed, so this part was not placed.' : null);

  return (
    <article aria-label={`Delivery ${n} · ${child.restaurantName}`} className="animate-rise overflow-hidden rounded-card border border-line bg-card" style={{ animationDelay: `${(n - 1) * 0.1}s` }}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-[18px]">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Lbl>
            Delivery {n} · {child.restaurantName}
          </Lbl>
          <Headline child={child} tracking={t} now={now} />
          {sourceLine ? <span className="text-[13px] text-fg-3">{sourceLine}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {child.canCancel ? (
            <Button variant="danger-outline" size="xs" onClick={() => setConfirm(true)} aria-label={`Cancel ${child.restaurantName} order`}>
              Cancel order
            </Button>
          ) : null}
          <StatusPill kind="childOrder" status={child.status} />
          {child.deliveryStatus === 'AT_PICKUP' && !terminal ? <StatusPill kind="delivery" status="AT_PICKUP" /> : null}
        </div>
      </div>

      {showMap ? (
        <TrackingMap tracking={t} restaurant={child.restaurant?.location ?? null} drop={order.deliveryAddress?.location ?? null} restaurantName={child.restaurantName} />
      ) : null}

      {!terminal ? (
        <div className={cn('px-5 py-[18px]', (showMap || withRider) && 'border-b border-line', !showMap && 'border-t border-line')}>
          <Stepper label={`${child.restaurantName} order progress`} steps={ORDER_STEPS.map((label, i) => ({ label, time: times[i] }))} current={stepIdx} showTimes />
        </div>
      ) : null}

      {withRider ? (
        <div className="flex flex-wrap items-center justify-between gap-5 px-5 py-4 max-sm:flex-col max-sm:items-stretch">
          <div className="flex items-center gap-3">
            <Avatar name={riderName ?? '?'} size={40} />
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] font-medium">{riderName ? `${riderName}${vehicle ? ` · ${humanize(vehicle)}` : ''}` : 'Rider assigned'}</span>
              <span className="text-[13px] text-fg-3" aria-live="polite">
                {t?.lastLocationAt ? (
                  <>
                    Location <RelativeTime value={t.lastLocationAt} prefix="updated" />
                  </>
                ) : child.deliveryStatus === 'AT_PICKUP' ? (
                  'At the restaurant'
                ) : tracking.isError ? (
                  'Live location isn’t available right now'
                ) : (
                  'Live location appears once they start moving'
                )}
              </span>
            </span>
          </div>
          {showCode ? (
            <div className="flex items-center gap-3.5 max-sm:justify-between">
              <span className="flex flex-col gap-0.5 text-right max-sm:text-left">
                <span className="text-sm font-medium">Delivery code</span>
                <span className="text-[12.5px] text-fg-3">Tell {riderName ?? 'your rider'} at the door</span>
              </span>
              <CodeDigits code={child.deliveryCode} label="Delivery code" />
            </div>
          ) : null}
        </div>
      ) : null}

      {terminal ? (
        <>
          {explanationText ? (
            <ExplanationBox className="mx-5" title={explanationText}>
              {otherActive ? `Your ${otherActive} order isn’t affected and is still on its way.` : undefined}
            </ExplanationBox>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-6 px-5 py-[18px]">
            {refunding ? <RefundProgress child={child} amount={childRefundAmount(child, explanation)} /> : null}
            <ul className="flex flex-col gap-1.5" aria-label="Items not delivered">
              {child.lines.map((l, i) => (
                <li key={`${l.itemId}-${i}`} className="flex items-center gap-2.5 text-sm text-fg-3">
                  <VegMark veg={l.isVeg} size={13} />
                  <s>
                    {l.quantity} × {l.name} · {formatINR(l.lineTotalPaise).replace(/\.00$/, '')}
                  </s>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      <details className="border-t border-line px-5 text-sm">
        <summary className="flex min-h-11 cursor-pointer items-center text-[13.5px] font-medium text-fg-2">
          Items and bill · {plural(child.lines.reduce((s, l) => s + l.quantity, 0), 'item')} · <span className="ml-1 font-mono text-xs text-fg-3">{child.code}</span>
        </summary>
        <ul className="mb-3 flex flex-col gap-1.5">
          {child.lines.map((l, i) => (
            <li key={`${l.itemId}-${i}`} className="flex items-start justify-between gap-2">
              <span className="flex items-start gap-2">
                <VegMark veg={l.isVeg} size={12} className="mt-1" />
                <span>
                  {l.quantity} × {l.name}
                  {l.addOns.length ? <span className="block text-xs text-fg-3">{l.addOns.map((a) => a.name).join(', ')}</span> : null}
                </span>
              </span>
              <span className="tabular-nums">{formatINR(l.lineTotalPaise)}</span>
            </li>
          ))}
        </ul>
        <BillList b={child.breakdown} totalLabel="Restaurant total" className="mb-4" />
      </details>

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
    </article>
  );
}

function changeText(c: ReorderChange): string {
  if (c.message) return c.message;
  if (c.kind === 'PRICE_CHANGED' && c.oldUnitPricePaise != null && c.newUnitPricePaise != null) {
    return `${c.name}: price changed from ${formatINR(c.oldUnitPricePaise)} to ${formatINR(c.newUnitPricePaise)}`;
  }
  return `${c.name} (${c.restaurantName}): ${c.added ? 'added with changes' : 'not added'}`;
}

export function ReorderButton({ checkoutId, size = 'sm', className, block }: { checkoutId: string; size?: 'sm' | 'md'; className?: string; block?: boolean }) {
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
      <Button size={block ? 'md' : size} variant="outline" icon={block ? undefined : 'refresh'} loading={m.isPending} onClick={() => m.mutate()} className={cn(block && 'h-11 w-full', className)}>
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
            <Button variant="outline" onClick={() => setResult(null)}>
              Close
            </Button>
            <ButtonLink to="/cart" onClick={() => setResult(null)}>
              Go to cart
            </ButtonLink>
          </div>
        }
      >
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-fg-2">
          {(result?.changes ?? []).map((c, i) => (
            <li key={`${c.restaurantId}-${c.itemId}-${i}`}>{changeText(c)}</li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

function PaymentCard({ order, totals: t }: { order: CheckoutView; totals: AdjustedTotals }) {
  const pending = t.refundPendingPaise > 0;
  const row = (label: string, value: React.ReactNode, cls?: string) => (
    <div className="flex justify-between gap-3 text-[14px]">
      <dt className="text-fg-3">{label}</dt>
      <dd className={cn('tabular-nums', cls)}>{value}</dd>
    </div>
  );
  return (
    <section aria-label="Payment" className="flex flex-col gap-3 rounded-card border border-line bg-card px-5 py-[18px]">
      <h2 className="font-sans text-[15px] font-semibold tracking-normal">Payment</h2>
      <dl className="flex flex-col gap-3">
        {row('Paid', rupees(t.paidPaise))}
        {row('Refunded', t.refundedPaise > 0 ? `−${rupees(t.refundedPaise)}` : rupees(0), t.refundedPaise > 0 ? 'text-ok' : undefined)}
        {pending ? row('Refund pending', `−${rupees(t.refundPendingPaise)}`, 'text-info') : null}
        <div className="h-px bg-line" />
        {pending ? (
          <>
            {row('Net paid', rupees(t.netPaise))}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="font-medium">Net after pending refund</dt>
              <dd className="text-[22px] font-semibold tracking-[-0.02em] tabular-nums">{rupees(t.netPaise - t.refundPendingPaise)}</dd>
            </div>
          </>
        ) : (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="font-medium">Net paid</dt>
            <dd className="text-[22px] font-semibold tracking-[-0.02em] tabular-nums">{rupees(t.netPaise)}</dd>
          </div>
        )}
      </dl>
      {order.isDemo ? <p className="text-xs text-info">Demo order — paid with simulated money.</p> : null}
    </section>
  );
}

function RateChild({ child, rated, onRated }: { child: ChildOrder; rated: MyRating | undefined; onRated: (stars: number) => void }) {
  const { toast } = useToast();
  const [hover, setHover] = useState(0);
  const rate = useMutation({
    mutationFn: (stars: number) => rateRestaurant(child.restaurantId, child.id, stars),
    onSuccess: (_r, stars) => {
      onRated(stars);
      toast({ title: `Thanks — you rated ${child.restaurantName} ${stars} ★`, tone: 'success' });
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 409) onRated(0);
      else toast({ title: "Couldn't save your rating", description: errorMessage(e), tone: 'danger' });
    },
  });
  if (rated) {
    return (
      <p className="text-[13px] text-fg-2">
        You rated {child.restaurantName} {rated.stars > 0 ? `${rated.stars} ★` : 'already'}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">Rate {child.restaurantName}</span>
      <div role="group" aria-label={`Rate ${child.restaurantName}`} className="flex gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((s) => (
          <button
            key={s}
            type="button"
            aria-label={`Rate ${s} of 5`}
            disabled={rate.isPending}
            onMouseEnter={() => setHover(s)}
            onFocus={() => setHover(s)}
            onClick={() => rate.mutate(s)}
            className={cn('grid size-9 place-items-center rounded-item text-2xl leading-none transition-colors hover:bg-fill [@media(pointer:coarse)]:size-touch', s <= hover ? 'text-sun-ink' : 'text-line-2')}
          >
            ★
          </button>
        ))}
      </div>
    </div>
  );
}

function RatingsAside({ order }: { order: CheckoutView }) {
  const delivered = order.children.filter((c) => c.status === 'DELIVERED');
  const pendingDelivery = order.children.filter((c) => ACTIVE.has(c.status));
  const ids = delivered.map((c) => c.id);
  const [local, setLocal] = useState<Record<string, number>>({});
  const mine = useQuery({ queryKey: ['ratings', 'mine', ids.join(',')], queryFn: () => fetchMyRatings(ids), enabled: ids.length > 0, retry: false });
  const byChild = new Map((mine.data ?? []).map((r) => [r.childOrderId, r]));
  return (
    <div className="flex flex-col gap-3">
      {delivered.map((c) =>
        mine.isPending ? (
          <Skeleton key={c.id} className="h-12 w-full" />
        ) : (
          <RateChild
            key={c.id}
            child={c}
            rated={local[c.id] !== undefined ? { childOrderId: c.id, restaurantId: c.restaurantId, stars: local[c.id]!, createdAt: null } : byChild.get(c.id)}
            onRated={(stars) => setLocal((m) => ({ ...m, [c.id]: stars }))}
          />
        ),
      )}
      {pendingDelivery.map((c) => (
        <p key={c.id} className="text-[12.5px] leading-normal text-fg-3">
          You can rate {c.restaurantName} once it&rsquo;s delivered.
        </p>
      ))}
    </div>
  );
}

function OrderView({ checkoutId }: { checkoutId: string }) {
  const qc = useQueryClient();
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const order = useQuery({ queryKey: orderKey(checkoutId), queryFn: () => fetchOrder(checkoutId) });
  const { status } = useRealtime<{ checkoutId?: string; childOrderId?: string; lat?: number; lng?: number; at?: string; simulated?: boolean; remainingMinutes?: number | null }>(
    ['order.updated', 'delivery.location'],
    (e) => {
      if (e.type === 'delivery.location' && e.data.childOrderId && typeof e.data.lat === 'number' && typeof e.data.lng === 'number') {
        const loc = { lat: e.data.lat, lng: e.data.lng };
        const rm = e.data.remainingMinutes;
        qc.setQueryData<TrackingView>(trackingKey(e.data.childOrderId), (prev) =>
          prev
            ? {
                ...prev,
                location: loc,
                lastLocationAt: e.data.at ?? new Date().toISOString(),
                stale: false,
                simulated: !!e.data.simulated,
                remaining: typeof rm === 'number' ? { minutes: rm, distanceKm: prev.remaining?.distanceKm ?? 0, source: prev.remaining?.source ?? prev.estimateSource, computedAt: new Date().toISOString() } : prev.remaining,
              }
            : prev,
        );
        setLastEventAt(Date.now());
        return;
      }
      if (e.data.checkoutId === checkoutId || order.data?.checkout.children.some((c) => c.id === e.data.childOrderId)) {
        setLastEventAt(Date.now());
        void order.refetch();
        if (e.data.childOrderId) void qc.invalidateQueries({ queryKey: trackingKey(e.data.childOrderId) });
      }
    },
    { fallbackRefetch: order.refetch },
  );

  if (order.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-6">
        <span className="sr-only">Loading your order…</span>
        <Skeleton className="h-9 w-64" />
        <div className="flex flex-wrap gap-5">
          <div className="flex flex-[999_1_560px] flex-col gap-4">
            <SkeletonCard />
            <SkeletonCard />
          </div>
          <div className="flex-[1_1_320px]">
            <SkeletonCard />
          </div>
        </div>
      </div>
    );
  }
  if (order.isError) return <ErrorState error={order.error} title="Couldn't load this order" onRetry={() => void order.refetch()} retrying={order.isFetching} />;

  const detail = order.data;
  const o = detail.checkout;
  const byChild = new Map(detail.explanations.map((x) => [x.childOrderId, x]));
  const a = o.deliveryAddress;
  const when = o.placedAt ?? o.createdAt;
  const meta = [when ? `Placed ${relativeDay(when)}` : null, plural(o.children.length, 'restaurant'), a ? [a.label, a.locality ?? a.line2 ?? a.city].filter(Boolean).join(', ') : null].filter(Boolean).join(' · ');
  const activeName = (exclude: string) => o.children.find((c) => c.id !== exclude && ACTIVE.has(c.status))?.restaurantName ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2.5">
          <nav aria-label="Breadcrumb" className="flex gap-1.5 text-[13px] text-fg-3">
            <Link to="/orders" className="hover:text-fg">
              Orders
            </Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page" className="font-mono">
              {o.code}
            </span>
          </nav>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-[30px] font-medium tracking-[-0.02em] max-sm:text-2xl">{o.code}</h1>
            <StatusPill kind="checkout" status={o.status} />
          </div>
          <span className="text-sm text-fg-3">{meta}</span>
        </div>
        <LiveIndicator status={status} updatedAt={lastEventAt ?? order.dataUpdatedAt} />
      </div>

      {o.status === 'AWAITING_PAYMENT' ? (
        <InfoNotice tone="warn" icon="clock">
          <span>
            We&rsquo;re still waiting for payment confirmation.{' '}
            <Link className="font-semibold underline" to={`/checkout/status/${o.id}`}>
              View payment status
            </Link>
          </span>
        </InfoNotice>
      ) : null}

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
          {o.children.map((c, i) => (
            <ChildCard key={c.id} order={o} child={c} n={i + 1} explanation={byChild.get(c.id)} otherActive={activeName(c.id)} />
          ))}
        </div>
        <aside className="flex w-full max-w-[380px] flex-[1_1_320px] flex-col gap-4 max-lg:max-w-none">
          <PaymentCard order={o} totals={detail.adjustedTotals} />
          {a ? (
            <section aria-label="Delivering to" className="flex flex-col gap-2 rounded-card border border-line bg-card px-5 py-[18px]">
              <Lbl>Delivering to</Lbl>
              <span className="text-[14.5px] font-medium">{a.label || 'Delivery address'}</span>
              <span className="text-[13.5px] leading-normal text-fg-3">
                {[a.line1, a.line2, a.locality, a.city].filter(Boolean).join(', ')} {a.pincode}
                {a.landmark ? ` · near ${a.landmark}` : ''}
              </span>
            </section>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <ButtonLink to={`/support?new=1&orderId=${o.id}`} variant="outline" className="h-11 w-full">
              Get help
            </ButtonLink>
            <ReorderButton checkoutId={o.id} block />
          </div>
          <RatingsAside order={o} />
        </aside>
      </div>
    </div>
  );
}

export default function OrderDetailPage() {
  const { checkoutId = '' } = useParams();
  return (
    <PageContainer>
      <RequireAuth signInMessage="Sign in to see your order.">
        <OrderView checkoutId={checkoutId} />
      </RequireAuth>
    </PageContainer>
  );
}
