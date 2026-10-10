import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnvelope, streamKey, type ConsumerHandle } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { startOrdersConsumers } from '../src/events/index.js';
import { oid, outboxEvents, publishEvent, setup, type Harness } from './helpers.js';
import { asAdmin, child, group, placedCheckout, processed, type Placed } from './lifecycle-helpers.js';

let h: Harness;
let consumers: ConsumerHandle[];
beforeAll(async () => {
  h = await setup('delivery_events');
  consumers = startOrdersConsumers(h.ctx, { backoffBaseMs: 20, maxBackoffMs: 200, claimIdleMs: 300, blockMs: 100 });
  await Promise.all(consumers.map((c) => c.ready));
}, 120_000);
afterAll(async () => {
  await Promise.all(consumers.map((c) => c.stop()));
  await h.cleanup();
});

async function send<T extends 'delivery.assigned' | 'delivery.picked_up' | 'delivery.started' | 'delivery.delivered' | 'delivery.failed' | 'delivery.unassigned'>(
  type: T,
  payload: Parameters<typeof publishEvent<T>>[4],
) {
  const e = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', type, payload);
  await processed(h, e.id);
  return e;
}

async function acceptedA(p: Placed, prepare = true) {
  await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 15 });
  if (prepare) await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/preparing`);
}

const at = () => new Date().toISOString();

/** Publish a delivery event with an explicit envelope occurredAt (out-of-order scenarios). */
async function sendAt<T extends 'delivery.assigned' | 'delivery.unassigned' | 'delivery.delivered'>(
  type: T,
  payload: Parameters<typeof publishEvent<T>>[4],
  occurredAt: Date,
) {
  const env = createEnvelope(type, payload, { producer: 'delivery', aggregateId: 'agg', occurredAt });
  await h.tr.redis.xadd(streamKey(h.tr.prefix, 'events.delivery'), '*', 'data', JSON.stringify(env));
  await processed(h, env.id);
}

describe('delivery events → child transitions', () => {
  it('assigned stores the job; picked_up while PREPARING → PICKED_UP; delivered while PICKED_UP → two entries ending DELIVERED', async () => {
    const p = await placedCheckout(h);
    await acceptedA(p);
    const jobId = oid();
    const partnerUserId = oid();
    await send('delivery.assigned', {
      jobId,
      childOrderId: p.a.id,
      partnerId: oid(),
      partnerUserId,
      partnerName: 'Ravi Kumar',
      vehicle: { type: 'SCOOTER', registrationNumber: 'KA05XY9876' },
    });
    let c = await child(h, p.a.id);
    expect(c!.deliveryJobId).toBe(jobId);
    expect(c!.deliveryStatus).toBe('ASSIGNED');
    expect(c!.partner).toMatchObject({ partnerUserId, name: 'Ravi Kumar', vehicle: { type: 'SCOOTER' } });
    expect(c!.status).toBe('PREPARING');

    await send('delivery.picked_up', { jobId, childOrderId: p.a.id, partnerUserId, at: at() });
    c = await child(h, p.a.id);
    expect(c!.status).toBe('PICKED_UP');
    expect(c!.pickedUpAt).toBeInstanceOf(Date);
    expect(c!.statusHistory.at(-1)).toMatchObject({ from: 'PREPARING', to: 'PICKED_UP', actor: 'SYSTEM' });
    expect((await outboxEvents(h, 'order.picked_up')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(1);

    const delivered = await send('delivery.delivered', { jobId, childOrderId: p.a.id, partnerUserId, at: at(), distanceKm: 2.75 });
    c = await child(h, p.a.id);
    expect(c!.status).toBe('DELIVERED');
    expect(c!.deliveredAt).toBeInstanceOf(Date);
    expect(c!.statusHistory.slice(-2).map((s) => [s.from, s.to])).toEqual([
      ['PICKED_UP', 'OUT_FOR_DELIVERY'],
      ['OUT_FOR_DELIVERY', 'DELIVERED'],
    ]);
    expect((await outboxEvents(h, 'order.out_for_delivery')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(1);
    const d = (await outboxEvents(h, 'order.delivered')).filter((e) => e.payload.childOrderId === p.a.id);
    expect(d).toHaveLength(1);
    expect(d[0]!.payload).toEqual({
      childOrderId: p.a.id,
      checkoutId: p.checkout.id,
      userId: p.u.userId,
      restaurantId: p.s.a.id,
      restaurantOwnerId: p.s.a.ownerUserId,
      breakdown: c!.breakdown,
      commissionBps: 1800,
      deliveryJobId: jobId,
      partnerUserId,
      deliveryDistanceKm: 2.75,
    });

    // duplicates: exact redelivery + a new envelope with the same facts → no-op
    await h.tr.redis.xadd(`${h.tr.prefix}events.delivery`, '*', 'data', JSON.stringify(delivered));
    await send('delivery.delivered', { jobId, childOrderId: p.a.id, partnerUserId, at: at(), distanceKm: 2.75 });
    await send('delivery.picked_up', { jobId, childOrderId: p.a.id, partnerUserId, at: at() });
    expect((await outboxEvents(h, 'order.delivered')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(1);
    expect((await child(h, p.a.id))!.statusHistory).toHaveLength(c!.statusHistory.length);
  });

  it('started → OUT_FOR_DELIVERY; then delivered', async () => {
    const p = await placedCheckout(h);
    await acceptedA(p, false);
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/ready`);
    const jobId = oid();
    const partnerUserId = oid();
    await send('delivery.picked_up', { jobId, childOrderId: p.a.id, partnerUserId, at: at() });
    await send('delivery.started', { jobId, childOrderId: p.a.id, partnerUserId, at: at() });
    expect((await child(h, p.a.id))!.status).toBe('OUT_FOR_DELIVERY');
    await send('delivery.delivered', { jobId, childOrderId: p.a.id, partnerUserId, at: at(), distanceKm: 1 });
    const c = await child(h, p.a.id);
    expect(c!.statusHistory.slice(-1)[0]).toMatchObject({ from: 'OUT_FOR_DELIVERY', to: 'DELIVERED' });
  });

  it('out of order: delivered before picked_up → implicit PICKED_UP → OUT_FOR_DELIVERY → DELIVERED; late picked_up ignored as stale', async () => {
    const p = await placedCheckout(h);
    await acceptedA(p, false); // ACCEPTED, never marked ready, assigned event never seen
    const jobId = oid();
    const partnerUserId = oid();
    await send('delivery.delivered', { jobId, childOrderId: p.a.id, partnerUserId, at: at(), distanceKm: 4.2 });
    let c = await child(h, p.a.id);
    expect(c!.status).toBe('DELIVERED');
    expect(c!.statusHistory.slice(-3).map((s) => s.to)).toEqual(['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect(c!.deliveryJobId).toBe(jobId);
    const d = (await outboxEvents(h, 'order.delivered')).find((e) => e.payload.childOrderId === p.a.id);
    expect(d!.payload).toMatchObject({ partnerUserId, deliveryJobId: jobId, deliveryDistanceKm: 4.2 });

    const len = c!.statusHistory.length;
    await send('delivery.picked_up', { jobId, childOrderId: p.a.id, partnerUserId, at: at() });
    await send('delivery.started', { jobId, childOrderId: p.a.id, partnerUserId, at: at() });
    c = await child(h, p.a.id);
    expect(c!.status).toBe('DELIVERED');
    expect(c!.statusHistory).toHaveLength(len);
    expect((await outboxEvents(h, 'order.picked_up')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(1);
  });

  it('events for a different job than the assigned one are ignored', async () => {
    const p = await placedCheckout(h);
    await acceptedA(p);
    const jobId = oid();
    await send('delivery.assigned', { jobId, childOrderId: p.a.id, partnerId: oid(), partnerUserId: oid(), partnerName: 'A', vehicle: { type: 'BIKE', registrationNumber: 'X' } });
    await send('delivery.picked_up', { jobId: oid(), childOrderId: p.a.id, partnerUserId: oid(), at: at() });
    expect((await child(h, p.a.id))!.status).toBe('PREPARING');
    await send('delivery.unassigned', { jobId, childOrderId: p.a.id, reason: 'partner dropped' });
    const c = await child(h, p.a.id);
    expect(c!.deliveryStatus).toBe('PENDING_ASSIGNMENT');
    expect(c!.partner ?? null).toBeNull();
  });

  it('one delivery DELIVERED + the other delivery.failed → DELIVERY_FAILED, parent IN_PROGRESS until admin cancels with refund → PARTIALLY_COMPLETED', async () => {
    const p = await placedCheckout(h);
    await acceptedA(p);
    await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/accept`, { prepMinutes: 15 });
    const ja = oid();
    const jb = oid();
    const pu = oid();
    await send('delivery.picked_up', { jobId: ja, childOrderId: p.a.id, partnerUserId: pu, at: at() });
    await send('delivery.delivered', { jobId: ja, childOrderId: p.a.id, partnerUserId: pu, at: at(), distanceKm: 2 });
    await send('delivery.picked_up', { jobId: jb, childOrderId: p.b.id, partnerUserId: pu, at: at() });
    await send('delivery.failed', { jobId: jb, childOrderId: p.b.id, reason: 'Customer unreachable' });

    const b = await child(h, p.b.id);
    expect(b!.status).toBe('DELIVERY_FAILED');
    expect(b!.deliveryStatus).toBe('FAILED');
    expect((await outboxEvents(h, 'order.delivery_failed')).filter((e) => e.payload.childOrderId === p.b.id).map((e) => e.payload)).toEqual([
      { childOrderId: p.b.id, reason: 'Customer unreachable' },
    ]);
    expect((await group(h, p.checkout.id))!.status).toBe('IN_PROGRESS');
    const view = await p.u.get(`/api/v1/orders/${p.checkout.id}`);
    expect(view.body.explanations).toEqual([expect.objectContaining({ childOrderId: p.b.id, kind: 'DELIVERY_FAILED' })]);

    const admin = await asAdmin(h);
    // the admin route's snapshot transaction can briefly lag the consumer's commit seen by a plain read:
    // retry only a 409 that was computed from a status other than DELIVERY_FAILED
    let r = await admin.post(`/api/v1/admin/orders/child/${p.b.id}/cancel`, { reason: 'Delivery failed — full refund', refundPaise: p.b.total });
    await waitFor(async () => {
      if (r.status === 409 && r.body.error?.details?.from !== 'DELIVERY_FAILED') {
        r = await admin.post(`/api/v1/admin/orders/child/${p.b.id}/cancel`, { reason: 'Delivery failed — full refund', refundPaise: p.b.total });
      }
      return r.status !== 409 || r.body.error?.details?.from === 'DELIVERY_FAILED';
    }, { timeoutMs: 10_000, intervalMs: 100 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await child(h, p.b.id))!.status).toBe('CANCELLED');
    expect((await group(h, p.checkout.id))!.status).toBe('PARTIALLY_COMPLETED');
    const ev = (await outboxEvents(h, 'order.cancelled')).find((e) => e.payload.childOrderId === p.b.id);
    expect(ev!.payload).toMatchObject({ actor: 'ADMIN', reason: 'DELIVERY_FAILED', refundPaise: p.b.total, fromStatus: 'DELIVERY_FAILED' });
  });

  it('out of order: delivery.failed before picked_up (child PREPARING) → implicit PICKED_UP → DELIVERY_FAILED; late picked_up stale', async () => {
    const p = await placedCheckout(h);
    await acceptedA(p);
    const jobId = oid();
    const pu = oid();
    await send('delivery.failed', { jobId, childOrderId: p.a.id, reason: 'Accident' });
    let c = await child(h, p.a.id);
    expect(c!.status).toBe('DELIVERY_FAILED');
    expect(c!.statusHistory.slice(-2).map((s) => [s.from, s.to])).toEqual([
      ['PREPARING', 'PICKED_UP'],
      ['PICKED_UP', 'DELIVERY_FAILED'],
    ]);
    expect(c!.deliveryFailureReason).toBe('Accident');
    const len = c!.statusHistory.length;
    await send('delivery.picked_up', { jobId, childOrderId: p.a.id, partnerUserId: pu, at: at() });
    c = await child(h, p.a.id);
    expect(c!.status).toBe('DELIVERY_FAILED');
    expect(c!.statusHistory).toHaveLength(len);
    expect((await outboxEvents(h, 'order.delivery_failed')).filter((e) => e.payload.childOrderId === p.a.id)).toHaveLength(1);
  });

  it('unassigned → stale assigned does not overwrite the partner; order.delivered credits the delivering partner', async () => {
    const p = await placedCheckout(h);
    await acceptedA(p);
    const jobId = oid();
    const p1 = oid();
    const p2 = oid();
    const p3 = oid();
    const t = Date.now();
    const vehicle = { type: 'BIKE' as const, registrationNumber: 'KA01' };
    await sendAt('delivery.assigned', { jobId, childOrderId: p.a.id, partnerId: oid(), partnerUserId: p1, partnerName: 'First', vehicle }, new Date(t - 30_000));
    await sendAt('delivery.unassigned', { jobId, childOrderId: p.a.id, reason: 'dropped' }, new Date(t - 10_000));
    // an assignment that happened before the unassign arrives late → ignored
    await sendAt('delivery.assigned', { jobId, childOrderId: p.a.id, partnerId: oid(), partnerUserId: p2, partnerName: 'Stale', vehicle }, new Date(t - 20_000));
    let c = await child(h, p.a.id);
    expect(c!.partner ?? null).toBeNull();
    expect(c!.deliveryStatus).toBe('PENDING_ASSIGNMENT');
    // the actual delivery is done by p3 (its assignment event never arrived)
    await sendAt('delivery.delivered', { jobId, childOrderId: p.a.id, partnerUserId: p3, at: at(), distanceKm: 1.5 }, new Date(t));
    c = await child(h, p.a.id);
    expect(c!.status).toBe('DELIVERED');
    const d = (await outboxEvents(h, 'order.delivered')).find((e) => e.payload.childOrderId === p.a.id);
    expect(d!.payload.partnerUserId).toBe(p3);
  });

});
