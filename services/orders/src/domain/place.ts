/**
 * Applying a captured CHECKOUT payment (LLD §8 consumer `payment.captured`, sweeper (a) on
 * reconcile CAPTURED; LLD §4.1 AWAITING_PAYMENT → PLACED). Runs inside the caller's transaction.
 *
 *  - AWAITING_PAYMENT and amount == pricing.totalPaise → every child PLACED (`acceptBy = now +
 *    ACCEPT_WINDOW_SEC`), parent PAID_PLACED, outbox `checkout.confirmed` + `order.placed`×N,
 *    purchased cart lines cleared, `order.updated` realtime after commit.
 *  - AWAITING_PAYMENT and amount differs → NOT placed; alert (error log + `payment.amount_mismatch`
 *    timeline entry). The expiry sweeper later expires it and requests a refund via late payment.
 *  - EXPIRED / PAYMENT_FAILED → `checkout.late_payment` once per payment intent (payments refunds).
 *  - anything else (already placed) → no-op (duplicate delivery).
 */
import type { ClientSession } from 'mongoose';
import type { OrdersContext } from '../context.js';
import type { CheckoutGroupDoc } from '../models/checkout-group.js';
import type { ChildOrderDoc } from '../models/child-order.js';
import { appendOrderEvents } from '../models/order-event.js';
import { applyChildTransition, applyDerivedCheckoutStatus } from './child-state.js';
import { emitOrdersEvent } from './events.js';
import { queueOrderUpdated, queueRealtime } from './realtime.js';
import { realtimeChannel } from '@thali/service-kit';

export type CaptureOutcome = 'PLACED' | 'ALREADY_PLACED' | 'LATE_PAYMENT' | 'LATE_PAYMENT_DUPLICATE' | 'AMOUNT_MISMATCH' | 'NOT_FOUND';

export interface CapturedPayment {
  checkoutId: string;
  paymentIntentId: string | null;
  amountPaise: number;
  source: 'payment.captured' | 'reconcile';
  correlationId?: string;
}

export async function applyCapturedPayment(ctx: OrdersContext, session: ClientSession, p: CapturedPayment): Promise<CaptureOutcome> {
  const group = await ctx.models.CheckoutGroup.findById(p.checkoutId).session(session);
  if (!group) {
    ctx.logger.warn({ checkoutId: p.checkoutId, source: p.source }, 'captured payment for unknown checkout');
    return 'NOT_FOUND';
  }

  if (group.status === 'EXPIRED' || group.status === 'PAYMENT_FAILED') {
    return recordLatePayment(ctx, session, group, p);
  }
  if (group.status !== 'AWAITING_PAYMENT') return 'ALREADY_PLACED';

  if (p.amountPaise !== group.pricing.totalPaise) {
    const at = new Date();
    group.paymentMismatch = { expectedPaise: group.pricing.totalPaise, receivedPaise: p.amountPaise, at };
    await group.save({ session });
    await appendOrderEvents(ctx.conn, session, [
      {
        checkoutGroupId: group._id,
        type: 'payment.amount_mismatch',
        actor: 'SYSTEM',
        data: { expectedPaise: group.pricing.totalPaise, receivedPaise: p.amountPaise, paymentIntentId: p.paymentIntentId, source: p.source },
        at,
      },
    ]);
    ctx.logger.error(
      { alert: 'PAYMENT_AMOUNT_MISMATCH', checkoutId: p.checkoutId, expectedPaise: group.pricing.totalPaise, receivedPaise: p.amountPaise },
      'captured amount does not match checkout total; not placing',
    );
    return 'AMOUNT_MISMATCH';
  }

  const now = new Date();
  const acceptBy = new Date(now.getTime() + ctx.config.ACCEPT_WINDOW_SEC * 1000);
  const children = await ctx.models.ChildOrder.find({ checkoutGroupId: group._id }).sort({ restaurantId: 1 }).session(session);
  for (const child of children) {
    if (child.status !== 'AWAITING_PAYMENT') continue;
    applyChildTransition(child, 'PLACED', { actor: 'SYSTEM', reason: 'payment captured', at: now });
    child.acceptBy = acceptBy;
    await child.save({ session });
  }

  group.paymentStatus = 'CAPTURED';
  if (p.paymentIntentId && !group.paymentIntentId) group.paymentIntentId = p.paymentIntentId;
  group.placedAt = now;
  applyDerivedCheckoutStatus(group, children.map((c) => c.status), { reason: 'payment captured', at: now });
  await group.save({ session });

  const checkoutId = String(group._id);
  const childOrderIds = children.map((c) => String(c._id));
  await emitOrdersEvent(ctx, session, 'checkout.confirmed', { checkoutId, userId: group.userId, childOrderIds }, checkoutId, p.correlationId);
  for (const child of children) {
    await emitOrdersEvent(
      ctx,
      session,
      'order.placed',
      {
        childOrderId: String(child._id),
        checkoutId,
        userId: child.userId,
        restaurantId: child.restaurantId,
        restaurantOwnerId: child.restaurantOwnerId,
        code: child.code,
        totalPaise: child.breakdown.totalPaise,
        acceptBy: acceptBy.toISOString(),
      },
      String(child._id),
      p.correlationId,
    );
  }
  await appendOrderEvents(ctx.conn, session, [
    { checkoutGroupId: group._id, type: 'checkout.confirmed', actor: 'SYSTEM', data: { source: p.source, amountPaise: p.amountPaise }, at: now },
    ...children.map((c) => ({ checkoutGroupId: group._id, childOrderId: c._id, type: 'order.placed', actor: 'SYSTEM', data: { acceptBy }, at: now })),
  ]);

  await clearPurchasedCartLines(ctx, session, group, children);
  for (const child of children) {
    publishChildUpdate(ctx, session, group, child);
    // LLD §11 owner.order: incoming order for the restaurant dashboard (Task 12)
    queueRealtime(session, ctx.redis, ctx.logger, realtimeChannel.owner(child.restaurantOwnerId), 'owner.order', {
      childOrderId: String(child._id),
      restaurantId: child.restaurantId,
      status: child.status,
    });
  }
  return 'PLACED';
}

async function recordLatePayment(ctx: OrdersContext, session: ClientSession, group: CheckoutGroupDoc, p: CapturedPayment): Promise<CaptureOutcome> {
  const intentId = p.paymentIntentId ?? group.paymentIntentId ?? null;
  if (group.latePayment && (group.latePayment.paymentIntentId ?? null) === intentId) return 'LATE_PAYMENT_DUPLICATE';
  const at = new Date();
  group.latePayment = { paymentIntentId: intentId, amountPaise: p.amountPaise, at };
  group.paymentStatus = 'CAPTURED';
  await group.save({ session });
  const checkoutId = String(group._id);
  await emitOrdersEvent(
    ctx,
    session,
    'checkout.late_payment',
    { checkoutId, ...(intentId ? { paymentIntentId: intentId } : {}), amountPaise: p.amountPaise },
    checkoutId,
    p.correlationId,
  );
  await appendOrderEvents(ctx.conn, session, [
    { checkoutGroupId: group._id, type: 'checkout.late_payment', actor: 'SYSTEM', data: { paymentIntentId: intentId, amountPaise: p.amountPaise, source: p.source }, at },
  ]);
  ctx.logger.warn({ checkoutId, status: group.status, amountPaise: p.amountPaise }, 'payment captured after checkout closed; refund requested');
  return 'LATE_PAYMENT';
}

/**
 * LLD §8: on PLACED clear the purchased cart items — all of them if the cart is still at the
 * checked-out version and the checkout covered the whole cart, otherwise only lines matching
 * purchased lines (by line identity). A subset checkout (ORD-3) never clears the other restaurants.
 */
export async function clearPurchasedCartLines(ctx: OrdersContext, session: ClientSession, group: CheckoutGroupDoc, children: ChildOrderDoc[]): Promise<void> {
  const cart = await ctx.models.Cart.findOne({ userId: group.userId, ownerType: 'USER' }).session(session);
  if (!cart) return;
  const wholeCart = (group.restaurantSetKey ?? '*') === '*';
  if (wholeCart && cart.cartVersion === group.cartVersion) {
    cart.items = [];
    cart.couponCode = null;
  } else {
    const purchased = new Set(children.flatMap((c) => c.lines.map((l) => l.lineKey)));
    cart.items = cart.items.filter((l) => !purchased.has(l.lineKey));
    if (group.couponCode && cart.couponCode === group.couponCode) cart.couponCode = null;
  }
  cart.cartVersion += 1;
  await cart.save({ session });
}

/** Queue LLD §11 `order.updated` for one child (published after commit). */
export function publishChildUpdate(ctx: OrdersContext, session: ClientSession, group: CheckoutGroupDoc, child: ChildOrderDoc): void {
  queueOrderUpdated(session, ctx.redis, ctx.logger, group.userId, {
    checkoutId: String(group._id),
    childOrderId: String(child._id),
    status: child.status,
    checkoutStatus: group.status,
    refundStatus: child.refundStatus ?? null,
    deliveryStatus: child.deliveryStatus ?? null,
  });
}
