/**
 * ORD-5: `delivery.arrived` (partner at the restaurant) → child `deliveryStatus = 'AT_PICKUP'`,
 * `order_events` row, realtime `owner.order` + `order.updated`; idempotent and stale-safe.
 */
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnvelope, streamKey, subscribeRealtime, type ConsumerHandle } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { startOrdersConsumers } from '../src/events/index.js';
import { oid, publishEvent, setup, type Harness } from './helpers.js';
import { child, placedCheckout, processed } from './lifecycle-helpers.js';

let h: Harness;
let consumers: ConsumerHandle[];
beforeAll(async () => {
  h = await setup('delivery_arrived');
  consumers = startOrdersConsumers(h.ctx, { backoffBaseMs: 20, maxBackoffMs: 200, claimIdleMs: 300, blockMs: 100 });
  await Promise.all(consumers.map((c) => c.ready));
}, 120_000);
afterAll(async () => {
  await Promise.all(consumers.map((c) => c.stop()));
  await h.cleanup();
});

const timelineOf = (childId: string, type: string) => h.db.conn.collection('order_events').countDocuments({ childOrderId: new Types.ObjectId(childId), type });

describe('delivery.arrived', () => {
  it('assigned → arrived: AT_PICKUP mirror, timeline row, owner.order + order.updated; duplicate is a no-op', async () => {
    const p = await placedCheckout(h);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 15 });
    const jobId = oid();
    const partnerUserId = oid();
    const assigned = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.assigned', {
      jobId,
      childOrderId: p.a.id,
      partnerId: oid(),
      partnerUserId,
      partnerName: 'Ravi Kumar',
      vehicle: { type: 'SCOOTER', registrationNumber: 'KA03HX4417' },
    });
    await processed(h, assigned.id);

    const messages: { channel: string; event: string; data: Record<string, unknown> }[] = [];
    const sub = await subscribeRealtime(h.tr.redis, [`owner:${p.s.a.ownerUserId}`, `user:${p.u.userId}`], (channel, m) =>
      messages.push({ channel, ...(m as { event: string; data: Record<string, unknown> }) }),
    );
    try {
      const arrived = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.arrived', {
        jobId,
        childOrderId: p.a.id,
        partnerUserId,
        at: new Date().toISOString(),
      });
      await processed(h, arrived.id);
      const c = await child(h, p.a.id);
      expect(c!.deliveryStatus).toBe('AT_PICKUP');
      expect(c!.status).toBe('ACCEPTED');
      expect(c!.partner).toMatchObject({ name: 'Ravi Kumar' });
      expect(await timelineOf(p.a.id, 'delivery.arrived')).toBe(1);

      await waitFor(() => messages.some((m) => m.event === 'owner.order') && messages.some((m) => m.event === 'order.updated' && m.data.deliveryStatus === 'AT_PICKUP'));
      expect(messages.find((m) => m.event === 'owner.order')!.data).toEqual({ childOrderId: p.a.id, restaurantId: p.s.a.id, status: 'ACCEPTED' });

      // owner sees it on the live order card
      const view = await p.ownerA.get(`/api/v1/owner/orders/${p.a.id}`);
      expect(view.body.deliveryStatus).toBe('AT_PICKUP');

      // a re-published copy (new event id) changes nothing
      const again = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.arrived', { jobId, childOrderId: p.a.id, partnerUserId, at: new Date().toISOString() });
      await processed(h, again.id);
      expect(await timelineOf(p.a.id, 'delivery.arrived')).toBe(1);
    } finally {
      await sub.close();
    }
  });

  it('ignored after pickup, for another job, or when older than the last mirror update', async () => {
    const p = await placedCheckout(h);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 15 });
    const jobId = oid();
    const partnerUserId = oid();
    const picked = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.picked_up', { jobId, childOrderId: p.a.id, partnerUserId, at: new Date().toISOString() });
    await processed(h, picked.id);
    const late = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.arrived', { jobId, childOrderId: p.a.id, partnerUserId, at: new Date().toISOString() });
    await processed(h, late.id);
    expect((await child(h, p.a.id))!.deliveryStatus).toBe('PICKED_UP');

    // other job id
    await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/accept`, { prepMinutes: 15 });
    await h.ctx.models.ChildOrder.updateOne({ _id: p.b.id }, { $set: { deliveryJobId: jobId, deliveryStatus: 'ASSIGNED', deliveryUpdatedAt: new Date() } });
    const other = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.arrived', { jobId: oid(), childOrderId: p.b.id, partnerUserId, at: new Date().toISOString() });
    await processed(h, other.id);
    expect((await child(h, p.b.id))!.deliveryStatus).toBe('ASSIGNED');

    // stale (occurredAt before the last mirror update)
    const env = createEnvelope('delivery.arrived', { jobId, childOrderId: p.b.id, partnerUserId, at: new Date(0).toISOString() }, {
      producer: 'delivery',
      aggregateId: 'agg',
      occurredAt: new Date(Date.now() - 60_000),
    });
    await h.tr.redis.xadd(streamKey(h.tr.prefix, 'events.delivery'), '*', 'data', JSON.stringify(env));
    await processed(h, env.id);
    expect((await child(h, p.b.id))!.deliveryStatus).toBe('ASSIGNED');
    expect(await timelineOf(p.b.id, 'delivery.arrived')).toBe(0);
  });
});
