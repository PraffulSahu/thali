import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvents, setup, type Harness } from './helpers.js';
import { asAdmin, child, group, placedCheckout, type Agent } from './lifecycle-helpers.js';

let h: Harness;
let admin: Agent;
beforeAll(async () => {
  h = await setup('admin_actions');
  admin = await asAdmin(h);
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

const audits = async (targetId: string) => (await outboxEvents(h, 'audit.recorded')).filter((e) => e.payload.targetId === targetId);

describe('admin cancel with refund', () => {
  it('refundPaise > remaining → 422 REFUND_EXCEEDS_REMAINING (nothing changes)', async () => {
    const p = await placedCheckout(h);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 });
    const r = await admin.post(`/api/v1/admin/orders/child/${p.a.id}/cancel`, { reason: 'Rider shortage', refundPaise: p.a.total + 1 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('REFUND_EXCEEDS_REMAINING');
    expect((await child(h, p.a.id))!.status).toBe('ACCEPTED');
    expect(await audits(p.a.id)).toHaveLength(0);
    expect((await admin.post(`/api/v1/admin/orders/child/${p.a.id}/cancel`, { refundPaise: 100 })).status).toBe(400); // reason required
    expect((await admin.post(`/api/v1/admin/orders/child/${p.a.id}/cancel`, { reason: 'x', refundPaise: -1 })).status).toBe(400);
  });

  it('valid → CANCELLED + audit.recorded + order.cancelled{actor ADMIN, refundPaise}', async () => {
    const p = await placedCheckout(h);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 });
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/preparing`);
    const r = await admin.post(`/api/v1/admin/orders/child/${p.a.id}/cancel`, { reason: 'Rider shortage', refundPaise: 10_000 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CANCELLED');
    const c = await child(h, p.a.id);
    expect(c!.refundStatus).toBe('REQUESTED');
    expect(c!.statusHistory.at(-1)).toMatchObject({ from: 'PREPARING', to: 'CANCELLED', actor: 'ADMIN', actorId: admin.userId, reason: 'Rider shortage' });
    const ev = (await outboxEvents(h, 'order.cancelled')).filter((e) => e.payload.childOrderId === p.a.id);
    expect(ev.map((e) => e.payload)).toEqual([
      { childOrderId: p.a.id, checkoutId: p.checkout.id, userId: p.u.userId, restaurantId: p.s.a.id, actor: 'ADMIN', reason: 'Rider shortage', refundPaise: 10_000, fromStatus: 'PREPARING' },
    ]);
    const a = await audits(p.a.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.payload).toMatchObject({ actorId: admin.userId, actorRole: 'ADMIN', action: 'order.cancel', targetType: 'child_order', service: 'orders' });
    expect(a[0]!.payload.summary).toContain('10000');

    const timeline = await admin.get(`/api/v1/admin/orders/${p.checkout.id}`);
    expect(timeline.status).toBe(200);
    expect(timeline.body.timeline.map((t: { type: string }) => t.type)).toEqual(
      expect.arrayContaining(['checkout.confirmed', 'order.placed', 'order.accepted', 'order.preparing', 'order.cancelled']),
    );
    expect(timeline.body.checkout.children.find((x: { id: string }) => x.id === p.a.id).status).toBe('CANCELLED');
  });

  it('cancel without refund (refundPaise 0) leaves refundStatus NONE', async () => {
    const p = await placedCheckout(h);
    const r = await admin.post(`/api/v1/admin/orders/child/${p.b.id}/cancel`, { reason: 'Fraud check', refundPaise: 0 });
    expect(r.status).toBe(200);
    expect((await child(h, p.b.id))!.refundStatus).toBe('NONE');
    const ev = (await outboxEvents(h, 'order.cancelled')).find((e) => e.payload.childOrderId === p.b.id);
    expect(ev!.payload.refundPaise).toBe(0);
  });

  it('a child already partly refunded can only be refunded up to the remainder', async () => {
    const p = await placedCheckout(h);
    await h.ctx.models.ChildOrder.updateOne({ _id: p.a.id }, { $set: { refundRequestedPaise: 5000 } });
    const over = await admin.post(`/api/v1/admin/orders/child/${p.a.id}/cancel`, { reason: 'Goodwill', refundPaise: p.a.total - 4999 });
    expect(over.status).toBe(422);
    const ok = await admin.post(`/api/v1/admin/orders/child/${p.a.id}/cancel`, { reason: 'Goodwill', refundPaise: p.a.total - 5000 });
    expect(ok.status).toBe(200);
  });
});

describe('admin transition', () => {
  it('PLACED → ACCEPTED by admin (audited, order.accepted emitted)', async () => {
    const p = await placedCheckout(h);
    const r = await admin.post(`/api/v1/admin/orders/child/${p.a.id}/transition`, { to: 'ACCEPTED', reason: 'Restaurant called in', prepMinutes: 25 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ACCEPTED');
    expect((await outboxEvents(h, 'order.accepted')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(1);
    expect((await audits(p.a.id)).map((a) => a.payload.action)).toEqual(['order.transition']);
  });

  it('transition to CANCELLED needs refundPaise; reason always required', async () => {
    const p = await placedCheckout(h);
    expect((await admin.post(`/api/v1/admin/orders/child/${p.a.id}/transition`, { to: 'CANCELLED', reason: 'x' })).status).toBe(400);
    expect((await admin.post(`/api/v1/admin/orders/child/${p.a.id}/transition`, { to: 'REJECTED' })).status).toBe(400);
    const rej = await admin.post(`/api/v1/admin/orders/child/${p.a.id}/transition`, { to: 'REJECTED', reason: 'Restaurant unreachable' });
    expect(rej.status).toBe(200);
    const ev = (await outboxEvents(h, 'order.rejected')).find((e) => e.payload.childOrderId === p.a.id);
    expect(ev!.payload.refundPaise).toBe(p.a.total);
  });
});

describe('admin search / overview', () => {
  it('finds by child code, checkout code, status and restaurant; overview counts', async () => {
    const p = await placedCheckout(h);
    const byCode = await admin.get(`/api/v1/admin/orders?q=${p.a.code}`);
    expect(byCode.status).toBe(200);
    expect(byCode.body.items.map((i: { id: string }) => i.id)).toEqual([p.a.id]);
    expect(byCode.body.items[0]).toMatchObject({ checkoutId: p.checkout.id, code: p.a.code, restaurantName: 'Spice Route', userId: p.u.userId });
    const byCheckout = await admin.get(`/api/v1/admin/orders?q=${p.checkout.code}`);
    expect(byCheckout.body.items.map((i: { id: string }) => i.id).sort()).toEqual([p.a.id, p.b.id].sort());
    const byRestaurant = await admin.get(`/api/v1/admin/orders?restaurantId=${p.s.b.id}&status=PLACED`);
    expect(byRestaurant.body.items.map((i: { id: string }) => i.id)).toEqual([p.b.id]);
    const byPhone = await admin.get(`/api/v1/admin/orders?phone=9876543210&restaurantId=${p.s.a.id}`);
    expect(byPhone.body.items.map((i: { id: string }) => i.id)).toEqual([p.a.id]);

    const ov = await admin.get('/api/v1/admin/orders/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.activeByStatus.PLACED).toBeGreaterThanOrEqual(2);
    expect(typeof ov.body.today.placed).toBe('number');
    expect(typeof ov.body.today.gmvPaise).toBe('number');
    expect(typeof ov.body.awaitingAcceptance).toBe('number');
    expect(typeof ov.body.refundsPending).toBe('number');
    expect((await group(h, p.checkout.id))!.status).toBe('PAID_PLACED');
  });
});
