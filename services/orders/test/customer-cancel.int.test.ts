import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvents, setup, type Harness } from './helpers.js';
import { child, group, placedCheckout, rupees } from './lifecycle-helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('customer_cancel');
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

describe('customer cancel', () => {
  it('PLACED → CANCELLED with a refund event for the full child total; parent re-derived', async () => {
    const p = await placedCheckout(h);
    const r = await p.u.post(`/api/v1/orders/child/${p.a.id}/cancel`, { reason: 'Ordered by mistake' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CANCELLED');
    expect(r.body.refundStatus).toBe('REQUESTED');

    const c = await child(h, p.a.id);
    expect(c!.cancelledAt).toBeInstanceOf(Date);
    expect(c!.cancellationReason).toBe('Ordered by mistake');
    expect(c!.statusHistory.at(-1)).toMatchObject({ from: 'PLACED', to: 'CANCELLED', actor: 'CUSTOMER', actorId: p.u.userId });

    const ev = (await outboxEvents(h, 'order.cancelled')).filter((e) => e.payload.childOrderId === p.a.id);
    expect(ev.map((e) => e.payload)).toEqual([
      {
        childOrderId: p.a.id,
        checkoutId: p.checkout.id,
        userId: p.u.userId,
        restaurantId: p.s.a.id,
        actor: 'CUSTOMER',
        reason: 'Ordered by mistake',
        refundPaise: p.a.total,
        fromStatus: 'PLACED',
      },
    ]);
    expect((await group(h, p.checkout.id))!.status).toBe('IN_PROGRESS');

    const view = await p.u.get(`/api/v1/orders/${p.checkout.id}`);
    expect(view.body.explanations).toEqual([
      expect.objectContaining({
        childOrderId: p.a.id,
        kind: 'CANCELLED',
        refundStatus: 'REQUESTED',
        refundPaise: p.a.total,
        message: `You cancelled your Spice Route order. ${rupees(p.a.total)} refund initiated.`,
      }),
    ]);

    // cancelling the other child too → every child terminal, none delivered → CANCELLED
    const r2 = await p.u.post(`/api/v1/orders/child/${p.b.id}/cancel`);
    expect(r2.status).toBe(200);
    expect((await group(h, p.checkout.id))!.status).toBe('CANCELLED');
    const view2 = await p.u.get(`/api/v1/orders/${p.checkout.id}`);
    expect(view2.body.adjustedTotals).toEqual({
      paidPaise: p.checkout.pricing.totalPaise,
      refundedPaise: 0,
      refundPendingPaise: p.checkout.pricing.totalPaise,
      netPaise: p.checkout.pricing.totalPaise,
    });
  });

  it('order history lists the checkout with child summaries', async () => {
    const p = await placedCheckout(h);
    const list = await p.u.get('/api/v1/orders');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: p.checkout.id, code: p.checkout.code, status: 'PAID_PLACED', totalPaise: p.checkout.pricing.totalPaise });
    expect(list.body.items[0].children.map((c: { id: string }) => c.id).sort()).toEqual([p.a.id, p.b.id].sort());
    expect(list.body.items[0].adjustedTotals.netPaise).toBe(p.checkout.pricing.totalPaise);
  });
});
