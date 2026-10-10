import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subscribeRealtime } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { outboxEvents, setup, type Harness } from './helpers.js';
import { child, group, placedCheckout } from './lifecycle-helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('owner_orders');
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

describe('owner order list / detail', () => {
  it('owner sees only their own restaurant children; restaurant view hides the customer delivery code', async () => {
    const p = await placedCheckout(h);
    const list = await p.ownerA.get('/api/v1/owner/orders');
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([p.a.id]);
    const item = list.body.items[0];
    expect(item).toMatchObject({ id: p.a.id, code: p.a.code, restaurantId: p.s.a.id, status: 'PLACED', pickupCode: p.a.pickupCode });
    expect(item.customer).toEqual({ name: 'Asha Rao', phoneMasked: '+91******3210' });
    expect(item.deliveryCode).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain(`"${p.a.deliveryCode}"`);
    expect(list.body.nextCursor).toBeNull();

    const listB = await p.ownerB.get(`/api/v1/owner/orders?status=PLACED&restaurantId=${p.s.b.id}`);
    expect(listB.body.items.map((i: { id: string }) => i.id)).toEqual([p.b.id]);
    // filtering by someone else's restaurant yields nothing (never their orders)
    const cross = await p.ownerB.get(`/api/v1/owner/orders?restaurantId=${p.s.a.id}`);
    expect(cross.status).toBe(200);
    expect(cross.body.items).toEqual([]);

    const detail = await p.ownerA.get(`/api/v1/owner/orders/${p.a.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.lines).toHaveLength(1);
    expect(detail.body.breakdown.totalPaise).toBe(p.a.total);
  });

  it('paginates with a cursor', async () => {
    const p1 = await placedCheckout(h);
    const p2 = await placedCheckout(h);
    // give owner A of p1 a second order (p2's A child) so there are two pages
    await h.ctx.models.ChildOrder.updateOne({ _id: p2.a.id }, { $set: { restaurantOwnerId: p1.s.a.ownerUserId } });
    const page1 = await p1.ownerA.get('/api/v1/owner/orders?limit=1');
    expect(page1.body.items.map((i: { id: string }) => i.id)).toEqual([p2.a.id]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await p1.ownerA.get(`/api/v1/owner/orders?limit=1&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((i: { id: string }) => i.id)).toEqual([p1.a.id]);
    expect(page2.body.nextCursor).toBeNull();
  });
});

describe('accept / reject / preparing / ready', () => {
  it('accept with prepMinutes 4 → 400; 20 → ACCEPTED with readyEta and order.accepted carrying pickup/drop/codes', async () => {
    const p = await placedCheckout(h);
    const bad = await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 4 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect((await child(h, p.a.id))!.status).toBe('PLACED');

    const messages: { event: string; data: { childOrderId: string; status: string; restaurantId: string } }[] = [];
    const sub = await subscribeRealtime(h.tr.redis, [`owner:${p.s.a.ownerUserId}`], (_c, m) => messages.push(m as never));
    try {
      const t0 = Date.now();
      const ok = await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('ACCEPTED');
      expect(ok.body.prepMinutes).toBe(20);
      const readyEta = new Date(ok.body.readyEta).getTime();
      expect(readyEta - t0).toBeGreaterThanOrEqual(20 * 60_000 - 1000);
      expect(readyEta - t0).toBeLessThan(20 * 60_000 + 5000);

      const c = await child(h, p.a.id);
      expect(c!.acceptedAt).toBeInstanceOf(Date);
      expect(c!.statusHistory.at(-1)).toMatchObject({ from: 'PLACED', to: 'ACCEPTED', actor: 'RESTAURANT', actorId: p.s.a.ownerUserId });

      const ev = (await outboxEvents(h, 'order.accepted')).filter((e) => e.payload.childOrderId === p.a.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload).toEqual({
        childOrderId: p.a.id,
        checkoutId: p.checkout.id,
        userId: p.u.userId,
        restaurantId: p.s.a.id,
        prepMinutes: 20,
        pickup: {
          name: 'Spice Route',
          address: '1 MG Road, Bengaluru, 560001',
          location: { type: 'Point', coordinates: [77.59, 12.97] },
        },
        drop: {
          name: 'Asha Rao',
          address: '42 Residency Rd, Bengaluru, 560025',
          location: { type: 'Point', coordinates: [77.5946, 12.9716] },
          phoneMasked: '+91******3210',
        },
        pickupCode: p.a.pickupCode,
        deliveryCode: p.a.deliveryCode,
      });
      expect((await group(h, p.checkout.id))!.status).toBe('IN_PROGRESS');
      await waitFor(() => messages.some((m) => m.event === 'owner.order' && m.data.status === 'ACCEPTED'));
      expect(messages.find((m) => m.data.status === 'ACCEPTED')!.data).toEqual({ childOrderId: p.a.id, restaurantId: p.s.a.id, status: 'ACCEPTED' });
    } finally {
      await sub.close();
    }
  });

  it('reject without a reason → 400; with a reason → REJECTED + refund requested', async () => {
    const p = await placedCheckout(h);
    expect((await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/reject`, {})).status).toBe(400);
    expect((await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/reject`, { reason: '   ' })).status).toBe(400);
    const ok = await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/reject`, { reason: 'Kitchen closed early' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('REJECTED');
    const c = await child(h, p.b.id);
    expect(c!.rejectionReason).toBe('Kitchen closed early');
    expect(c!.refundStatus).toBe('REQUESTED');
  });

  it('preparing → ready (events + readyAt); prep-time update moves readyEta', async () => {
    const p = await placedCheckout(h);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 15 });
    const prep = await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/preparing`);
    expect(prep.status).toBe(200);
    expect(prep.body.status).toBe('PREPARING');

    const t0 = Date.now();
    const pt = await p.ownerA.patch(`/api/v1/owner/orders/${p.a.id}/prep-time`, { prepMinutes: 30 });
    expect(pt.status).toBe(200);
    expect(pt.body.prepMinutes).toBe(30);
    expect(new Date(pt.body.readyEta).getTime() - t0).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
    expect((await p.ownerA.patch(`/api/v1/owner/orders/${p.a.id}/prep-time`, { prepMinutes: 200 })).status).toBe(400);

    const ready = await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('READY_FOR_PICKUP');
    const c = await child(h, p.a.id);
    expect(c!.readyAt).toBeInstanceOf(Date);
    expect((await outboxEvents(h, 'order.preparing')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(1);
    const readyEv = (await outboxEvents(h, 'order.ready')).filter((e) => e.payload.childOrderId === p.a.id);
    expect(readyEv.map((e) => e.payload)).toEqual([{ childOrderId: p.a.id, restaurantId: p.s.a.id, userId: p.u.userId }]);

    // prep time can no longer change once ready
    expect((await p.ownerA.patch(`/api/v1/owner/orders/${p.a.id}/prep-time`, { prepMinutes: 10 })).status).toBe(409);
  });

  it('ready directly from ACCEPTED is allowed (LLD §4.1)', async () => {
    const p = await placedCheckout(h);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 10 });
    const ready = await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('READY_FOR_PICKUP');
  });
});

describe('owner stats', () => {
  it('counts the owner restaurant orders in the window', async () => {
    const p = await placedCheckout(h);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 10 });
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const r = await p.ownerA.get(`/api/v1/owner/orders/stats?restaurantId=${p.s.a.id}&from=${from}&to=${to}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ restaurantId: p.s.a.id, from, to, ordersTotal: 1, acceptanceRate: 1 });
    expect(r.body.byStatus.ACCEPTED).toBe(1);
    expect(typeof r.body.avgAcceptSeconds).toBe('number');
    // another owner asking about A's restaurant sees nothing of A's
    const other = await p.ownerB.get(`/api/v1/owner/orders/stats?restaurantId=${p.s.a.id}&from=${from}&to=${to}`);
    expect(other.status).toBe(200);
    expect(other.body.ordersTotal).toBe(0);
  });
});
