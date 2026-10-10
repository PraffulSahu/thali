/**
 * Partner job execution (LLD 4.5): ASSIGNED → AT_PICKUP → PICKED_UP (pickup code) → OUT_FOR_DELIVERY
 * → DELIVERED (customer delivery code); PICKED_UP/OUT_FOR_DELIVERY → FAILED (reason).
 * Only the assigned partner may act (others get 404). Handover codes: each guess first reserves an
 * attempt atomically (`codeAttempts < MAX` → $inc), so even concurrent guessing can never exceed
 * CODE_MAX_ATTEMPTS; at the limit the job is locked (423) until an admin reassigns/fails it.
 */
import { DomainError, assertTransition, deliveryTransitions, type DeliveryStatus } from '@thali/contracts';
import { buildPage, cursorFilter, PAGE_SORT, withTransaction } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { ACTIVE_JOB_STATUSES, TERMINAL_JOB_STATUSES, type JobLean } from '../models/delivery-job.js';
import { verifyCode } from './codes.js';
import { atIso, emit, releasePartnerCapacity, transitionJob } from './job-state.js';
import { requirePartner } from './onboarding.js';

/** Load the job iff it is assigned to `userId`'s partner profile; 404 otherwise. */
async function myJob(ctx: DeliveryContext, userId: string, jobId: string, session?: import('mongoose').ClientSession): Promise<JobLean> {
  const job = await ctx.models.Job.findOne({ _id: jobId, partnerUserId: userId }, null, session ? { session } : {}).lean<JobLean>();
  if (!job) throw new DomainError('NOT_FOUND', 'Delivery not found');
  return job;
}

export async function markArrived(ctx: DeliveryContext, userId: string, jobId: string): Promise<JobLean> {
  return withTransaction(ctx.conn, async (session) => {
    const job = await myJob(ctx, userId, jobId, session);
    return transitionJob(ctx, session, job, 'AT_PICKUP', 'PARTNER', { actorId: userId });
  });
}

/**
 * Reserve one code attempt atomically, then compare in constant time.
 * Returns the job as read at reservation time; throws 400/423 on a wrong/locked code.
 */
async function checkCode(ctx: DeliveryContext, userId: string, jobId: string, requiredStatus: DeliveryStatus, next: DeliveryStatus, code: string, which: 'pickup' | 'delivery') {
  const max = ctx.config.CODE_MAX_ATTEMPTS;
  const reserved = await ctx.models.Job.findOneAndUpdate(
    { _id: jobId, partnerUserId: userId, status: requiredStatus, codeAttempts: { $lt: max } },
    { $inc: { codeAttempts: 1 } },
    { new: true },
  ).lean<JobLean>();
  if (!reserved) {
    const job = await myJob(ctx, userId, jobId);
    assertTransition(deliveryTransitions, job.status as DeliveryStatus, next, 'PARTNER');
    if (job.status !== requiredStatus) throw new DomainError('DELIVERY_INVALID_TRANSITION', `Delivery is ${job.status}`, undefined, { from: job.status, to: next, actor: 'PARTNER' });
    throw new DomainError('DELIVERY_CODE_LOCKED', 'Too many wrong codes. Contact support to continue.', undefined, { attemptsRemaining: 0 });
  }
  const hash = which === 'pickup' ? reserved.pickupCodeHash : reserved.deliveryCodeHash;
  if (verifyCode(reserved.childOrderId, code, hash)) return reserved;
  const remaining = Math.max(0, max - reserved.codeAttempts);
  if (remaining === 0) throw new DomainError('DELIVERY_CODE_LOCKED', 'Too many wrong codes. Contact support to continue.', undefined, { attemptsRemaining: 0 });
  throw new DomainError('DELIVERY_CODE_INVALID', `Wrong ${which} code`, undefined, { attemptsRemaining: remaining });
}

export async function confirmPickup(ctx: DeliveryContext, userId: string, jobId: string, code: string): Promise<JobLean> {
  await checkCode(ctx, userId, jobId, 'AT_PICKUP', 'PICKED_UP', code, 'pickup');
  return withTransaction(ctx.conn, async (session) => {
    const job = await myJob(ctx, userId, jobId, session);
    const now = ctx.now();
    const updated = await transitionJob(ctx, session, job, 'PICKED_UP', 'PARTNER', { actorId: userId, set: { pickedUpAt: now, codeAttempts: 0 } });
    await emit(ctx, session, 'delivery.picked_up', { jobId: job._id.toString(), childOrderId: job.childOrderId, partnerUserId: userId, at: atIso(now) }, job._id.toString());
    return updated;
  });
}

export async function startDelivery(ctx: DeliveryContext, userId: string, jobId: string): Promise<JobLean> {
  return withTransaction(ctx.conn, async (session) => {
    const job = await myJob(ctx, userId, jobId, session);
    const now = ctx.now();
    const updated = await transitionJob(ctx, session, job, 'OUT_FOR_DELIVERY', 'PARTNER', { actorId: userId });
    await emit(ctx, session, 'delivery.started', { jobId: job._id.toString(), childOrderId: job.childOrderId, partnerUserId: userId, at: atIso(now) }, job._id.toString());
    return updated;
  });
}

export async function confirmDelivery(ctx: DeliveryContext, userId: string, jobId: string, code: string): Promise<JobLean> {
  await checkCode(ctx, userId, jobId, 'OUT_FOR_DELIVERY', 'DELIVERED', code, 'delivery');
  return withTransaction(ctx.conn, async (session) => {
    const job = await myJob(ctx, userId, jobId, session);
    const now = ctx.now();
    const updated = await transitionJob(ctx, session, job, 'DELIVERED', 'PARTNER', { actorId: userId, set: { deliveredAt: now } });
    await releasePartnerCapacity(ctx, session, job.partnerId, job._id);
    await emit(
      ctx,
      session,
      'delivery.delivered',
      { jobId: job._id.toString(), childOrderId: job.childOrderId, partnerUserId: userId, at: atIso(now), distanceKm: job.distanceKm },
      job._id.toString(),
    );
    return updated;
  });
}

export async function failDelivery(ctx: DeliveryContext, userId: string, jobId: string, reason: string): Promise<JobLean> {
  return withTransaction(ctx.conn, async (session) => {
    const job = await myJob(ctx, userId, jobId, session);
    const updated = await transitionJob(ctx, session, job, 'FAILED', 'PARTNER', { actorId: userId, reason, set: { failureReason: reason } });
    await releasePartnerCapacity(ctx, session, job.partnerId, job._id);
    await emit(ctx, session, 'delivery.failed', { jobId: job._id.toString(), childOrderId: job.childOrderId, reason }, job._id.toString());
    return updated;
  });
}

export async function activeJobs(ctx: DeliveryContext, userId: string): Promise<JobLean[]> {
  await requirePartner(ctx, userId);
  return ctx.models.Job.find({ partnerUserId: userId, status: { $in: ACTIVE_JOB_STATUSES } }).sort({ assignedAt: 1 }).lean<JobLean[]>();
}

export async function jobHistory(ctx: DeliveryContext, userId: string, limit: number, cursor?: string) {
  await requirePartner(ctx, userId);
  const docs = await ctx.models.Job.find({ partnerUserId: userId, status: { $in: TERMINAL_JOB_STATUSES }, ...cursorFilter(cursor) })
    .sort(PAGE_SORT)
    .limit(limit + 1)
    .lean<JobLean[]>();
  return buildPage(docs, limit);
}
