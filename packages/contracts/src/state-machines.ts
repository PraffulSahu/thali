/**
 * Backend-enforced state machines (LLD 4). Tables are plain `Transition[]` arrays; each exported
 * table is registered with the `*_INVALID_TRANSITION` error code of its entity, so
 * `assertTransition(childOrderTransitions, from, to, actor)` throws the right DomainError.
 */
import type {
  CheckoutStatus,
  ChildOrderStatus,
  DeliveryStatus,
  PartnerStatus,
  PaymentStatus,
  RefundStatus,
  RestaurantStatus,
} from './enums.js';
import { DomainError, type ErrorCode } from './errors.js';

export type Actor = 'CUSTOMER' | 'RESTAURANT' | 'PARTNER' | 'ADMIN' | 'SYSTEM';

export interface Transition<S extends string> {
  from: S;
  to: S;
  actors: Actor[];
}

export type TransitionErrorCode = Extract<ErrorCode, `${string}_INVALID_TRANSITION` | 'INVALID_TRANSITION'>;

const tableCodes = new WeakMap<readonly unknown[], TransitionErrorCode>();

/** Build a transition table and bind it to its entity's invalid-transition error code. */
export function defineTransitions<S extends string>(
  code: TransitionErrorCode,
  rows: readonly Transition<S>[],
): Transition<S>[] {
  const table = rows.map((r) => ({ from: r.from, to: r.to, actors: [...r.actors] }));
  tableCodes.set(table, code);
  return table;
}

/** The error code a table throws with (generic `INVALID_TRANSITION` for unregistered tables). */
export function transitionErrorCode(m: readonly Transition<string>[]): TransitionErrorCode {
  return tableCodes.get(m) ?? 'INVALID_TRANSITION';
}

export function canTransition<S extends string>(m: readonly Transition<S>[], from: S, to: S, actor: Actor): boolean {
  return m.some((t) => t.from === from && t.to === to && t.actors.includes(actor));
}

/**
 * Throws `DomainError(<ENTITY>_INVALID_TRANSITION, 409)` unless the transition is allowed for `actor`.
 * `code` overrides the table's registered code. `details = { from, to, actor }`.
 */
export function assertTransition<S extends string>(
  m: readonly Transition<S>[],
  from: S,
  to: S,
  actor: Actor,
  code?: TransitionErrorCode,
): void {
  if (canTransition(m, from, to, actor)) return;
  const known = m.some((t) => t.from === from && t.to === to);
  throw new DomainError(
    code ?? transitionErrorCode(m),
    known
      ? `Actor ${actor} may not move ${from} -> ${to}`
      : `Transition ${from} -> ${to} is not allowed`,
    undefined,
    { from, to, actor },
  );
}

/** Target states reachable from `from` (optionally filtered to those `actor` may perform). */
export function allowedTransitions<S extends string>(m: readonly Transition<S>[], from: S, actor?: Actor): S[] {
  return m.filter((t) => t.from === from && (actor === undefined || t.actors.includes(actor))).map((t) => t.to);
}

/** A state is terminal when no transition leaves it. */
export function isTerminalState<S extends string>(m: readonly Transition<S>[], state: S): boolean {
  return !m.some((t) => t.from === state);
}

type T<S extends string> = [from: S, to: S, actors: Actor[]];
const rows = <S extends string>(list: T<S>[]): Transition<S>[] =>
  list.map(([from, to, actors]) => ({ from, to, actors }));

// ---------------------------------------------------------------- 4.1 child order
export const childOrderTransitions = defineTransitions<ChildOrderStatus>(
  'ORDER_INVALID_TRANSITION',
  rows<ChildOrderStatus>([
    ['AWAITING_PAYMENT', 'PLACED', ['SYSTEM']], // payment.captured
    ['AWAITING_PAYMENT', 'PAYMENT_FAILED', ['SYSTEM']],
    ['AWAITING_PAYMENT', 'EXPIRED', ['SYSTEM']], // sweeper
    ['PLACED', 'ACCEPTED', ['RESTAURANT', 'ADMIN']],
    ['PLACED', 'REJECTED', ['RESTAURANT', 'SYSTEM', 'ADMIN']], // SYSTEM = RESTAURANT_TIMEOUT
    ['PLACED', 'CANCELLED', ['CUSTOMER', 'ADMIN']],
    ['ACCEPTED', 'PREPARING', ['RESTAURANT']],
    ['ACCEPTED', 'READY_FOR_PICKUP', ['RESTAURANT']],
    ['PREPARING', 'READY_FOR_PICKUP', ['RESTAURANT']],
    ['ACCEPTED', 'CANCELLED', ['ADMIN']],
    ['PREPARING', 'CANCELLED', ['ADMIN']],
    ['READY_FOR_PICKUP', 'CANCELLED', ['ADMIN']],
    ['READY_FOR_PICKUP', 'PICKED_UP', ['SYSTEM']], // delivery.picked_up
    ['ACCEPTED', 'PICKED_UP', ['SYSTEM']],
    ['PREPARING', 'PICKED_UP', ['SYSTEM']],
    ['PICKED_UP', 'OUT_FOR_DELIVERY', ['SYSTEM']], // delivery.started
    ['OUT_FOR_DELIVERY', 'DELIVERED', ['SYSTEM']], // delivery.delivered
    ['PICKED_UP', 'DELIVERED', ['SYSTEM']],
    ['PICKED_UP', 'DELIVERY_FAILED', ['SYSTEM', 'ADMIN']],
    ['OUT_FOR_DELIVERY', 'DELIVERY_FAILED', ['SYSTEM', 'ADMIN']],
    ['DELIVERY_FAILED', 'CANCELLED', ['ADMIN']],
  ]),
);

/** Terminal child-order states (DELIVERY_FAILED is deliberately NOT terminal: awaiting admin). */
export const childOrderTerminalStatuses: readonly ChildOrderStatus[] = [
  'DELIVERED',
  'REJECTED',
  'CANCELLED',
  'PAYMENT_FAILED',
  'EXPIRED',
];

// ---------------------------------------------------------------- 4.2 checkout group (derived)
export const checkoutTransitions = defineTransitions<CheckoutStatus>(
  'CHECKOUT_INVALID_TRANSITION',
  rows<CheckoutStatus>([
    ['AWAITING_PAYMENT', 'PAID_PLACED', ['SYSTEM']],
    ['AWAITING_PAYMENT', 'PAYMENT_FAILED', ['SYSTEM']],
    ['AWAITING_PAYMENT', 'EXPIRED', ['SYSTEM']],
    ['PAID_PLACED', 'IN_PROGRESS', ['SYSTEM']],
    ['PAID_PLACED', 'COMPLETED', ['SYSTEM']],
    ['PAID_PLACED', 'PARTIALLY_COMPLETED', ['SYSTEM']],
    ['PAID_PLACED', 'CANCELLED', ['SYSTEM']],
    ['IN_PROGRESS', 'COMPLETED', ['SYSTEM']],
    ['IN_PROGRESS', 'PARTIALLY_COMPLETED', ['SYSTEM']],
    ['IN_PROGRESS', 'CANCELLED', ['SYSTEM']],
  ]),
);

/**
 * Derive the checkout group status from its children (LLD 4.2).
 * - any AWAITING_PAYMENT -> AWAITING_PAYMENT; all PAYMENT_FAILED -> PAYMENT_FAILED; all EXPIRED -> EXPIRED
 * - all terminal: all DELIVERED -> COMPLETED; some DELIVERED -> PARTIALLY_COMPLETED; none -> CANCELLED
 * - else all PLACED -> PAID_PLACED, otherwise IN_PROGRESS
 * `current` is returned only when `children` is empty (nothing to derive from).
 */
export function deriveCheckoutStatus(children: ChildOrderStatus[], current: CheckoutStatus): CheckoutStatus {
  if (children.length === 0) return current;
  if (children.includes('AWAITING_PAYMENT')) return 'AWAITING_PAYMENT';
  if (children.every((c) => c === 'PAYMENT_FAILED')) return 'PAYMENT_FAILED';
  if (children.every((c) => c === 'EXPIRED')) return 'EXPIRED';
  if (children.every((c) => childOrderTerminalStatuses.includes(c))) {
    const delivered = children.filter((c) => c === 'DELIVERED').length;
    if (delivered === children.length) return 'COMPLETED';
    if (delivered > 0) return 'PARTIALLY_COMPLETED';
    return 'CANCELLED';
  }
  if (children.every((c) => c === 'PLACED')) return 'PAID_PLACED';
  return 'IN_PROGRESS';
}

// ---------------------------------------------------------------- 4.3 payment intent
export const paymentTransitions = defineTransitions<PaymentStatus>(
  'PAYMENT_INVALID_TRANSITION',
  rows<PaymentStatus>([
    ['CREATED', 'AUTHORIZED', ['SYSTEM']],
    ['AUTHORIZED', 'CAPTURED', ['SYSTEM']],
    ['CREATED', 'FAILED', ['SYSTEM']],
    ['AUTHORIZED', 'FAILED', ['SYSTEM']],
    ['CAPTURED', 'PARTIALLY_REFUNDED', ['SYSTEM']],
    ['PARTIALLY_REFUNDED', 'REFUNDED', ['SYSTEM']],
    ['CAPTURED', 'REFUNDED', ['SYSTEM']],
  ]),
);

// ---------------------------------------------------------------- 4.4 refund
export const refundTransitions = defineTransitions<RefundStatus>(
  'REFUND_INVALID_TRANSITION',
  rows<RefundStatus>([
    ['REQUESTED', 'PROCESSING', ['SYSTEM']],
    ['PROCESSING', 'SUCCEEDED', ['SYSTEM']],
    ['PROCESSING', 'FAILED', ['SYSTEM']],
    ['FAILED', 'PROCESSING', ['SYSTEM', 'ADMIN']], // retry (max 5 automatic; ADMIN = manual retry)
    ['REQUESTED', 'FAILED', ['SYSTEM']],
  ]),
);

// ---------------------------------------------------------------- 4.5 delivery job
export const deliveryTransitions = defineTransitions<DeliveryStatus>(
  'DELIVERY_INVALID_TRANSITION',
  rows<DeliveryStatus>([
    ['PENDING_ASSIGNMENT', 'OFFERED', ['SYSTEM']],
    // atomic accept (LLD 7) allows PENDING_ASSIGNMENT|OFFERED -> ASSIGNED; ADMIN = manual assign
    ['PENDING_ASSIGNMENT', 'ASSIGNED', ['PARTNER', 'ADMIN']],
    ['OFFERED', 'ASSIGNED', ['PARTNER', 'ADMIN']],
    ['OFFERED', 'PENDING_ASSIGNMENT', ['SYSTEM']], // all offers expired
    ['ASSIGNED', 'AT_PICKUP', ['PARTNER']],
    // admin unassign / partner drop before pickup / partner suspended (SYSTEM)
    ['ASSIGNED', 'PENDING_ASSIGNMENT', ['PARTNER', 'ADMIN', 'SYSTEM']],
    ['AT_PICKUP', 'PENDING_ASSIGNMENT', ['PARTNER', 'ADMIN', 'SYSTEM']],
    ['AT_PICKUP', 'PICKED_UP', ['PARTNER']],
    ['PICKED_UP', 'OUT_FOR_DELIVERY', ['PARTNER']],
    ['OUT_FOR_DELIVERY', 'DELIVERED', ['PARTNER']],
    ['PICKED_UP', 'FAILED', ['PARTNER', 'ADMIN']],
    ['OUT_FOR_DELIVERY', 'FAILED', ['PARTNER', 'ADMIN']],
    // any non-terminal -> CANCELLED (order cancelled)
    ['PENDING_ASSIGNMENT', 'CANCELLED', ['SYSTEM', 'ADMIN']],
    ['OFFERED', 'CANCELLED', ['SYSTEM', 'ADMIN']],
    ['ASSIGNED', 'CANCELLED', ['SYSTEM', 'ADMIN']],
    ['AT_PICKUP', 'CANCELLED', ['SYSTEM', 'ADMIN']],
    ['PICKED_UP', 'CANCELLED', ['SYSTEM', 'ADMIN']],
    ['OUT_FOR_DELIVERY', 'CANCELLED', ['SYSTEM', 'ADMIN']],
  ]),
);

// ---------------------------------------------------------------- 4.6 restaurant onboarding
export const restaurantTransitions = defineTransitions<RestaurantStatus>(
  'RESTAURANT_INVALID_TRANSITION',
  rows<RestaurantStatus>([
    ['DRAFT', 'VERIFICATION_PENDING', ['RESTAURANT']], // owner submits
    ['VERIFICATION_PENDING', 'APPROVAL_PENDING', ['SYSTEM']], // email verified
    ['APPROVAL_PENDING', 'APPROVED', ['ADMIN']],
    ['APPROVAL_PENDING', 'REJECTED', ['ADMIN']],
    ['REJECTED', 'APPROVAL_PENDING', ['RESTAURANT']], // owner resubmit (email still verified)
    ['APPROVED', 'SUSPENDED', ['ADMIN']],
    ['SUSPENDED', 'APPROVED', ['ADMIN']],
    // businessEmail changed before approval resets verification (LLD 4.6 last paragraph)
    ['APPROVAL_PENDING', 'VERIFICATION_PENDING', ['RESTAURANT']],
    ['REJECTED', 'VERIFICATION_PENDING', ['RESTAURANT']],
  ]),
);

// ---------------------------------------------------------------- 4.7 partner
export const partnerTransitions = defineTransitions<PartnerStatus>(
  'PARTNER_INVALID_TRANSITION',
  rows<PartnerStatus>([
    ['DRAFT', 'APPROVAL_PENDING', ['PARTNER']],
    ['APPROVAL_PENDING', 'APPROVED', ['ADMIN']],
    ['APPROVAL_PENDING', 'REJECTED', ['ADMIN']],
    ['REJECTED', 'APPROVAL_PENDING', ['PARTNER']],
    ['APPROVED', 'SUSPENDED', ['ADMIN']],
    ['SUSPENDED', 'APPROVED', ['ADMIN']],
  ]),
);
