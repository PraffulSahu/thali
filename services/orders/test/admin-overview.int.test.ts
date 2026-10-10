/**
 * ORD-2: admin overview additions — today's child status cohort, refunded / refund-pending today,
 * support ticket counts (own DB so the counts are exact).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Harness } from './helpers.js';
import { asAdmin, placedCheckout, type Agent } from './lifecycle-helpers.js';

let h: Harness;
let admin: Agent;
beforeAll(async () => {
  h = await setup('admin_overview');
  admin = await asAdmin(h, { adm: ['OPS'] });
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

describe('GET /admin/orders/overview (ORD-2)', () => {
  it('today.byStatus, refundedPaise, refundPendingPaise and support counts', async () => {
    const empty = await admin.get('/api/v1/admin/orders/overview');
    expect(empty.status).toBe(200);
    expect(Object.keys(empty.body.today.byStatus)).toHaveLength(13);
    expect(empty.body.today).toMatchObject({ refundedPaise: 0, refundPendingPaise: 0 });
    expect(empty.body.support).toEqual({ open: 0, inProgress: 0 });

    const p = await placedCheckout(h);
    const q = await placedCheckout(h);
    await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/reject`, { reason: 'Out of stock' });
    await q.ownerA.post(`/api/v1/owner/orders/${q.a.id}/accept`, { prepMinutes: 15 });

    const ov = (await admin.get('/api/v1/admin/orders/overview')).body;
    expect(ov.today.byStatus).toMatchObject({ PLACED: 2, ACCEPTED: 1, REJECTED: 1, DELIVERED: 0 });
    expect(ov.today.placed).toBe(4);
    expect(ov.today.refundPendingPaise).toBe(p.b.total);
    expect(ov.today.refundedPaise).toBe(0);

    // payments reports the refund done today (+ an old refund on another child that must not count)
    const now = new Date();
    await h.ctx.models.ChildOrder.updateOne(
      { _id: p.b.id },
      {
        $set: {
          refundStatus: 'SUCCEEDED',
          refundedPaise: p.b.total,
          refunds: [{ refundId: 'rf_1', amountPaise: p.b.total, reason: 'RESTAURANT_REJECTED', status: 'SUCCEEDED', updatedAt: now }],
        },
      },
    );
    await h.ctx.models.ChildOrder.updateOne(
      { _id: q.b.id },
      { $set: { refunds: [{ refundId: 'rf_old', amountPaise: 999, reason: 'ADMIN', status: 'SUCCEEDED', updatedAt: new Date(now.getTime() - 3 * 86_400_000) }] } },
    );
    const after = (await admin.get('/api/v1/admin/orders/overview')).body;
    expect(after.today.refundedPaise).toBe(p.b.total);
    expect(after.today.refundPendingPaise).toBe(0);

    const t1 = await p.u.post('/api/v1/support/tickets', { subject: 'Missing dosa', category: 'ORDER_ISSUE', body: 'Where is it?', childOrderId: p.b.id });
    const t2 = await q.u.post('/api/v1/support/tickets', { subject: 'Payment', category: 'PAYMENT', body: 'Charged twice?' });
    expect(t1.status).toBe(201);
    expect(t2.status).toBe(201);
    await h.ctx.models.SupportTicket.updateOne({ _id: t2.body.id }, { $set: { status: 'IN_PROGRESS' } });
    expect((await admin.get('/api/v1/admin/orders/overview')).body.support).toEqual({ open: 1, inProgress: 1 });
  });

  it('has the gap-analysis §5.2.9 child_orders indexes', async () => {
    const keys = (await h.ctx.models.ChildOrder.collection.indexes()).map((i) => JSON.stringify(i.key));
    for (const k of [{ placedAt: 1 }, { deliveredAt: 1 }, { refundStatus: 1 }, { restaurantId: 1, placedAt: -1 }, { createdAt: -1, _id: -1 }, { 'customerContact.phoneLast4': 1 }]) {
      expect(keys).toContain(JSON.stringify(k));
    }
    const groupKeys = (await h.ctx.models.CheckoutGroup.collection.indexes()).map((i) => JSON.stringify(i.key));
    for (const k of [{ placedAt: -1, _id: -1 }, { status: 1, placedAt: -1 }, { 'customerContact.phoneLast4': 1 }]) expect(groupKeys).toContain(JSON.stringify(k));
  });
});
