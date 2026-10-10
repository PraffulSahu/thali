/**
 * Releasing an unpaid checkout (LLD §4.1 AWAITING_PAYMENT → PAYMENT_FAILED | EXPIRED, §8 step 8
 * failure, consumer `payment.failed`, sweeper (a)). Runs inside the caller's transaction; emits
 * `checkout.released` so marketplace releases stock / coupon / membership holds.
 */
import type { ClientSession } from 'mongoose';
import type { OrdersContext } from '../context.js';
import type { CheckoutGroupDoc } from '../models/checkout-group.js';
import { appendOrderEvents } from '../models/order-event.js';
import { applyChildTransition, applyDerivedCheckoutStatus } from './child-state.js';
import { emitOrdersEvent } from './events.js';
import { publishChildUpdate } from './place.js';

export type ReleaseReason = 'PAYMENT_FAILED' | 'EXPIRED';

/** Returns false (no-op) unless the checkout is still AWAITING_PAYMENT. */
export async function releaseCheckout(
  ctx: OrdersContext,
  session: ClientSession,
  group: CheckoutGroupDoc,
  reason: ReleaseReason,
  opts: { detail?: string; correlationId?: string; paymentStatus?: string } = {},
): Promise<boolean> {
  if (group.status !== 'AWAITING_PAYMENT') return false;
  const now = new Date();
  const children = await ctx.models.ChildOrder.find({ checkoutGroupId: group._id }).sort({ restaurantId: 1 }).session(session);
  for (const child of children) {
    if (child.status !== 'AWAITING_PAYMENT') continue;
    applyChildTransition(child, reason, { actor: 'SYSTEM', reason: opts.detail ?? reason, at: now });
    await child.save({ session });
  }
  if (opts.paymentStatus) group.paymentStatus = opts.paymentStatus;
  else if (reason === 'PAYMENT_FAILED') group.paymentStatus = 'FAILED';
  applyDerivedCheckoutStatus(group, children.map((c) => c.status), { reason: opts.detail ?? reason, at: now });
  await group.save({ session });

  const checkoutId = String(group._id);
  await emitOrdersEvent(ctx, session, 'checkout.released', { checkoutId, reason }, checkoutId, opts.correlationId);
  await appendOrderEvents(ctx.conn, session, [
    { checkoutGroupId: group._id, type: 'checkout.released', actor: 'SYSTEM', data: { reason, detail: opts.detail ?? null }, at: now },
  ]);
  for (const child of children) publishChildUpdate(ctx, session, group, child);
  return true;
}

/**
 * Release a reservation for a checkout id that never got (or lost) its checkout document — e.g. the
 * losing request of a concurrent double-submit, or an ambiguous reservation failure. Marketplace's
 * release is idempotent per checkoutId, so emitting this for an id without a hold is harmless.
 */
export async function releaseOrphanReservation(ctx: OrdersContext, session: ClientSession, checkoutId: string, correlationId?: string): Promise<void> {
  await emitOrdersEvent(ctx, session, 'checkout.released', { checkoutId, reason: 'EXPIRED' }, checkoutId, correlationId);
}
