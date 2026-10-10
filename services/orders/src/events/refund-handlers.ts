/**
 * Refund progress from payments (`events.payments`, LLD §8 consumer `refund.*`): update the child's
 * `refundStatus` / `refundedPaise` mirror (domain/refunds.ts). Checkout-level refunds (no
 * `childOrderId`, e.g. LATE_PAYMENT) only land on the timeline.
 */
import type { ClientSession } from 'mongoose';
import type { EventEnvelope } from '@thali/contracts';
import type { EventHandlers } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { applyRefundEvent } from '../domain/refunds.js';
import type { EventModule } from './types.js';

export function refundHandlers(ctx: OrdersContext): EventHandlers {
  type RefundType = 'refund.requested' | 'refund.processing' | 'refund.succeeded' | 'refund.failed';
  const handle = async (e: EventEnvelope<RefundType>, session: ClientSession) => {
    const outcome = await applyRefundEvent(ctx, session, e);
    ctx.logger.info({ refundId: e.payload.refundId, childOrderId: e.payload.childOrderId ?? null, type: e.type, outcome }, 'refund event applied');
  };
  return {
    'refund.requested': handle,
    'refund.processing': handle,
    'refund.succeeded': handle,
    'refund.failed': handle,
  };
}

export const refundEventsModule: EventModule = {
  name: 'refunds',
  streams: ['events.payments'],
  handlers: refundHandlers,
};
