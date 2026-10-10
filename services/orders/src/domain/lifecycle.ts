/**
 * Child-order lifecycle (LLD §4.1). EVERY child state change after placement goes through
 * `transitionChild` — restaurant routes, customer cancel, admin actions, delivery events and the
 * acceptance-timeout sweeper — so the rules live in one place:
 *
 *   1. load the child in the caller's transaction; ownership scope (restaurant owner / customer)
 *      mismatch → 404 (never reveal other tenants' orders)
 *   2. restaurant acting on PLACED after `acceptBy` → 409 ORDER_ACCEPT_WINDOW_EXPIRED
 *   3. `assertTransition(childOrderTransitions, from, to, actor)` → 409 ORDER_INVALID_TRANSITION
 *      (via `applyChildTransition`, which also writes statusHistory + the entry timestamp)
 *   4. per-target effects + preconditions (prepMinutes 5–120, reason required, refund ≤ remaining)
 *   5. parent status re-derived (`recomputeCheckout`)
 *   6. outbox event per LLD §9, timeline entry, realtime `order.updated` (user) + `owner.order`
 *      (restaurant owner) queued until commit.
 *
 * Runs inside the caller's transaction; never does HTTP or Redis work directly.
 */
import { Types, type ClientSession } from 'mongoose';
import { DomainError, type Actor, type ChildOrderStatus, type EventPayloads, type EventType, type GeoJsonPoint } from '@thali/contracts';
import { realtimeChannel } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { ChildOrder, ChildOrderDoc, RestaurantAddress } from '../models/child-order.js';
import { plainBreakdown, type AddressSnapshot } from '../models/common.js';
import { appendOrderEvents, type TimelineEntry } from '../models/order-event.js';
import { applyChildTransition } from './child-state.js';
import { recomputeCheckout } from './derive.js';
import { emitOrdersEvent } from './events.js';
import { publishChildUpdate } from './place.js';
import { queueRealtime } from './realtime.js';
import { remainingRefundable, requestChildRefund } from './refunds.js';
import type { OrderCancelledPayload, OrderRejectedPayload } from '../contracts-local.js';

export const PREP_MINUTES_MIN = 5;
export const PREP_MINUTES_MAX = 120;

export interface TransitionExtra {
  /** ACCEPTED: 5–120. */
  prepMinutes?: number;
  /** CANCELLED by ADMIN: refund to request (≤ remaining refundable). */
  refundPaise?: number;
  /** DELIVERED / PICKED_UP: delivery job + partner + distance from delivery events. */
  deliveryJobId?: string;
  partnerUserId?: string;
  deliveryDistanceKm?: number;
  /** Effective time (defaults to now). */
  at?: Date;
}

export interface TransitionOptions {
  actor: Actor;
  actorId?: string | null;
  reason?: string | null;
  /** Ownership: the child must belong to this restaurant owner / customer, else 404. */
  scope?: { restaurantOwnerId?: string; userId?: string };
  /** System callers: apply only when the child is currently in one of these statuses (else no-op → null). */
  onlyFrom?: ChildOrderStatus[];
  extra?: TransitionExtra;
  correlationId?: string;
}

const notFound = () => new DomainError('NOT_FOUND', 'Order not found');

/** Load a child for an actor, enforcing ownership scope (404 on mismatch). */
export async function loadChildFor(
  ctx: OrdersContext,
  childId: string,
  scope: TransitionOptions['scope'] = {},
  session?: ClientSession,
): Promise<ChildOrderDoc> {
  const child = Types.ObjectId.isValid(childId) ? await ctx.models.ChildOrder.findById(childId).session(session ?? null) : null;
  if (!child) throw notFound();
  if (scope.restaurantOwnerId !== undefined && child.restaurantOwnerId !== scope.restaurantOwnerId) throw notFound();
  if (scope.userId !== undefined && child.userId !== scope.userId) throw notFound();
  return child;
}

export function formatAddress(a: Partial<RestaurantAddress & AddressSnapshot> | null | undefined): string {
  if (!a) return '';
  return [a.line1, a.line2, a.landmark, a.city, a.pincode].filter((x) => typeof x === 'string' && x.trim() !== '').join(', ');
}

function plainPoint(p: GeoJsonPoint | null | undefined): GeoJsonPoint {
  const c = p?.coordinates ?? [0, 0];
  return { type: 'Point', coordinates: [Number(c[0]), Number(c[1])] };
}

/**
 * Drop "area" shown on a partner offer before pickup (contract 2 / DLV-2, as relaxed by the controller
 * ruling): the address locality, else the pincode.
 */
export function dropAreaOf(a: Partial<AddressSnapshot> | null | undefined): string {
  return (a?.locality ?? '').trim() || (a?.pincode ?? '').trim();
}

/**
 * `order.accepted` pickup / drop snapshots (LLD §9; delivery creates the job from these). Contract 2:
 * `pickup.phone` (restaurant E.164, omitted when unknown), `drop.area`, `drop.label`.
 */
export function pickupDropOf(child: ChildOrder): Pick<EventPayloads['order.accepted'], 'pickup' | 'drop'> {
  return {
    pickup: {
      name: child.restaurantName,
      address: formatAddress(child.restaurantAddress),
      location: plainPoint(child.restaurantLocation),
      ...(child.restaurantPhone ? { phone: child.restaurantPhone } : {}),
    },
    drop: {
      name: child.customerContact?.name ?? '',
      address: formatAddress(child.dropAddress),
      location: plainPoint(child.dropAddress?.location),
      phoneMasked: child.customerContact?.phoneMasked ?? '',
      area: dropAreaOf(child.dropAddress),
      label: child.dropAddress?.label ?? null,
    },
  };
}

function requireReason(reason: string | null | undefined, what: string): string {
  const r = (reason ?? '').trim();
  if (!r) {
    throw new DomainError('VALIDATION_FAILED', `A reason is required to ${what}`, 400, {
      issues: [{ path: 'body.reason', code: 'too_small', message: 'Reason is required' }],
    });
  }
  return r;
}

function invalidField(path: string, message: string): DomainError {
  return new DomainError('VALIDATION_FAILED', message, 400, { issues: [{ path, code: 'invalid', message }] });
}

/** Payload is the LLD §9 shape (plus additive local fields from contracts-local.ts). */
type Emitted = { type: EventType; payload: object };

/**
 * Apply one child transition with all its effects (see file header). Returns the saved child, or
 * null when `onlyFrom` was given and the child is no longer in one of those statuses.
 */
export async function transitionChild(
  ctx: OrdersContext,
  session: ClientSession,
  childId: string,
  to: ChildOrderStatus,
  opts: TransitionOptions,
): Promise<ChildOrderDoc | null> {
  const child = await loadChildFor(ctx, childId, opts.scope, session);
  if (opts.onlyFrom && !opts.onlyFrom.includes(child.status)) return null;

  const extra = opts.extra ?? {};
  const now = extra.at ?? new Date();
  const from = child.status;

  if (opts.actor === 'RESTAURANT' && from === 'PLACED' && (to === 'ACCEPTED' || to === 'REJECTED') && child.acceptBy && child.acceptBy.getTime() < now.getTime()) {
    throw new DomainError('ORDER_ACCEPT_WINDOW_EXPIRED', 'The acceptance window for this order has passed', 409, {
      acceptBy: child.acceptBy.toISOString(),
    });
  }

  applyChildTransition(child, to, { actor: opts.actor, actorId: opts.actorId ?? null, reason: opts.reason ?? null, at: now });

  const id = String(child._id);
  const checkoutId = String(child.checkoutGroupId);
  let emitted: Emitted;
  const timelineData: Record<string, unknown> = { from, to, reason: opts.reason ?? null };

  switch (to) {
    case 'ACCEPTED': {
      const prep = extra.prepMinutes;
      if (prep === undefined || !Number.isInteger(prep) || prep < PREP_MINUTES_MIN || prep > PREP_MINUTES_MAX) {
        throw invalidField('body.prepMinutes', `prepMinutes must be an integer from ${PREP_MINUTES_MIN} to ${PREP_MINUTES_MAX}`);
      }
      child.prepMinutes = prep;
      child.readyEta = new Date(now.getTime() + prep * 60_000);
      timelineData.prepMinutes = prep;
      emitted = {
        type: 'order.accepted',
        payload: {
          childOrderId: id,
          checkoutId,
          // contract 2 / DLV-4: codes for the partner header (checkoutCode is filled in below from the group)
          childOrderCode: child.code,
          userId: child.userId,
          restaurantId: child.restaurantId,
          prepMinutes: prep,
          ...pickupDropOf(child),
          pickupCode: child.pickupCode,
          deliveryCode: child.deliveryCode,
        },
      };
      break;
    }
    case 'REJECTED': {
      const reason = requireReason(opts.reason, 'reject an order');
      const refundPaise = remainingRefundable(child);
      child.rejectionReason = reason;
      requestChildRefund(child, refundPaise);
      timelineData.refundPaise = refundPaise;
      emitted = {
        type: 'order.rejected',
        payload: { childOrderId: id, checkoutId, userId: child.userId, restaurantId: child.restaurantId, reason, refundPaise, fromStatus: from } satisfies OrderRejectedPayload,
      };
      break;
    }
    case 'CANCELLED': {
      const reason = requireReason(opts.reason, 'cancel an order');
      const remaining = remainingRefundable(child);
      let refundPaise: number;
      if (opts.actor === 'CUSTOMER') refundPaise = remaining;
      else {
        if (extra.refundPaise === undefined || !Number.isInteger(extra.refundPaise) || extra.refundPaise < 0) {
          throw invalidField('body.refundPaise', 'refundPaise (integer paise ≥ 0) is required');
        }
        refundPaise = extra.refundPaise;
        if (refundPaise > remaining) {
          throw new DomainError('REFUND_EXCEEDS_REMAINING', `Refund exceeds the remaining refundable amount (${remaining} paise)`, 422, {
            refundPaise,
            remainingPaise: remaining,
          });
        }
      }
      child.cancellationReason = reason;
      child.cancelledBy = opts.actor;
      requestChildRefund(child, refundPaise);
      timelineData.refundPaise = refundPaise;
      emitted = {
        type: 'order.cancelled',
        payload: {
          childOrderId: id,
          checkoutId,
          userId: child.userId,
          restaurantId: child.restaurantId,
          actor: opts.actor,
          // payments maps reason DELIVERY_FAILED → refund reason DELIVERY_FAILED; the admin's text stays on the child
          reason: from === 'DELIVERY_FAILED' ? 'DELIVERY_FAILED' : reason,
          refundPaise,
          fromStatus: from,
        } satisfies OrderCancelledPayload,
      };
      break;
    }
    case 'PREPARING':
      emitted = { type: 'order.preparing', payload: { childOrderId: id, restaurantId: child.restaurantId, userId: child.userId } };
      break;
    case 'READY_FOR_PICKUP':
      emitted = { type: 'order.ready', payload: { childOrderId: id, restaurantId: child.restaurantId, userId: child.userId } };
      break;
    case 'PICKED_UP':
      if (extra.deliveryJobId && !child.deliveryJobId) child.deliveryJobId = extra.deliveryJobId;
      emitted = { type: 'order.picked_up', payload: { childOrderId: id, userId: child.userId } };
      break;
    case 'OUT_FOR_DELIVERY':
      emitted = { type: 'order.out_for_delivery', payload: { childOrderId: id, userId: child.userId } };
      break;
    case 'DELIVERED': {
      if (extra.deliveryJobId && !child.deliveryJobId) child.deliveryJobId = extra.deliveryJobId;
      if (extra.deliveryDistanceKm !== undefined) child.deliveryDistanceKm = extra.deliveryDistanceKm;
      // the partner who actually delivered (delivery.delivered) wins over the last assignment mirror
      const partnerUserId = extra.partnerUserId || child.partner?.partnerUserId || '';
      const deliveryJobId = child.deliveryJobId || extra.deliveryJobId || '';
      const deliveryDistanceKm = child.deliveryDistanceKm ?? child.distanceKm ?? 0;
      timelineData.deliveryDistanceKm = deliveryDistanceKm;
      emitted = {
        type: 'order.delivered',
        payload: {
          childOrderId: id,
          checkoutId,
          userId: child.userId,
          restaurantId: child.restaurantId,
          restaurantOwnerId: child.restaurantOwnerId,
          breakdown: plainBreakdown(child.breakdown),
          commissionBps: child.commissionBps,
          deliveryJobId,
          partnerUserId,
          deliveryDistanceKm,
        },
      };
      break;
    }
    case 'DELIVERY_FAILED': {
      const reason = (opts.reason ?? '').trim() || 'Delivery failed';
      child.deliveryFailureReason = reason;
      emitted = { type: 'order.delivery_failed', payload: { childOrderId: id, reason } };
      break;
    }
    default:
      // AWAITING_PAYMENT exits (PLACED / PAYMENT_FAILED / EXPIRED) are checkout-level (domain/place.ts, release.ts)
      throw new DomainError('ORDER_INVALID_TRANSITION', `Use the checkout flow for ${from} -> ${to}`, 409, { from, to, actor: opts.actor });
  }

  await child.save({ session });
  const derived = await recomputeCheckout(ctx, session, child, { reason: `${child.code} ${to}`, at: now });
  if (emitted.type === 'order.accepted') emitted.payload = { ...emitted.payload, checkoutCode: derived.group.code };

  await emitOrdersEvent(ctx, session, emitted.type, emitted.payload as never, id, opts.correlationId);
  const timeline: TimelineEntry[] = [
    { checkoutGroupId: child.checkoutGroupId, childOrderId: child._id, type: emitted.type, actor: opts.actor, actorId: opts.actorId ?? null, data: timelineData, at: now },
  ];
  if (derived.changed) {
    timeline.push({
      checkoutGroupId: child.checkoutGroupId,
      type: 'checkout.status_changed',
      actor: 'SYSTEM',
      data: { from: derived.from, to: derived.to, childOrderId: id },
      at: now,
    });
  }
  await appendOrderEvents(ctx.conn, session, timeline);

  publishChildUpdate(ctx, session, derived.group, child);
  queueOwnerOrder(ctx, session, child);
  return child;
}

/** LLD §11 `owner.order {childOrderId, restaurantId, status}` → `owner:<restaurantOwnerId>` after commit. */
export function queueOwnerOrder(ctx: OrdersContext, session: ClientSession, child: Pick<ChildOrder, '_id' | 'restaurantId' | 'restaurantOwnerId' | 'status'>): void {
  queueRealtime(session, ctx.redis, ctx.logger, realtimeChannel.owner(child.restaurantOwnerId), 'owner.order', {
    childOrderId: String(child._id),
    restaurantId: child.restaurantId,
    status: child.status,
  });
}
