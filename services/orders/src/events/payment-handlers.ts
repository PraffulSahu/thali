/**
 * Payment outcome consumers (LLD §8): `payment.captured` / `payment.failed` with purpose CHECKOUT.
 * Run inside the consumer's transaction (inbox dedupe by envelope id); business guards make a
 * second envelope for the same payment a no-op as well.
 */
import type { EventHandlers } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { applyCapturedPayment } from '../domain/place.js';
import { releaseCheckout } from '../domain/release.js';
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
      const p = e.payload;
      if (p.purpose !== 'CHECKOUT' || !Types.ObjectId.isValid(p.referenceId)) return;
      const group = await ctx.models.CheckoutGroup.findById(p.referenceId).session(session);
      if (!group) return;
      const released = await releaseCheckout(ctx, session, group, 'PAYMENT_FAILED', {
        detail: p.reason || 'payment failed',
        correlationId: e.correlationId,
      });
      ctx.logger.info({ checkoutId: p.referenceId, released, eventId: e.id }, 'payment.failed applied');
    },
  };
}

export const paymentEventsModule: EventModule = {
  name: 'payments',
  streams: ['events.payments'],
  handlers: paymentHandlers,
};
