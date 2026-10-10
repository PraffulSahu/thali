import { describe, expect, it } from 'vitest';
import { EVENT_STREAMS, NotificationStatus, enumValues, eventStream, type EventPayloads } from '@thali/contracts';
import { DEMO_CHECKOUTS, demoOrderIds, demoRefundPaise } from '@thali/contracts/seed-demo';

describe('Task 15 contract additions', () => {
  it('events.notifications is a known stream (notifications publishes audit.recorded)', () => {
    expect(EVENT_STREAMS.notifications).toBe('events.notifications');
    expect(eventStream('notifications')).toBe('events.notifications');
  });

  it('NotificationStatus includes the terminal SKIPPED', () => {
    expect(enumValues(NotificationStatus)).toContain('SKIPPED');
  });

  it('order.rejected / order.cancelled carry an optional fromStatus', () => {
    const rejected: EventPayloads['order.rejected'] = { childOrderId: 'c', checkoutId: 'k', userId: 'u', restaurantId: 'r', reason: 'x', refundPaise: 1, fromStatus: 'PLACED' };
    const legacy: EventPayloads['order.cancelled'] = { childOrderId: 'c', checkoutId: 'k', userId: 'u', restaurantId: 'r', actor: 'CUSTOMER', reason: 'x', refundPaise: 1 };
    expect(rejected.fromStatus).toBe('PLACED');
    expect(legacy.fromStatus).toBeUndefined();
  });
});

describe('demo order fixture (seed-demo)', () => {
  it('children add up to the checkout totals and refunds match the outcome', () => {
    for (const co of DEMO_CHECKOUTS) {
      for (const k of Object.keys(co.totals) as (keyof typeof co.totals)[]) {
        expect(co.children.reduce((s, c) => s + c.breakdown[k], 0), `${co.code} ${k}`).toBe(co.totals[k]);
      }
      const refunded = co.children.reduce((s, c) => s + demoRefundPaise(c), 0);
      expect(co.paymentStatus).toBe(refunded === 0 ? 'CAPTURED' : refunded === co.totals.totalPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED');
    }
    const multi = DEMO_CHECKOUTS.find((c) => c.code === 'TH-DEMOMULTI')!;
    expect(multi.children.map((c) => c.outcome.kind)).toEqual(['DELIVERED', 'REJECTED']);
  });

  it('ids are deterministic and distinct', () => {
    const all = DEMO_CHECKOUTS.flatMap((co) => [demoOrderIds.checkout(co), demoOrderIds.intent(co), ...co.children.map((c) => demoOrderIds.child(co, c))]);
    expect(new Set(all).size).toBe(all.length);
    expect(all.every((id) => /^[0-9a-f]{24}$/.test(id))).toBe(true);
  });
});
