import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsumerHandle } from '@thali/service-kit';
import { startOrdersConsumers } from '../src/events/index.js';
import { oid, publishEvent, setup, type Harness } from './helpers.js';
import { placedCheckout, processed } from './lifecycle-helpers.js';

let h: Harness;
let consumers: ConsumerHandle[];
beforeAll(async () => {
  h = await setup('internal_orders');
  consumers = startOrdersConsumers(h.ctx, { backoffBaseMs: 20, maxBackoffMs: 200, claimIdleMs: 300, blockMs: 100 });
  await Promise.all(consumers.map((c) => c.ready));
}, 120_000);
afterAll(async () => {
  await Promise.all(consumers.map((c) => c.stop()));
  await h.cleanup();
});

const internalGet = async (path: string, from: 'marketplace' | 'notifications' | 'identity' | 'payments' = 'marketplace') =>
  request(h.app).get(path).set('authorization', `Bearer ${await h.internalToken(from)}`);

describe('GET /internal/orders/child/:id', () => {
  it('returns the binding shape; 404 unknown; requires a service token', async () => {
    const p = await placedCheckout(h);
    const r = await internalGet(`/internal/orders/child/${p.a.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      id: p.a.id,
      code: p.a.code,
      checkoutGroupId: p.checkout.id,
      checkoutCode: p.checkout.code,
      userId: p.u.userId,
      restaurantId: p.s.a.id,
      restaurantOwnerId: p.s.a.ownerUserId,
      status: 'PLACED',
      deliveredAt: null,
      totalPaise: p.a.total,
      committedRefundPaise: 0,
    });
    // payments uses it to cap manual refunds per child
    expect((await internalGet(`/internal/orders/child/${p.a.id}`, 'payments')).status).toBe(200);
    expect((await internalGet(`/internal/orders/child/${p.a.id}`, 'notifications')).status).toBe(200);
    expect((await internalGet(`/internal/orders/child/${oid()}`)).status).toBe(404);
    expect((await internalGet('/internal/orders/child/not-an-id')).status).toBe(404);
    expect((await request(h.app).get(`/internal/orders/child/${p.a.id}`)).status).toBe(401);
    expect((await internalGet(`/internal/orders/child/${p.a.id}`, 'identity')).status).toBe(403);
  });
});

describe('GET /internal/orders/stats', () => {
  it('computes counts, acceptance rate, avg accept time, gross and net revenue from stored records', async () => {
    const p1 = await placedCheckout(h);
    const p2 = await placedCheckout(h);
    const p3 = await placedCheckout(h);
    // put every A child on p1's restaurant so stats aggregate them
    const rid = p1.s.a.id;
    await h.ctx.models.ChildOrder.updateMany(
      { _id: { $in: [p2.a.id, p3.a.id] } },
      { $set: { restaurantId: rid, restaurantOwnerId: p1.s.a.ownerUserId } },
    );
    const owner = p1.ownerA;
    await owner.post(`/api/v1/owner/orders/${p1.a.id}/accept`, { prepMinutes: 10 });
    await owner.post(`/api/v1/owner/orders/${p2.a.id}/reject`, { reason: 'Busy' });
    await owner.post(`/api/v1/owner/orders/${p3.a.id}/accept`, { prepMinutes: 10 });
    // p1.a delivered
    const jobId = oid();
    const pu = oid();
    const e = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.delivered', { jobId, childOrderId: p1.a.id, partnerUserId: pu, at: new Date().toISOString(), distanceKm: 2 });
    await processed(h, e.id);

    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const r = await internalGet(`/internal/orders/stats?restaurantId=${rid}&from=${from}&to=${to}`);
    expect(r.status).toBe(200);
    const delivered = (await h.ctx.models.ChildOrder.findById(p1.a.id).lean())!;
    const b = delivered.breakdown;
    const gross = b.itemsSubtotalPaise + b.packagingFeePaise;
    const commission = Math.floor((b.itemsSubtotalPaise * 1800 + 5000) / 10000);
    expect(r.body).toMatchObject({
      restaurantId: rid,
      from,
      to,
      ordersTotal: 3,
      acceptanceRate: 2 / 3,
      grossPaise: gross,
      netRevenuePaise: b.itemsSubtotalPaise - b.couponDiscountPaise - b.membershipDiscountPaise + b.packagingFeePaise - commission,
    });
    expect(r.body.byStatus).toMatchObject({ DELIVERED: 1, REJECTED: 1, ACCEPTED: 1, PLACED: 0, AWAITING_PAYMENT: 0 });
    expect(Object.keys(r.body.byStatus)).toHaveLength(13);
    expect(r.body.avgAcceptSeconds).toBeGreaterThanOrEqual(0);

    const empty = await internalGet(`/internal/orders/stats?restaurantId=${oid()}&from=${from}&to=${to}`);
    expect(empty.body).toMatchObject({ ordersTotal: 0, acceptanceRate: null, avgAcceptSeconds: null, grossPaise: 0, netRevenuePaise: 0 });
    expect((await internalGet(`/internal/orders/stats?restaurantId=${rid}&from=nope&to=${to}`)).status).toBe(400);
  });
});
