/**
 * Status chip with a human label and consistent tone for every lifecycle enum in @thali/contracts
 * (plus membership, notification, offer, user and health statuses used by the API).
 *
 *   <StatusPill kind="childOrder" status={order.status} />
 *   <StatusPill kind="refund" status="REQUESTED" />            -> "Refund initiated"
 *   statusLabel('delivery', 'OUT_FOR_DELIVERY')                 -> "On the way"
 *
 * Tones per design-spec §3.9 (delivery Picked up / On the way → info, Awaiting approval → info, health "Up").
 * Unknown values (a newer server) render humanized ("SOMETHING_NEW" -> "Something new") in neutral tone.
 * Wrap a pill whose value changes live in an aria-live region if the change matters (e.g. order tracking).
 */
import type {
  CheckoutStatus,
  ChildOrderStatus,
  ChildRefundStatus,
  DeliveryStatus,
  NotificationStatus,
  OfferStatus,
  PartnerStatus,
  PaymentStatus,
  PayoutStatus,
  RefundStatus,
  RestaurantStatus,
  TicketStatus,
} from '@thali/contracts';
import { Badge, type Density, type Tone } from './Badge';

type Entry = readonly [label: string, tone: Tone];

const childOrder: Record<ChildOrderStatus, Entry> = {
  AWAITING_PAYMENT: ['Awaiting payment', 'warn'],
  PLACED: ['Placed', 'info'],
  ACCEPTED: ['Accepted', 'brand'],
  PREPARING: ['Preparing', 'brand'],
  READY_FOR_PICKUP: ['Ready for pickup', 'brand'],
  PICKED_UP: ['Picked up', 'info'],
  OUT_FOR_DELIVERY: ['Out for delivery', 'info'],
  DELIVERED: ['Delivered', 'success'],
  DELIVERY_FAILED: ['Delivery failed', 'danger'],
  PAYMENT_FAILED: ['Payment failed', 'danger'],
  EXPIRED: ['Expired', 'neutral'],
  REJECTED: ['Rejected by restaurant', 'danger'],
  CANCELLED: ['Cancelled', 'neutral'],
};

const checkout: Record<CheckoutStatus, Entry> = {
  AWAITING_PAYMENT: ['Awaiting payment', 'warn'],
  PAID_PLACED: ['Order placed', 'info'],
  IN_PROGRESS: ['In progress', 'brand'],
  COMPLETED: ['Completed', 'success'],
  PARTIALLY_COMPLETED: ['Partially completed', 'warn'],
  CANCELLED: ['Cancelled', 'neutral'],
  PAYMENT_FAILED: ['Payment failed', 'danger'],
  EXPIRED: ['Expired', 'neutral'],
};

const payment: Record<PaymentStatus, Entry> = {
  CREATED: ['Pending', 'warn'],
  AUTHORIZED: ['Authorized', 'info'],
  CAPTURED: ['Paid', 'success'],
  FAILED: ['Failed', 'danger'],
  PARTIALLY_REFUNDED: ['Partially refunded', 'info'],
  REFUNDED: ['Refunded', 'neutral'],
};

const refund: Record<RefundStatus, Entry> = {
  REQUESTED: ['Refund initiated', 'info'],
  PROCESSING: ['Refund processing', 'info'],
  SUCCEEDED: ['Refunded', 'success'],
  FAILED: ['Refund failed', 'danger'],
};

const childRefund: Record<ChildRefundStatus, Entry> = { NONE: ['No refund', 'neutral'], ...refund };

const delivery: Record<DeliveryStatus, Entry> = {
  PENDING_ASSIGNMENT: ['Finding a partner', 'warn'],
  OFFERED: ['Offered to partner', 'warn'],
  ASSIGNED: ['Partner assigned', 'info'],
  AT_PICKUP: ['At restaurant', 'info'],
  PICKED_UP: ['Picked up', 'info'],
  OUT_FOR_DELIVERY: ['On the way', 'info'],
  DELIVERED: ['Delivered', 'success'],
  FAILED: ['Delivery failed', 'danger'],
  CANCELLED: ['Cancelled', 'neutral'],
};

const restaurant: Record<RestaurantStatus, Entry> = {
  DRAFT: ['Draft', 'neutral'],
  VERIFICATION_PENDING: ['Email verification pending', 'warn'],
  APPROVAL_PENDING: ['Awaiting approval', 'info'],
  APPROVED: ['Approved', 'success'],
  REJECTED: ['Rejected', 'danger'],
  SUSPENDED: ['Suspended', 'danger'],
};

const partner: Record<PartnerStatus, Entry> = {
  DRAFT: ['Draft', 'neutral'],
  APPROVAL_PENDING: ['Awaiting approval', 'info'],
  APPROVED: ['Approved', 'success'],
  REJECTED: ['Rejected', 'danger'],
  SUSPENDED: ['Suspended', 'danger'],
};

const ticket: Record<TicketStatus, Entry> = {
  OPEN: ['Open', 'warn'],
  IN_PROGRESS: ['In progress', 'info'],
  RESOLVED: ['Resolved', 'success'],
  CLOSED: ['Closed', 'neutral'],
};

const payout: Record<PayoutStatus, Entry> = {
  REQUESTED: ['Requested', 'warn'],
  PROCESSING: ['Processing', 'info'],
  PAID: ['Paid', 'success'],
  FAILED: ['Failed', 'danger'],
  CANCELLED: ['Cancelled', 'neutral'],
};

const offer: Record<OfferStatus, Entry> = {
  OFFERED: ['New offer', 'brand'],
  ACCEPTED: ['Accepted', 'success'],
  REJECTED: ['Declined', 'neutral'],
  EXPIRED: ['Expired', 'neutral'],
  CANCELLED: ['Withdrawn', 'neutral'],
};

const notification: Record<NotificationStatus, Entry> = {
  QUEUED: ['Queued', 'neutral'],
  SENDING: ['Sending', 'info'],
  SENT: ['Sent', 'success'],
  DELIVERED: ['Delivered', 'success'],
  FAILED: ['Failed, retrying', 'warn'],
  DEAD: ['Gave up', 'danger'],
  SKIPPED: ['Skipped', 'neutral'],
};

/** LLD §3.2 memberships.status (not an exported contracts enum). */
const membership: Record<string, Entry> = {
  PENDING_PAYMENT: ['Awaiting payment', 'warn'],
  ACTIVE: ['Active', 'success'],
  EXPIRED: ['Expired', 'neutral'],
  CANCELLED: ['Cancelled', 'neutral'],
};

/** LLD §3.1 users.status. */
const user: Record<string, Entry> = {
  ACTIVE: ['Active', 'success'],
  BLOCKED: ['Blocked', 'danger'],
};

/** Admin health (gateway /admin/health per-service status). */
const health: Record<string, Entry> = {
  up: ['Up', 'success'],
  ok: ['Up', 'success'],
  degraded: ['Degraded', 'warn'],
  down: ['Down', 'danger'],
};

export const STATUS_MAPS = {
  childOrder, checkout, payment, refund, childRefund, delivery, restaurant, partner, ticket, payout, offer, notification,
  membership, user, health,
} as const satisfies Record<string, Record<string, Entry>>;

export type StatusKind = keyof typeof STATUS_MAPS;

/** "SOMETHING_NEW" -> "Something new". */
export function humanize(value: string): string {
  const s = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : value;
}

function entry(kind: StatusKind, status: string): Entry {
  return (STATUS_MAPS[kind] as Record<string, Entry>)[status] ?? [humanize(status), 'neutral'];
}

export function statusLabel(kind: StatusKind, status: string): string {
  return entry(kind, status)[0];
}

export function statusTone(kind: StatusKind, status: string): Tone {
  return entry(kind, status)[1];
}

export interface StatusPillProps {
  kind: StatusKind;
  status: string;
  /** Override the label (e.g. add a time: "Ready · 12:40"). */
  label?: string;
  /** marketing 28px · app 24px (default) · dense 22px (admin tables). */
  density?: Density;
  className?: string;
}

export function StatusPill({ kind, status, label, density, className }: StatusPillProps) {
  const [text, tone] = entry(kind, status);
  return (
    <Badge tone={tone} dot density={density} className={className}>
      {label ?? text}
    </Badge>
  );
}
