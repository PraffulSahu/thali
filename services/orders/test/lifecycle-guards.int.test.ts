/** Unauthorized / out-of-order state changes are rejected by the backend (PRD §4.5). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvents, setup, type Harness } from './helpers.js';
import { asAdmin, child, placedCheckout } from './lifecycle-helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('lifecycle_guards');
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

describe('lifecycle guards', () => {
  it('owner POST ready on a PLACED child → 409 ORDER_INVALID_TRANSITION, nothing emitted', async () => {
    const p = await placedCheckout(h);
    const r = await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/ready`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ORDER_INVALID_TRANSITION');
    expect(r.body.error.details).toMatchObject({ from: 'PLACED', to: 'READY_FOR_PICKUP', actor: 'RESTAURANT' });
    expect((await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/preparing`)).status).toBe(409);
    expect((await child(h, p.a.id))!.status).toBe('PLACED');
    expect((await outboxEvents(h, 'order.ready')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(0);
  });

  it('owner cannot drive the admin transition route (403); admin cannot force SYSTEM-only transitions (409)', async () => {
    const p = await placedCheckout(h);
    const owner = await p.ownerA.post(`/api/v1/admin/orders/child/${p.a.id}/transition`, { to: 'DELIVERED', reason: 'done' });
    expect(owner.status).toBe(403);
    const admin = await asAdmin(h);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 });
    const forced = await admin.post(`/api/v1/admin/orders/child/${p.a.id}/transition`, { to: 'DELIVERED', reason: 'skip ahead' });
    expect(forced.status).toBe(409);
    expect(forced.body.error.code).toBe('ORDER_INVALID_TRANSITION');
    const picked = await admin.post(`/api/v1/admin/orders/child/${p.a.id}/transition`, { to: 'PICKED_UP', reason: 'skip ahead' });
    expect(picked.status).toBe(409);
    expect((await child(h, p.a.id))!.status).toBe('ACCEPTED');
  });

  it('customer cannot cancel once the restaurant accepted (409)', async () => {
    const p = await placedCheckout(h);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 });
    const r = await p.u.post(`/api/v1/orders/child/${p.a.id}/cancel`, { reason: 'changed my mind' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ORDER_INVALID_TRANSITION');
    expect((await child(h, p.a.id))!.status).toBe('ACCEPTED');
    expect((await outboxEvents(h, 'order.cancelled')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(0);
  });

  it('accept / reject after acceptBy → 409 ORDER_ACCEPT_WINDOW_EXPIRED', async () => {
    const p = await placedCheckout(h);
    await h.ctx.models.ChildOrder.updateOne({ _id: p.a.id }, { $set: { acceptBy: new Date(Date.now() - 1000) } });
    const r = await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ORDER_ACCEPT_WINDOW_EXPIRED');
    const rj = await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/reject`, { reason: 'late' });
    expect(rj.body.error.code).toBe('ORDER_ACCEPT_WINDOW_EXPIRED');
    expect((await child(h, p.a.id))!.status).toBe('PLACED');
  });

  it('double accept → 409; acting on terminal children → 409', async () => {
    const p = await placedCheckout(h);
    expect((await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 })).status).toBe(200);
    expect((await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 })).status).toBe(409);
    await p.u.post(`/api/v1/orders/child/${p.b.id}/cancel`, {});
    expect((await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/accept`, { prepMinutes: 20 })).status).toBe(409);
    expect((await p.u.post(`/api/v1/orders/child/${p.b.id}/cancel`, {})).status).toBe(409);
  });

  it('concurrent accept + customer cancel: exactly one wins', async () => {
    const p = await placedCheckout(h);
    const [acc, can] = await Promise.all([
      p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 }),
      p.u.post(`/api/v1/orders/child/${p.a.id}/cancel`, {}),
    ]);
    expect([acc.status, can.status].sort()).toEqual([200, 409]);
    const c = await child(h, p.a.id);
    expect(['ACCEPTED', 'CANCELLED']).toContain(c!.status);
    expect(c!.statusHistory.filter((s) => s.from === 'PLACED')).toHaveLength(1);
  });
});
