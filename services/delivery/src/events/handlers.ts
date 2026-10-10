/**
 * Consumed events (LLD 9) on `events.orders`, consumer group `cg.delivery`:
 *  - order.accepted  → create the delivery job (idempotent per childOrderId; codes stored as hashes)
 *  - order.ready     → set readyAt
 *  - order.cancelled → cancel the job, cancel live offers, release partner capacity
 *  - order.delivery_failed → (admin marked the order "Delivery failed" in orders) end the job: PICKED_UP /
 *    OUT_FOR_DELIVERY → FAILED (actor ADMIN — the decision is an admin's; SYSTEM may not fail a job), a
 *    pre-pickup job → CANCELLED; release partner capacity. Emits `delivery.failed` only for the FAILED case,
 *    which orders treats as already applied (child is DELIVERY_FAILED already: mirror update only, no new
 *    order event), so nothing loops. A job already terminal (e.g. the partner reported the failure, which
 *    is what produced this event) is a no-op.
 * Handlers run inside the consumer's transaction (inbox row first) and write only with `session`.
 * The GeoProvider call in order.accepted is a side-effect-free read (Google with haversine fallback),
 * so a transaction retry only repeats the estimate.
 */
import type { ClientSession } from 'mongoose';
import { DomainError, type EventEnvelope } from '@thali/contracts';
import type { EventHandlers } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { hashCode } from '../domain/codes.js';
import { toLatLng } from '../domain/geo.js';
import { cancelOpenOffers, emit, historyEntry, releasePartnerCapacity, transitionJob } from '../domain/job-state.js';
import { TERMINAL_JOB_STATUSES, type JobLean } from '../models/delivery-job.js';

export function createEventHandlers(ctx: DeliveryContext): EventHandlers {
  async function onAccepted(e: EventEnvelope<'order.accepted'>, session: ClientSession) {
    const p = e.payload;
    const existing = await ctx.models.Job.exists({ childOrderId: p.childOrderId }).session(session);
    if (existing) return; // business-level idempotency (inbox handles same event id)
    const est = await ctx.geo.distanceAndEta(toLatLng(p.pickup.location), toLatLng(p.drop.location));
    const now = ctx.now();
    const acceptedAt = new Date(e.occurredAt);
    const [job] = await ctx.models.Job.create(
      [
        {
          childOrderId: p.childOrderId,
          checkoutGroupId: p.checkoutId,
          restaurantId: p.restaurantId,
          customerUserId: p.userId,
          pickup: { name: p.pickup.name, address: p.pickup.address, location: p.pickup.location },
          drop: { name: p.drop.name, address: p.drop.address, location: p.drop.location, phoneMasked: p.drop.phoneMasked },
          status: 'PENDING_ASSIGNMENT',
          dispatchRound: 0,
          nextDispatchAt: now,
          distanceKm: est.distanceKm,
          estimatedMinutes: est.etaMinutes,
          estimateSource: est.source,
          prepMinutes: p.prepMinutes,
          readyEta: Number.isNaN(acceptedAt.getTime()) ? null : new Date(acceptedAt.getTime() + p.prepMinutes * 60_000),
          pickupCodeHash: hashCode(p.childOrderId, p.pickupCode),
          deliveryCodeHash: hashCode(p.childOrderId, p.deliveryCode),
          codeAttempts: 0,
          statusHistory: [historyEntry(null, 'PENDING_ASSIGNMENT', now, 'SYSTEM', null, 'order.accepted')],
        },
      ],
      { session },
    );
    await emit(ctx, session, 'delivery.job_created', { jobId: job!._id.toString(), childOrderId: p.childOrderId }, job!._id.toString());
  }

  async function onReady(e: EventEnvelope<'order.ready'>, session: ClientSession) {
    const res = await ctx.models.Job.updateOne({ childOrderId: e.payload.childOrderId }, { $set: { readyAt: new Date(e.occurredAt) } }, { session });
    // order.accepted precedes order.ready on events.orders; a missing job means it has not been
    // processed yet (e.g. retried) — throw so the consumer retries with backoff.
    if (!res.matchedCount) throw new DomainError('NOT_FOUND', `no delivery job yet for ${e.payload.childOrderId}`);
  }

  async function onCancelled(e: EventEnvelope<'order.cancelled'>, session: ClientSession) {
    const job = await ctx.models.Job.findOne({ childOrderId: e.payload.childOrderId }, null, { session }).lean<JobLean>();
    if (!job) return; // cancelled before acceptance: no job was ever created
    if ((TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status)) return;
    await transitionJob(ctx, session, job, 'CANCELLED', 'SYSTEM', {
      reason: `order cancelled (${e.payload.actor}): ${e.payload.reason}`,
      set: { cancelledAt: ctx.now(), nextDispatchAt: null },
    });
    await cancelOpenOffers(ctx, session, job._id);
    await releasePartnerCapacity(ctx, session, job.partnerId, job._id);
  }

  async function onDeliveryFailed(e: EventEnvelope<'order.delivery_failed'>, session: ClientSession) {
    const job = await ctx.models.Job.findOne({ childOrderId: e.payload.childOrderId }, null, { session }).lean<JobLean>();
    if (!job) {
      ctx.logger.warn({ childOrderId: e.payload.childOrderId, eventId: e.id }, 'order.delivery_failed for an order without a delivery job; ignored');
      return;
    }
    if ((TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status)) return; // already ended (partner/admin fail in delivery)
    const reason = `order marked delivery failed: ${e.payload.reason}`;
    if (job.status === 'PICKED_UP' || job.status === 'OUT_FOR_DELIVERY') {
      await transitionJob(ctx, session, job, 'FAILED', 'ADMIN', { reason, set: { failureReason: e.payload.reason, nextDispatchAt: null } });
      await releasePartnerCapacity(ctx, session, job.partnerId, job._id);
      await emit(ctx, session, 'delivery.failed', { jobId: job._id.toString(), childOrderId: job.childOrderId, reason: e.payload.reason }, job._id.toString());
      return;
    }
    // The job never got the food (orders moved ahead of it): stop it like a cancellation.
    await transitionJob(ctx, session, job, 'CANCELLED', 'SYSTEM', { reason, set: { cancelledAt: ctx.now(), nextDispatchAt: null } });
    await cancelOpenOffers(ctx, session, job._id);
    await releasePartnerCapacity(ctx, session, job.partnerId, job._id);
  }

  return {
    'order.accepted': onAccepted,
    'order.ready': onReady,
    'order.cancelled': onCancelled,
    'order.delivery_failed': onDeliveryFailed,
  };
}

export const CONSUMED_STREAMS = ['events.orders'];
