import { createEnvelope, startConsumer } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDispatchTick } from '../src/jobs/dispatcher.js';
import { createEventHandlers } from '../src/events/handlers.js';
import { acceptedPayload, at, createJob, createPartner, deliverEvent, envelope, outboxEvents, setup, type Harness } from './helpers.js';

describe('consumed order events', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup('order_events');
  });
  afterAll(async () => h.cleanup());

  it('order.accepted twice (different event ids) → exactly one job and one delivery.job_created', async () => {
    const payload = acceptedPayload();
    await deliverEvent(h, envelope('order.accepted', payload, payload.childOrderId));
    await deliverEvent(h, envelope('order.accepted', payload, payload.childOrderId));
    const jobs = await h.ctx.models.Job.find({ childOrderId: payload.childOrderId }).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ customerUserId: payload.userId, checkoutGroupId: payload.checkoutId, status: 'PENDING_ASSIGNMENT', prepMinutes: 15 });
    expect(await outboxEvents(h, 'delivery.job_created', { childOrderId: payload.childOrderId })).toHaveLength(1);
  });

  it('order.accepted through the real stream consumer, duplicated on the stream → one job', async () => {
    const payload = acceptedPayload();
    const env = createEnvelope('order.accepted', payload, { producer: 'orders', aggregateId: payload.childOrderId });
    const key = `${h.config.EVENT_STREAM_PREFIX}events.orders`;
    await h.ctx.redis.xadd(key, '*', 'data', JSON.stringify(env));
    await h.ctx.redis.xadd(key, '*', 'data', JSON.stringify(env));
    const consumer = startConsumer({
      conn: h.ctx.conn,
      redis: h.ctx.redis,
      logger: h.ctx.logger,
      service: 'delivery',
      streamPrefix: h.config.EVENT_STREAM_PREFIX,
      streams: ['events.orders'],
      handlers: createEventHandlers(h.ctx),
      blockMs: 100,
    });
    try {
      await waitFor(async () => (await h.ctx.models.Job.countDocuments({ childOrderId: payload.childOrderId })) === 1, { message: 'job via consumer' });
      await new Promise((r) => setTimeout(r, 300));
      expect(await h.ctx.models.Job.countDocuments({ childOrderId: payload.childOrderId })).toBe(1);
    } finally {
      await consumer.stop();
    }
  });

  it('order.ready sets readyAt', async () => {
    const { job, payload } = await createJob(h);
    await deliverEvent(h, envelope('order.ready', { childOrderId: payload.childOrderId, restaurantId: payload.restaurantId, userId: payload.userId }, payload.childOrderId));
    expect((await h.ctx.models.Job.findById(job.id).lean())!.readyAt).toBeInstanceOf(Date);
  });

  it('order.cancelled → job CANCELLED, live offers cancelled, partner capacity released; replay is a no-op', async () => {
    const p = await createPartner(h, { location: at(0.1, 0) });
    const { job, payload } = await createJob(h);
    await runDispatchTick(h.ctx);
    expect(await h.ctx.models.Offer.countDocuments({ jobId: job._id, status: 'OFFERED' })).toBeGreaterThan(0);

    const cancelled = { childOrderId: payload.childOrderId, checkoutId: payload.checkoutId, userId: payload.userId, restaurantId: payload.restaurantId, actor: 'ADMIN' as const, reason: 'Kitchen fire', refundPaise: 1000 };
    await deliverEvent(h, envelope('order.cancelled', cancelled, payload.childOrderId));
    const after = (await h.ctx.models.Job.findById(job.id).lean())!;
    expect(after.status).toBe('CANCELLED');
    expect(after.statusHistory.at(-1)).toMatchObject({ to: 'CANCELLED', actor: 'SYSTEM' });
    expect(await h.ctx.models.Offer.countDocuments({ jobId: job._id, status: 'OFFERED' })).toBe(0);
    expect(await h.ctx.models.Offer.countDocuments({ jobId: job._id, status: 'CANCELLED' })).toBeGreaterThan(0);
    await deliverEvent(h, envelope('order.cancelled', cancelled, payload.childOrderId));
    expect((await h.ctx.models.Job.findById(job.id).lean())!.status).toBe('CANCELLED');

    // assigned job: capacity is released on cancellation
    const { job: j2, payload: p2 } = await createJob(h);
    await h.ctx.models.Job.updateOne({ _id: j2._id }, { $set: { status: 'ASSIGNED', partnerId: p._id, partnerUserId: p.userId } });
    await h.ctx.models.Partner.updateOne({ _id: p._id }, { $push: { activeJobIds: j2._id } });
    await deliverEvent(h, envelope('order.cancelled', { ...cancelled, childOrderId: p2.childOrderId }, p2.childOrderId));
    expect((await h.ctx.models.Job.findById(j2.id).lean())!.status).toBe('CANCELLED');
    expect((await h.ctx.models.Partner.findById(p._id).lean())!.activeJobIds).toHaveLength(0);
  });

  it('order.cancelled for an order that never got a job is ignored', async () => {
    await expect(
      deliverEvent(h, envelope('order.cancelled', { childOrderId: '6650f0f0f0f0f0f0f0f0f0f0', checkoutId: 'c', userId: 'u', restaurantId: 'r', actor: 'CUSTOMER', reason: 'changed mind', refundPaise: 0 }, 'x')),
    ).resolves.toBeUndefined();
  });

  it('cancel-before-accept race: order.cancelled with no job leaves a tombstone, so a retried order.accepted creates/dispatches nothing', async () => {
    const payload = acceptedPayload();
    const cancelled = { childOrderId: payload.childOrderId, checkoutId: payload.checkoutId, userId: payload.userId, restaurantId: payload.restaurantId, actor: 'CUSTOMER' as const, reason: 'changed mind', refundPaise: 0 };
    await deliverEvent(h, envelope('order.cancelled', cancelled, payload.childOrderId));
    await deliverEvent(h, envelope('order.cancelled', cancelled, payload.childOrderId)); // replay: still one tombstone
    expect(await h.ctx.models.CancelledOrder.countDocuments({ childOrderId: payload.childOrderId })).toBe(1);

    await deliverEvent(h, envelope('order.accepted', payload, payload.childOrderId)); // late / retried
    expect(await h.ctx.models.Job.countDocuments({ childOrderId: payload.childOrderId })).toBe(0);
    expect(await outboxEvents(h, 'delivery.job_created', { childOrderId: payload.childOrderId })).toHaveLength(0);
    await createPartner(h, { location: at(0.1, 0) });
    await runDispatchTick(h.ctx);
    expect(await h.ctx.models.Job.countDocuments({ childOrderId: payload.childOrderId })).toBe(0);

    // other orders are unaffected
    const other = acceptedPayload();
    await deliverEvent(h, envelope('order.accepted', other, other.childOrderId));
    expect(await h.ctx.models.Job.countDocuments({ childOrderId: other.childOrderId })).toBe(1);
  });

  describe('order.delivery_failed (admin "Delivery failed" in orders)', () => {
    const failed = (childOrderId: string) => envelope('order.delivery_failed', { childOrderId, reason: 'Customer unreachable' }, childOrderId);

    it.each(['PICKED_UP', 'OUT_FOR_DELIVERY'] as const)('%s job → FAILED (actor ADMIN), capacity released, one delivery.failed; replay is a no-op', async (status) => {
      const p = await createPartner(h, { location: at(0.1, 0) });
      const { job, payload } = await createJob(h);
      await h.ctx.models.Job.updateOne({ _id: job._id }, { $set: { status, partnerId: p._id, partnerUserId: p.userId } });
      await h.ctx.models.Partner.updateOne({ _id: p._id }, { $push: { activeJobIds: job._id } });

      await deliverEvent(h, failed(payload.childOrderId));
      const after = (await h.ctx.models.Job.findById(job.id).lean())!;
      expect(after.status).toBe('FAILED');
      expect(after.failureReason).toBe('Customer unreachable');
      expect(after.statusHistory.at(-1)).toMatchObject({ from: status, to: 'FAILED', actor: 'ADMIN' });
      expect((await h.ctx.models.Partner.findById(p._id).lean())!.activeJobIds).toHaveLength(0);
      expect(await outboxEvents(h, 'delivery.failed', { childOrderId: payload.childOrderId })).toHaveLength(1);

      await deliverEvent(h, failed(payload.childOrderId));
      expect((await h.ctx.models.Job.findById(job.id).lean())!.statusHistory).toHaveLength(after.statusHistory.length);
      expect(await outboxEvents(h, 'delivery.failed', { childOrderId: payload.childOrderId })).toHaveLength(1);
    });

    it('a job the partner already failed (the source of this event) is left alone and emits nothing', async () => {
      const { job, payload } = await createJob(h);
      await h.ctx.models.Job.updateOne({ _id: job._id }, { $set: { status: 'FAILED', failureReason: 'partner said so' } });
      await deliverEvent(h, failed(payload.childOrderId));
      const after = (await h.ctx.models.Job.findById(job.id).lean())!;
      expect(after.status).toBe('FAILED');
      expect(after.failureReason).toBe('partner said so');
      expect(await outboxEvents(h, 'delivery.failed', { childOrderId: payload.childOrderId })).toHaveLength(0);
    });

    it('a pre-pickup job is cancelled (offers cancelled, capacity released) without emitting delivery.failed', async () => {
      await createPartner(h, { location: at(0.1, 0) });
      const { job, payload } = await createJob(h);
      await runDispatchTick(h.ctx);
      await deliverEvent(h, failed(payload.childOrderId));
      const after = (await h.ctx.models.Job.findById(job.id).lean())!;
      expect(after.status).toBe('CANCELLED');
      expect(await h.ctx.models.Offer.countDocuments({ jobId: job._id, status: 'OFFERED' })).toBe(0);
      expect(await outboxEvents(h, 'delivery.failed', { childOrderId: payload.childOrderId })).toHaveLength(0);
    });

    it('no job → ignored', async () => {
      await expect(deliverEvent(h, failed('6650f0f0f0f0f0f0f0f0f0f1'))).resolves.toBeUndefined();
    });
  });
});
