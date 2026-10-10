/**
 * Delivery-job state helpers: every status change goes through `assertTransition(deliveryTransitions…)`
 * and a conditional update on the status that was read in the same transaction, so a concurrent
 * change either write-conflicts (transaction retried) or fails the filter (→ 409).
 */
import type { ClientSession, Types } from 'mongoose';
import { DomainError, assertTransition, deliveryTransitions, type Actor, type DeliveryStatus, type EventPayloads, type EventType } from '@thali/contracts';
import { emitEvent } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import type { JobLean } from '../models/delivery-job.js';

export interface HistoryEntry {
  from: string | null;
  to: string;
  at: Date;
  actor: Actor;
  actorId: string | null;
  reason: string | null;
}

export function historyEntry(from: string | null, to: string, at: Date, actor: Actor, actorId?: string | null, reason?: string | null): HistoryEntry {
  return { from, to, at, actor, actorId: actorId ?? null, reason: reason ?? null };
}

export interface TransitionOptions {
  actorId?: string | null;
  reason?: string | null;
  set?: Record<string, unknown>;
  inc?: Record<string, number>;
}

/** Transition `job` (read inside `session`) to `to`; returns the updated job. */
export async function transitionJob(
  ctx: DeliveryContext,
  session: ClientSession,
  job: JobLean,
  to: DeliveryStatus,
  actor: Actor,
  opts: TransitionOptions = {},
): Promise<JobLean> {
  assertTransition(deliveryTransitions, job.status as DeliveryStatus, to, actor);
  const update: Record<string, unknown> = {
    $set: { status: to, ...opts.set },
    $push: { statusHistory: historyEntry(job.status, to, ctx.now(), actor, opts.actorId, opts.reason) },
  };
  if (opts.inc) update.$inc = opts.inc;
  const updated = await ctx.models.Job.findOneAndUpdate({ _id: job._id, status: job.status }, update, { session, new: true }).lean<JobLean>();
  if (!updated) throw new DomainError('CONFLICT', 'The delivery changed concurrently; refresh and retry');
  return updated;
}

/** Remove the job from the partner's active list (capacity release). */
export async function releasePartnerCapacity(ctx: DeliveryContext, session: ClientSession, partnerId: Types.ObjectId | string | null | undefined, jobId: Types.ObjectId) {
  if (!partnerId) return;
  await ctx.models.Partner.updateOne({ _id: partnerId }, { $pull: { activeJobIds: jobId } }, { session });
}

/** Cancel every live (OFFERED) offer for a job. */
export async function cancelOpenOffers(ctx: DeliveryContext, session: ClientSession, jobId: Types.ObjectId, exceptOfferId?: Types.ObjectId) {
  const filter: Record<string, unknown> = { jobId, status: 'OFFERED' };
  if (exceptOfferId) filter._id = { $ne: exceptOfferId };
  await ctx.models.Offer.updateMany(filter, { $set: { status: 'CANCELLED', respondedAt: ctx.now() } }, { session });
}

/** Outbox emit (producer delivery, aggregate = jobId by default). */
export function emit<T extends EventType>(ctx: DeliveryContext, session: ClientSession, type: T, payload: EventPayloads[T], aggregateId: string) {
  return emitEvent(ctx.conn, session, type, payload, { producer: 'delivery', aggregateId });
}

export const atIso = (d: Date) => d.toISOString();

/**
 * ASSIGNED/AT_PICKUP → PENDING_ASSIGNMENT (admin unassign / reassign, partner suspension):
 * releases the partner's capacity, resets dispatch so the job is re-offered on the next tick,
 * emits `delivery.unassigned`.
 */
export async function unassignJob(
  ctx: DeliveryContext,
  session: ClientSession,
  job: JobLean,
  actor: Actor,
  opts: { actorId?: string | null; reason: string },
): Promise<JobLean> {
  const updated = await transitionJob(ctx, session, job, 'PENDING_ASSIGNMENT', actor, {
    actorId: opts.actorId,
    reason: opts.reason,
    set: { partnerId: null, partnerUserId: null, assignedAt: null, dispatchRound: 0, nextDispatchAt: ctx.now(), exception: false, exceptionReason: null, codeAttempts: 0 },
  });
  await releasePartnerCapacity(ctx, session, job.partnerId, job._id);
  await emit(ctx, session, 'delivery.unassigned', { jobId: job._id.toString(), childOrderId: job.childOrderId, reason: opts.reason }, job._id.toString());
  return updated;
}
