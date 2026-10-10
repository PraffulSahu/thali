/**
 * Payment outcome consumers (LLD §8): `payment.captured` / `payment.failed` with purpose CHECKOUT.
 * `payment.failed` is a mirror only (status FAILED, checkout kept for retry).
 * Run inside the consumer's transaction (inbox dedupe by envelope id); business guards make a
 * second envelope for the same payment a no-op as well.
 */
import type { EventHandlers } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { applyCapturedPayment, publishChildUpdate } from '../domain/place.js';
import { appendOrderEvents } from '../models/order-event.js';
import { Types } from 'mongoose';
import type { EventModule } from './types.js';

export function paymentHandlers(ctx: OrdersContext): EventHandlers {
  return {
    'payment.captured': async (e, session) => {
      const p = e.payload;
      if (p.purpose !== 'CHECKOUT') return;
      if (!Types.ObjectId.isValid(p.referenceId)) {
        ctx.logger.warn({ referenceId: p.referenceId }, 'payment.captured with a non-checkout reference id');
        return;
      }
      const outcome = await applyCapturedPayment(ctx, session, {
        checkoutId: p.referenceId,
        paymentIntentId: p.paymentIntentId,
        amountPaise: p.amountPaise,
        source: 'payment.captured',
        correlationId: e.correlationId,
      });
      ctx.logger.info({ checkoutId: p.referenceId, outcome, eventId: e.id }, 'payment.captured applied');
    },
    'payment.failed': async (e, session) => {
      // Mirror only (LLD §8 as amended, §4.3 FAILED→CAPTURED): the customer may retry on the same
      // provider order, so the checkout stays AWAITING_PAYMENT with its reservations held. The
      // reconcile-first expiry sweeper decides EXPIRED + release; a later capture still places.
      const p = e.payload;
      if (p.purpose !== 'CHECKOUT' || !Types.ObjectId.isValid(p.referenceId)) return;
      const group = await ctx.models.CheckoutGroup.findById(p.referenceId).session(session);
      if (!group || group.status !== 'AWAITING_PAYMENT') return;
      if (group.paymentStatus === 'CAPTURED') return; // stale failure after a capture
      const at = new Date();
      group.paymentStatus = 'FAILED';
      await group.save({ session });
      await appendOrderEvents(ctx.conn, session, [
        { checkoutGroupId: group._id, type: 'payment.failed', actor: 'SYSTEM', data: { paymentIntentId: p.paymentIntentId, reason: p.reason ?? null }, at },
      ]);
      const children = await ctx.models.ChildOrder.find({ checkoutGroupId: group._id }).sort({ restaurantId: 1 }).session(session);
      for (const child of children) publishChildUpdate(ctx, session, group, child);
      ctx.logger.info({ checkoutId: p.referenceId, eventId: e.id }, 'payment.failed mirrored (checkout kept for retry)');
    },
  };
}

export const paymentEventsModule: EventModule = {
  name: 'payments',
  streams: ['events.payments'],
  handlers: paymentHandlers,
};
