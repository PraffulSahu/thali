/**
 * Admin TMS (LLD 10 delivery 🛡): manual assign / reassign, unassign, fail, lists, overview and the
 * demo simulator trigger. Every mutation is one transaction with an `audit.recorded` outbox row.
 */
import { DomainError } from '@thali/contracts';
import { auditEvent, buildPage, cursorFilter, PAGE_SORT, withTransaction } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import type { JobLean } from '../models/delivery-job.js';
import type { PartnerLean } from '../models/partner.js';
import { emitAssigned, reserveCapacity } from './accept.js';
import { cancelOpenOffers, emit, releasePartnerCapacity, transitionJob, unassignJob } from './job-state.js';

export interface AdminActor {
  userId: string;
  ip?: string;
}

const audit = (ctx: DeliveryContext, session: import('mongoose').ClientSession, admin: AdminActor, action: string, targetId: string, summary: string) =>
  auditEvent(ctx.conn, session, { service: 'delivery', actorId: admin.userId, actorRole: 'ADMIN', action, targetType: 'delivery_job', targetId, summary, ip: admin.ip });

/**
 * Manual assign to an APPROVED, online partner with capacity. If the job is already ASSIGNED /
 * AT_PICKUP to someone else it is first unassigned (previous partner's capacity released).
 */
export async function adminAssign(ctx: DeliveryContext, jobId: string, partnerId: string, admin: AdminActor): Promise<JobLean> {
  return withTransaction(ctx.conn, async (session) => {
    let job = await ctx.models.Job.findById(jobId, null, { session }).lean<JobLean>();
    if (!job) throw new DomainError('NOT_FOUND', 'Delivery not found');
    const partner = await ctx.models.Partner.findById(partnerId, null, { session }).lean<PartnerLean>();
    if (!partner) throw new DomainError('NOT_FOUND', 'Partner not found');
    if (partner.status !== 'APPROVED') throw new DomainError('PARTNER_NOT_APPROVED', `Partner is ${partner.status}`);
    if (!partner.online) throw new DomainError('CONFLICT', 'Partner is offline');
    if (job.partnerId && job.partnerId.toString() === partner._id.toString()) throw new DomainError('CONFLICT', 'Job is already assigned to this partner');

    const previous = job.partnerId ? job.partnerId.toString() : null;
    if (job.status === 'ASSIGNED' || job.status === 'AT_PICKUP') {
      job = await unassignJob(ctx, session, job, 'ADMIN', { actorId: admin.userId, reason: 'ADMIN_REASSIGN' });
    }
    const now = ctx.now();
    const assigned = await transitionJob(ctx, session, job, 'ASSIGNED', 'ADMIN', {
      actorId: admin.userId,
      reason: previous ? 'reassigned by admin' : 'assigned by admin',
      set: { partnerId: partner._id, partnerUserId: partner.userId, assignedAt: now, nextDispatchAt: null, exception: false, exceptionReason: null, codeAttempts: 0 },
    });
    const reserved = await reserveCapacity(ctx, partner._id, job._id, session);
    if (!reserved) throw new DomainError('CAPACITY_EXCEEDED', 'Partner is at their active delivery limit');
    await cancelOpenOffers(ctx, session, job._id);
    await emitAssigned(ctx, session, assigned, reserved);
    await audit(ctx, session, admin, 'delivery.assign', jobId, `${previous ? 'Reassigned' : 'Assigned'} ${job.childOrderId} to ${partner.name}${previous ? ` (was partner ${previous})` : ''}`);
    return assigned;
  });
}

export async function adminUnassign(ctx: DeliveryContext, jobId: string, admin: AdminActor, reason?: string): Promise<JobLean> {
  return withTransaction(ctx.conn, async (session) => {
    const job = await ctx.models.Job.findById(jobId, null, { session }).lean<JobLean>();
    if (!job) throw new DomainError('NOT_FOUND', 'Delivery not found');
    const updated = await unassignJob(ctx, session, job, 'ADMIN', { actorId: admin.userId, reason: reason?.trim() || 'ADMIN_UNASSIGN' });
    await audit(ctx, session, admin, 'delivery.unassign', jobId, `Unassigned ${job.childOrderId}${reason ? `: ${reason}` : ''}`);
    return updated;
  });
}

export async function adminFail(ctx: DeliveryContext, jobId: string, reason: string, admin: AdminActor): Promise<JobLean> {
  return withTransaction(ctx.conn, async (session) => {
    const job = await ctx.models.Job.findById(jobId, null, { session }).lean<JobLean>();
    if (!job) throw new DomainError('NOT_FOUND', 'Delivery not found');
    const updated = await transitionJob(ctx, session, job, 'FAILED', 'ADMIN', { actorId: admin.userId, reason, set: { failureReason: reason } });
    await releasePartnerCapacity(ctx, session, job.partnerId, job._id);
    await emit(ctx, session, 'delivery.failed', { jobId: job._id.toString(), childOrderId: job.childOrderId, reason }, job._id.toString());
    await audit(ctx, session, admin, 'delivery.fail', jobId, `Marked ${job.childOrderId} failed: ${reason}`);
    return updated;
  });
}

export async function listJobs(ctx: DeliveryContext, q: { status?: string; exception?: boolean; limit: number; cursor?: string }) {
  const filter: Record<string, unknown> = { ...cursorFilter(q.cursor) };
  if (q.status) filter.status = q.status;
  if (q.exception !== undefined) filter.exception = q.exception;
  const docs = await ctx.models.Job.find(filter).sort(PAGE_SORT).limit(q.limit + 1).lean<JobLean[]>();
  return buildPage(docs, q.limit);
}

export async function listPartners(ctx: DeliveryContext, q: { status?: string; limit: number; cursor?: string }) {
  const filter: Record<string, unknown> = { ...cursorFilter(q.cursor) };
  if (q.status) filter.status = q.status;
  const docs = await ctx.models.Partner.find(filter).sort(PAGE_SORT).limit(q.limit + 1).lean<PartnerLean[]>();
  return buildPage(docs, q.limit);
}

export async function overview(ctx: DeliveryContext) {
  const [jobAgg, partnerAgg, exceptions, online, liveOffers] = await Promise.all([
    ctx.models.Job.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ctx.models.Partner.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ctx.models.Job.countDocuments({ exception: true, status: { $in: ['PENDING_ASSIGNMENT', 'OFFERED'] } }),
    ctx.models.Partner.countDocuments({ status: 'APPROVED', online: true }),
    ctx.models.Offer.countDocuments({ status: 'OFFERED', expiresAt: { $gt: ctx.now() } }),
  ]);
  return {
    jobsByStatus: Object.fromEntries(jobAgg.map((r) => [r._id, r.n])) as Record<string, number>,
    exceptions,
    liveOffers,
    partners: { byStatus: Object.fromEntries(partnerAgg.map((r) => [r._id, r.n])) as Record<string, number>, online },
    generatedAt: ctx.now().toISOString(),
  };
}

/** Demo simulator trigger (route guarantees APP_MODE=demo). */
export async function adminSimulate(ctx: DeliveryContext, jobId: string, admin: AdminActor) {
  const job = await ctx.models.Job.findById(jobId).lean<JobLean>();
  if (!job) throw new DomainError('NOT_FOUND', 'Delivery not found');
  if (!['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY'].includes(job.status)) {
    throw new DomainError('CONFLICT', 'Only an assigned, in-progress delivery can be simulated');
  }
  await withTransaction(ctx.conn, (session) => audit(ctx, session, admin, 'delivery.demo_simulate', jobId, `Started demo location simulation for ${job.childOrderId}`));
  const { steps, stepMs } = ctx.simulator.start(job);
  return { jobId, steps, stepMs, simulated: true as const };
}
