/**
 * Order detail (design-spec 20-40, history rows): `GET /owner/orders/:id` — every line with options and notes,
 * totals, prep time, pickup code, partner, reasons, refund state and the status timeline. Read-only.
 */
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, ErrorState, FoodMarker, Price, Skeleton, StatusPill, CodeDigits } from '../../components/ui';
import { formatDateTime, formatTime, plural } from '../../lib/format';
import { ordersApi, type OwnerOrder } from './api';
import { DefRow } from './kit';
import { firstName, maskedPhone, optionText, partnerText } from './orderText';

const STEP_LABEL: Record<string, string> = {
  PLACED: 'Placed',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY_FOR_PICKUP: 'Ready for pickup',
  PICKED_UP: 'Picked up',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  DELIVERY_FAILED: 'Delivery failed',
  EXPIRED: 'Expired',
};

function Body({ o }: { o: OwnerOrder }) {
  const b = o.breakdown;
  const items = o.lines.reduce((n, l) => n + l.quantity, 0);
  const accepted = o.status === 'ACCEPTED' || o.status === 'PREPARING' || o.status === 'READY_FOR_PICKUP';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill kind="childOrder" status={o.status} />
        {o.refundStatus && o.refundStatus !== 'NONE' ? <StatusPill kind="childRefund" status={o.refundStatus} /> : null}
        {o.deliveryStatus ? <StatusPill kind="delivery" status={o.deliveryStatus} /> : null}
      </div>
      <dl className="flex flex-col gap-1.5">
        <DefRow label="Customer">
          {firstName(o.customer?.name) || 'Customer'}
          {o.customer?.phoneMasked ? <span className="ml-1.5 font-mono text-[13px] text-fg-3">{maskedPhone(o.customer.phoneMasked)}</span> : null}
        </DefRow>
        {o.prepMinutes ? <DefRow label="Prep time">{o.prepMinutes} min{o.readyEta ? ` · ready by ${formatTime(o.readyEta)}` : ''}</DefRow> : null}
        {o.deliveryStatus || o.partner ? <DefRow label="Delivery partner">{partnerText(o)}</DefRow> : null}
      </dl>

      <section aria-label="Items" className="flex flex-col gap-2 border-t border-line pt-3">
        <p className="lbl">{plural(items, 'item')}</p>
        <ul className="flex flex-col gap-2.5">
          {o.lines.map((l, i) => (
            <li key={`${l.itemId ?? l.name}-${i}`} className="flex items-start gap-2.5 text-[14.5px]">
              <span className="min-w-6 font-mono font-semibold">{l.quantity}×</span>
              {typeof l.isVeg === 'boolean' ? <FoodMarker veg={l.isVeg} size={13} className="mt-1" /> : null}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-fg">{l.name}</span>
                {optionText(l) ? <span className="text-[12.5px] text-fg-3">{optionText(l)}</span> : null}
                {l.note ? <span className="text-[12.5px] text-warn">Note: {l.note}</span> : null}
              </span>
              {typeof l.lineTotalPaise === 'number' ? <Price paise={l.lineTotalPaise} size="sm" tone="muted" /> : null}
            </li>
          ))}
        </ul>
      </section>

      {b ? (
        <dl className="flex flex-col gap-1.5 border-t border-line pt-3">
          {typeof b.itemsSubtotalPaise === 'number' ? <DefRow label="Items"><Price paise={b.itemsSubtotalPaise} size="sm" /></DefRow> : null}
          {b.packagingFeePaise ? <DefRow label="Packaging"><Price paise={b.packagingFeePaise} size="sm" /></DefRow> : null}
          <DefRow label="Customer paid for this order" className="font-medium">
            <Price paise={b.totalPaise} size="sm" />
          </DefRow>
        </dl>
      ) : null}

      {o.rejectionReason ? <p className="rounded-item bg-bad-bg px-3 py-2 text-[13px] text-bad">Rejection reason: {o.rejectionReason}</p> : null}
      {o.cancellationReason ? <p className="rounded-item bg-fill px-3 py-2 text-[13px] text-fg-2">Cancellation reason: {o.cancellationReason}</p> : null}

      {accepted && o.pickupCode ? (
        <div className="flex flex-col items-center gap-2.5 rounded-control border border-line bg-bg-2 p-3.5">
          <span className="text-[12.5px] text-fg-3">Pickup code &mdash; give this code to the rider</span>
          <CodeDigits code={o.pickupCode} label="Pickup code" size="lg" />
        </div>
      ) : null}

      {o.statusHistory?.length ? (
        <section aria-label="Timeline" className="flex flex-col gap-2 border-t border-line pt-3">
          <p className="lbl">Timeline</p>
          <ol className="flex flex-col gap-1.5">
            {o.statusHistory.map((h, i) => (
              <li key={i} className="flex items-baseline gap-3 text-[13.5px]">
                <span className="w-[86px] shrink-0 font-mono text-xs text-fg-3">{h.at ? formatTime(h.at) : '—'}</span>
                <span className="text-fg">
                  {STEP_LABEL[h.to] ?? h.to}
                  {h.reason ? <span className="text-fg-3"> · {h.reason}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

export function OrderDetailDialog({ order, onClose }: { order: OwnerOrder | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['owner', 'order', order?.id ?? ''],
    queryFn: () => ordersApi.get(order!.id),
    enabled: Boolean(order),
    placeholderData: order ?? undefined,
  });
  if (!order) return null;
  const o = q.data ?? order;
  return (
    <Dialog
      open
      onClose={onClose}
      title={<span className="font-mono">{o.code}</span>}
      description={o.placedAt ? `Placed ${formatDateTime(o.placedAt)}` : undefined}
      footer={<Button variant="outline" onClick={onClose}>Close</Button>}
    >
      {q.isError && !q.data ? (
        <ErrorState compact error={q.error} title="Couldn't load this order" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.data ? (
        <Body o={o} />
      ) : (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
    </Dialog>
  );
}
