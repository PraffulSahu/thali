/**
 * Mandatory acceptance flow (context.md §7, HLD §4.2): Restaurant A accepts, Restaurant B rejects →
 * B refunded, A continues, the customer sees an accurate explanation and updated totals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnvelope, streamKey, subscribeRealtime, type ConsumerHandle } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { startOrdersConsumers } from '../src/events/index.js';
import { oid, outboxEvents, publishEvent, setup, type Harness } from './helpers.js';
import { child, group, placedCheckout, processed, rupees } from './lifecycle-helpers.js';

let h: Harness;
let consumers: ConsumerHandle[];
beforeAll(async () => {
  h = await setup('partial_rejection');
  consumers = startOrdersConsumers(h.ctx, { backoffBaseMs: 20, maxBackoffMs: 200, claimIdleMs: 300, blockMs: 100 });
  await Promise.all(consumers.map((c) => c.ready));
}, 120_000);
afterAll(async () => {
  await Promise.all(consumers.map((c) => c.stop()));
  await h.cleanup();
});

describe('partial rejection', () => {
  it('A accepts, B rejects → B refunded, A continues to delivery, parent PARTIALLY_COMPLETED', async () => {
    const p = await placedCheckout(h);
    const total = p.checkout.pricing.totalPaise;
    const messages: { event: string; data: Record<string, unknown> }[] = [];
    const sub = await subscribeRealtime(h.tr.redis, [`user:${p.u.userId}`], (_c, m) => messages.push(m as never));
    try {
      // 1. A accepts, B rejects
      expect((await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 })).status).toBe(200);
      const rej = await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/reject`, { reason: 'Out of stock' });
      expect(rej.status).toBe(200);

      const b = await child(h, p.b.id);
      expect(b!.status).toBe('REJECTED');
      expect(b!.refundStatus).toBe('REQUESTED');
      const rejected = (await outboxEvents(h, 'order.rejected')).filter((e) => e.payload.childOrderId === p.b.id);
      expect(rejected.map((e) => e.payload)).toEqual([
        { childOrderId: p.b.id, checkoutId: p.checkout.id, userId: p.u.userId, restaurantId: p.s.b.id, reason: 'Out of stock', refundPaise: p.b.total, fromStatus: 'PLACED' },
      ]);
      await waitFor(() => messages.some((m) => m.event === 'order.updated' && m.data.childOrderId === p.b.id && m.data.refundStatus === 'REQUESTED'));

      // 2. A continues; parent IN_PROGRESS
      expect((await child(h, p.a.id))!.status).toBe('ACCEPTED');
      expect((await group(h, p.checkout.id))!.status).toBe('IN_PROGRESS');
      expect((await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/preparing`)).status).toBe(200);

      // 3. customer view: explanation + pending refund
      const v1 = await p.u.get(`/api/v1/orders/${p.checkout.id}`);
      expect(v1.status).toBe(200);
      expect(v1.body.checkout.status).toBe('IN_PROGRESS');
      expect(v1.body.explanations).toEqual([
        {
          childOrderId: p.b.id,
          restaurantName: 'Dosa Corner',
          kind: 'REJECTED',
          reason: 'Out of stock',
          refundPaise: p.b.total,
          refundStatus: 'REQUESTED',
          message: `Dosa Corner declined your order (Out of stock). ${rupees(p.b.total)} refund initiated.`,
        },
      ]);
      expect(v1.body.adjustedTotals).toEqual({ paidPaise: total, refundedPaise: 0, refundPendingPaise: p.b.total, netPaise: total });
      const vb = v1.body.checkout.children.find((c: { id: string }) => c.id === p.b.id);
      expect(vb).toMatchObject({ status: 'REJECTED', refundStatus: 'REQUESTED', rejectionReason: 'Out of stock' });

      // 4. payments: refund lifecycle for B
      const refundId = oid();
      const base = { refundId, childOrderId: p.b.id, checkoutGroupId: p.checkout.id, amountPaise: p.b.total, reason: 'RESTAURANT_REJECTED' as const };
      const e1 = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'refund.requested', { ...base, status: 'REQUESTED' });
      const e2 = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'refund.processing', { ...base, status: 'PROCESSING' });
      await processed(h, e1.id);
      await processed(h, e2.id);
      expect((await child(h, p.b.id))!.refundStatus).toBe('PROCESSING');
      const e3 = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'refund.succeeded', { ...base, status: 'SUCCEEDED' });
      await processed(h, e3.id);
      const b2 = await child(h, p.b.id);
      expect(b2!.refundStatus).toBe('SUCCEEDED');
      expect(b2!.refundedPaise).toBe(p.b.total);
      // a re-published copy (new envelope id) of the success does not double count
      const e4 = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'refund.succeeded', { ...base, status: 'SUCCEEDED' });
      await processed(h, e4.id);
      expect((await child(h, p.b.id))!.refundedPaise).toBe(p.b.total);

      const v2 = await p.u.get(`/api/v1/orders/${p.checkout.id}`);
      expect(v2.body.adjustedTotals).toEqual({ paidPaise: total, refundedPaise: p.b.total, refundPendingPaise: 0, netPaise: total - p.b.total });
      expect(v2.body.explanations[0]).toMatchObject({
        refundStatus: 'SUCCEEDED',
        message: `Dosa Corner declined your order (Out of stock). ${rupees(p.b.total)} refunded.`,
      });
      await waitFor(() => messages.some((m) => m.data.childOrderId === p.b.id && m.data.refundStatus === 'SUCCEEDED'));

      // 5. A delivered → parent PARTIALLY_COMPLETED
      expect((await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/ready`)).status).toBe(200);
      const jobId = oid();
      const partnerUserId = oid();
      const assigned = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.assigned', {
        jobId,
        childOrderId: p.a.id,
        partnerId: oid(),
        partnerUserId,
        partnerName: 'Ravi',
        vehicle: { type: 'BIKE', registrationNumber: 'KA01AB1234' },
      });
      await processed(h, assigned.id);
      const at = new Date().toISOString();
      const picked = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.picked_up', { jobId, childOrderId: p.a.id, partnerUserId, at });
      await processed(h, picked.id);
      const delivered = await publishEvent(h.tr.redis, h.tr.prefix, 'delivery', 'delivery.delivered', {
        jobId,
        childOrderId: p.a.id,
        partnerUserId,
        at,
        distanceKm: 3.4,
      });
      await processed(h, delivered.id);
      expect((await child(h, p.a.id))!.status).toBe('DELIVERED');
      expect((await group(h, p.checkout.id))!.status).toBe('PARTIALLY_COMPLETED');

      const d = (await outboxEvents(h, 'order.delivered')).filter((e) => e.payload.childOrderId === p.a.id);
      expect(d).toHaveLength(1);
      expect(d[0]!.payload).toMatchObject({ deliveryDistanceKm: 3.4, partnerUserId, deliveryJobId: jobId, restaurantOwnerId: p.s.a.ownerUserId, commissionBps: 1800 });
      const v3 = await p.u.get(`/api/v1/orders/${p.checkout.id}`);
      expect(v3.body.checkout.status).toBe('PARTIALLY_COMPLETED');
      expect(v3.body.adjustedTotals.netPaise).toBe(total - p.b.total);
    } finally {
      await sub.close();
    }
  });

  it('refund events without a childOrderId (checkout-level, e.g. LATE_PAYMENT) are recorded and do not fail', async () => {
    const p = await placedCheckout(h);
    const e = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'refund.succeeded', {
      refundId: oid(),
      checkoutGroupId: p.checkout.id,
      amountPaise: 1234,
      reason: 'LATE_PAYMENT',
      status: 'SUCCEEDED',
    });
    await processed(h, e.id);
    expect((await child(h, p.a.id))!.refundedPaise).toBe(0);
    const tl = await h.ctx.models.OrderEvent.find({ checkoutGroupId: p.checkout.id, type: 'refund.succeeded' }).lean();
    expect(tl).toHaveLength(1);
    // unknown child id → ignored, not dead-lettered
    const e2 = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'refund.failed', {
      refundId: oid(),
      childOrderId: oid(),
      checkoutGroupId: oid(),
      amountPaise: 100,
      reason: 'ADMIN',
      status: 'FAILED',
    });
    await processed(h, e2.id);
  });

  it('refund FAILED then retried PROCESSING → SUCCEEDED; stale events after success are ignored', async () => {
    const p = await placedCheckout(h);
    await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/reject`, { reason: 'Too busy' });
    const base = { refundId: oid(), childOrderId: p.b.id, checkoutGroupId: p.checkout.id, amountPaise: p.b.total, reason: 'RESTAURANT_REJECTED' as const };
    const step = async (type: 'refund.failed' | 'refund.processing' | 'refund.succeeded', status: 'FAILED' | 'PROCESSING' | 'SUCCEEDED') => {
      const e = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', type, { ...base, status });
      await processed(h, e.id);
    };
    await step('refund.failed', 'FAILED');
    expect((await child(h, p.b.id))!.refundStatus).toBe('FAILED');
    const v = await p.u.get(`/api/v1/orders/${p.checkout.id}`);
    expect(v.body.explanations[0].message).toBe(
      `Dosa Corner declined your order (Too busy). The ${rupees(p.b.total)} refund failed; our team will retry it.`,
    );
    expect(v.body.adjustedTotals.refundPendingPaise).toBe(p.b.total);
    await step('refund.processing', 'PROCESSING');
    expect((await child(h, p.b.id))!.refundStatus).toBe('PROCESSING');
    await step('refund.succeeded', 'SUCCEEDED');
    await step('refund.processing', 'PROCESSING'); // stale
    await step('refund.failed', 'FAILED'); // stale
    const b = await child(h, p.b.id);
    expect(b!.refundStatus).toBe('SUCCEEDED');
    expect(b!.refundedPaise).toBe(p.b.total);
  });

  it('a refund event older than the last applied one is ignored (late PROCESSING does not flip FAILED back)', async () => {
    const p = await placedCheckout(h);
    await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/reject`, { reason: 'Closed' });
    const base = { refundId: oid(), childOrderId: p.b.id, checkoutGroupId: p.checkout.id, amountPaise: p.b.total, reason: 'RESTAURANT_REJECTED' as const };
    const t = Date.now();
    const sendAt = async (type: 'refund.processing' | 'refund.failed', status: 'PROCESSING' | 'FAILED', occurredAt: Date) => {
      const env = createEnvelope(type, { ...base, status }, { producer: 'payments', aggregateId: 'agg', occurredAt });
      await h.tr.redis.xadd(streamKey(h.tr.prefix, 'events.payments'), '*', 'data', JSON.stringify(env));
      await processed(h, env.id);
    };
    await sendAt('refund.failed', 'FAILED', new Date(t - 1000));
    await sendAt('refund.processing', 'PROCESSING', new Date(t - 5000)); // older attempt, delivered late
    expect((await child(h, p.b.id))!.refundStatus).toBe('FAILED');
    await sendAt('refund.processing', 'PROCESSING', new Date(t)); // genuine retry
    expect((await child(h, p.b.id))!.refundStatus).toBe('PROCESSING');
  });

  it("a refund event whose checkoutGroupId is not the child's checkout is ignored (no mirror change) and alerted", async () => {
    const p = await placedCheckout(h);
    const before = await child(h, p.a.id);
    const e = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'refund.succeeded', {
      refundId: oid(),
      childOrderId: p.a.id,
      checkoutGroupId: oid(), // another checkout's payment
      amountPaise: 1000,
      reason: 'ADMIN',
      status: 'SUCCEEDED',
    });
    await processed(h, e.id);
    const after = await child(h, p.a.id);
    expect(after!.refunds).toHaveLength(0);
    expect(after!.refundedPaise).toBe(before!.refundedPaise);
    expect(after!.refundRequestedPaise).toBe(before!.refundRequestedPaise);
    expect(after!.refundStatus).toBe(before!.refundStatus);
    expect(await h.ctx.models.OrderEvent.countDocuments({ childOrderId: p.a.id, type: 'refund.succeeded' })).toBe(0);
  });
});
