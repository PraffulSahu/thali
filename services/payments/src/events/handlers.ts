/**
 * Consumers (cg.payments on events.orders). Each handler runs inside the consumer's transaction with the
 * inbox insert; refunds are also idempotent by natural key (`refund:<childOrderId>:<reason>`), and ledger
 * entries by dedupeKey, so re-published copies with new event ids are absorbed too. No provider I/O here:
 * the refund worker calls the provider after commit.
 */
import type { EventPayloads, RefundReason } from '@thali/contracts';
import type { EventHandlers } from '@thali/service-kit';
import type { ClientSession } from 'mongoose';
import type { PaymentsContext } from '../context.js';
import { recordDeliveryEarnings } from '../domain/ledger.js';
import { requestRefund } from '../domain/refunds.js';

export const CONSUMED_STREAMS = ['events.orders'];

function validRefund(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isInteger(amount) && amount > 0;
}

export function cancelReason(p: EventPayloads['order.cancelled']): RefundReason {
  if (p.reason === 'DELIVERY_FAILED') return 'DELIVERY_FAILED';
  return p.actor === 'CUSTOMER' ? 'CUSTOMER_CANCELLED' : 'ADMIN';
}

async function childRefund(
  ctx: PaymentsContext,
  session: ClientSession,
  p: { childOrderId: string; checkoutId: string; refundPaise: number },
  reason: RefundReason,
  type: string,
  correlationId: string,
) {
  if (!validRefund(p.refundPaise)) {
    if (p.refundPaise !== 0) ctx.logger.error({ alert: 'REFUND_AMOUNT_INVALID', childOrderId: p.childOrderId, refundPaise: p.refundPaise }, 'invalid refundPaise');
    return;
  }
  await requestRefund(ctx, session, {
    checkoutGroupId: p.checkoutId,
    childOrderId: p.childOrderId,
    amountPaise: p.refundPaise,
    reason,
    idempotencyKey: `refund:${p.childOrderId}:${reason}`,
    requestedBy: `event:${type}`,
    strict: false,
    correlationId,
  });
}

export function createEventHandlers(ctx: PaymentsContext): EventHandlers {
  return {
    'order.rejected': async (e, session) => {
      const reason: RefundReason = e.payload.reason === 'RESTAURANT_TIMEOUT' ? 'RESTAURANT_TIMEOUT' : 'RESTAURANT_REJECTED';
      await childRefund(ctx, session, e.payload, reason, e.type, e.correlationId);
    },
    'order.cancelled': async (e, session) => {
      await childRefund(ctx, session, e.payload, cancelReason(e.payload), e.type, e.correlationId);
    },
    'checkout.late_payment': async (e, session) => {
      const p = e.payload;
      if (!validRefund(p.amountPaise)) return;
      await requestRefund(ctx, session, {
        ...(p.paymentIntentId ? { paymentIntentId: p.paymentIntentId } : {}),
        checkoutGroupId: p.checkoutId,
        amountPaise: p.amountPaise,
        reason: 'LATE_PAYMENT',
        idempotencyKey: `refund:${p.checkoutId}:LATE_PAYMENT`,
        requestedBy: `event:${e.type}`,
        strict: false,
        correlationId: e.correlationId,
      });
    },
    'order.delivered': async (e, session) => {
      await recordDeliveryEarnings(ctx, session, e.payload);
    },
  };
}
