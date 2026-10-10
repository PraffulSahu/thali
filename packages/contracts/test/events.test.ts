import { describe, expect, it } from 'vitest';
import { EventTypes, type EventEnvelope, type EventPayloads, eventProducer, eventStream } from '../src/index.js';

describe('event catalog', () => {
  it('contains every LLD section 9 event type', () => {
    const expected = [
      'user.registered', 'role.granted', 'audit.recorded', 'restaurant.submitted',
      'restaurant.email_verification_requested', 'restaurant.status_changed', 'restaurant.updated',
      'membership.activated', 'checkout.created', 'checkout.confirmed', 'checkout.released',
      'checkout.late_payment', 'order.placed', 'order.accepted', 'order.rejected', 'order.cancelled',
      'order.preparing', 'order.ready', 'order.picked_up', 'order.out_for_delivery', 'order.delivered',
      'order.delivery_failed', 'payment.captured', 'payment.failed', 'refund.requested',
      'refund.processing', 'refund.succeeded', 'refund.failed', 'delivery.job_created',
      'delivery.assigned', 'delivery.unassigned', 'delivery.picked_up', 'delivery.started',
      'delivery.delivered', 'delivery.failed', 'delivery.exception', 'partner.status_changed',
    ];
    expect([...EventTypes].sort()).toEqual([...expected].sort());
  });

  it('maps producers and streams', () => {
    expect(eventProducer('order.placed')).toBe('orders');
    expect(eventProducer('payment.captured')).toBe('payments');
    expect(eventProducer('delivery.assigned')).toBe('delivery');
    expect(eventProducer('partner.status_changed')).toBe('delivery');
    expect(eventProducer('user.registered')).toBe('identity');
    expect(eventProducer('audit.recorded')).toBeNull();
    expect(eventStream('orders')).toBe('events.orders');
  });

  it('types payloads (compile-time check)', () => {
    const p: EventPayloads['payment.captured'] = {
      paymentIntentId: 'a', purpose: 'CHECKOUT', referenceId: 'b', userId: 'u', amountPaise: 100, providerPaymentId: 'p',
    };
    const env: EventEnvelope<'payment.captured'> = {
      id: 'x', type: 'payment.captured', version: 1, occurredAt: new Date().toISOString(),
      producer: 'payments', correlationId: 'c', aggregateId: 'a', payload: p,
    };
    expect(env.payload.amountPaise).toBe(100);
  });
});
