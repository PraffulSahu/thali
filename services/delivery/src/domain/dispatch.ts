/**
 * Dispatch rounds (LLD 7). A round offers job j to the best OFFERS_PER_ROUND eligible partners:
 *   status APPROVED, online, lastLocationAt within DISPATCH_LOCATION_MAX_AGE_SEC (120 s),
 *   straight-line distance to pickup ≤ round radius (DISPATCH_RADIUS_KM[round-1], last repeats),
 *   no live OFFERED offer for j, never rejected j, and idle or batch-eligible (evaluateBatch).
 * Ranking: idle partners first, then ascending distance to pickup.
 *
 * Writes (job round bump + offers) commit in one transaction guarded by the job's current
 * `dispatchRound`, so two dispatchers can never run the same round twice. Realtime `partner.offer`
 * is published after commit.
 */
import type { Types } from 'mongoose';
import { DomainError, assertTransition, deliveryTransitions, type DeliveryStatus } from '@thali/contracts';
import { publishRealtime, realtimeChannel, withTransaction } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import type { JobLean } from '../models/delivery-job.js';
import type { PartnerLean } from '../models/partner.js';
import { evaluateBatch, type BatchEvaluation, type BatchPolicy } from './batching.js';
import { haversineKm, toLatLng } from './geo.js';
import { emit, historyEntry, transitionJob } from './job-state.js';

const EARTH_RADIUS_KM = 6378.1;

export function batchPolicy(ctx: DeliveryContext, maxActive?: number): BatchPolicy {
  const c = ctx.config;
  return {
    maxActive: Math.min(maxActive ?? c.MAX_ACTIVE_DELIVERIES, c.MAX_ACTIVE_DELIVERIES),
    pickupRadiusKm: c.BATCH_PICKUP_RADIUS_KM,
    dropRadiusKm: c.BATCH_DROP_RADIUS_KM,
    maxExtraMinutes: c.BATCH_MAX_EXTRA_MINUTES,
    roadFactor: c.ROAD_FACTOR,
    avgSpeedKmph: c.AVG_SPEED_KMPH,
  };
}

export function roundRadiusKm(ctx: DeliveryContext, round: number): number {
  const radii = ctx.config.DISPATCH_RADIUS_KM;
  return radii[Math.min(Math.max(round, 1), radii.length) - 1]!;
}

export interface Candidate {
  partner: PartnerLean;
  distanceKm: number;
  evaluation: BatchEvaluation;
  idle: boolean;
}

/** Eligible, ranked candidates for `job` in `round` (read-only). */
export async function findCandidates(ctx: DeliveryContext, job: JobLean, round: number): Promise<Candidate[]> {
  const now = ctx.now();
  const radiusKm = roundRadiusKm(ctx, round);
  const pickup = toLatLng(job.pickup.location);

  const excluded = await ctx.models.Offer.find(
    { jobId: job._id, $or: [{ status: 'OFFERED', expiresAt: { $gt: now } }, { status: 'REJECTED' }] },
    { partnerId: 1 },
  ).lean();
  const excludedIds = excluded.map((o) => o.partnerId);

  const partners = await ctx.models.Partner.find({
    status: 'APPROVED',
    online: true,
    lastLocationAt: { $gte: new Date(now.getTime() - ctx.config.DISPATCH_LOCATION_MAX_AGE_SEC * 1000) },
    lastLocation: { $geoWithin: { $centerSphere: [[pickup.lng, pickup.lat], (radiusKm * 1.01) / EARTH_RADIUS_KM] } },
    _id: { $nin: excludedIds },
  }).lean<PartnerLean[]>();

  const activeIds = partners.flatMap((p) => p.activeJobIds ?? []);
  const activeJobs = activeIds.length ? await ctx.models.Job.find({ _id: { $in: activeIds } }).lean<JobLean[]>() : [];
  const byId = new Map(activeJobs.map((j) => [j._id.toString(), j]));
  const candidateJob = { restaurantId: job.restaurantId, pickup, drop: toLatLng(job.drop.location) };

  const out: Candidate[] = [];
  for (const partner of partners) {
    if (!partner.lastLocation) continue;
    const loc = toLatLng(partner.lastLocation);
    const distanceKm = haversineKm(loc, pickup);
    if (distanceKm > radiusKm) continue;
    const mine = (partner.activeJobIds ?? []).map((id) => byId.get(id.toString())).filter((j): j is JobLean => !!j);
    const evaluation = evaluateBatch(
      { location: loc, activeJobIds: (partner.activeJobIds ?? []).map(String) },
      mine.map((j) => ({ id: j._id.toString(), status: j.status, restaurantId: j.restaurantId, pickup: toLatLng(j.pickup.location), drop: toLatLng(j.drop.location) })),
      candidateJob,
      batchPolicy(ctx, partner.maxActive),
    );
    if (!evaluation.eligible) continue;
    out.push({ partner, distanceKm, evaluation, idle: (partner.activeJobIds ?? []).length === 0 });
  }
  out.sort((a, b) => (a.idle === b.idle ? a.distanceKm - b.distanceKm : a.idle ? -1 : 1));
  return out.slice(0, ctx.config.OFFERS_PER_ROUND);
}

export type RoundOutcome = { kind: 'skipped' } | { kind: 'offered'; round: number; offers: number } | { kind: 'exception' };

/**
 * Advance `job` by one dispatch step: flag an exception once MAX_DISPATCH_ROUNDS are exhausted,
 * otherwise start the next round. Caller guarantees the job has no live offers.
 */
export async function advanceDispatch(ctx: DeliveryContext, jobId: Types.ObjectId): Promise<RoundOutcome> {
  const job = await ctx.models.Job.findById(jobId).lean<JobLean>();
  if (!job || job.partnerId || job.exception || !['PENDING_ASSIGNMENT', 'OFFERED'].includes(job.status)) return { kind: 'skipped' };

  if (job.dispatchRound >= ctx.config.MAX_DISPATCH_ROUNDS) {
    const flagged = await withTransaction(ctx.conn, async (session) => {
      const fresh = await ctx.models.Job.findOne({ _id: job._id, dispatchRound: job.dispatchRound, exception: { $ne: true }, partnerId: null }, null, { session }).lean<JobLean>();
      if (!fresh || !['PENDING_ASSIGNMENT', 'OFFERED'].includes(fresh.status)) return false;
      const reason = `No partner accepted after ${fresh.dispatchRound} dispatch rounds`;
      // all offers expired → back to PENDING_ASSIGNMENT; the exception flag leaves status unchanged (LLD 4.5)
      const base = fresh.status === 'OFFERED' ? await transitionJob(ctx, session, fresh, 'PENDING_ASSIGNMENT', 'SYSTEM', { reason: 'offers expired' }) : fresh;
      await ctx.models.Job.updateOne({ _id: base._id, status: base.status }, { $set: { exception: true, exceptionReason: reason, nextDispatchAt: null } }, { session });
      await emit(ctx, session, 'delivery.exception', { jobId: fresh._id.toString(), childOrderId: fresh.childOrderId, reason }, fresh._id.toString());
      return true;
    });
    return flagged ? { kind: 'exception' } : { kind: 'skipped' };
  }

  const round = job.dispatchRound + 1;
  const candidates = await findCandidates(ctx, job, round);
  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + ctx.config.OFFER_TTL_SEC * 1000);

  const offers = await withTransaction(ctx.conn, async (session) => {
    const fresh = await ctx.models.Job.findOne({ _id: job._id, dispatchRound: job.dispatchRound, partnerId: null, exception: { $ne: true } }, null, { session }).lean<JobLean>();
    if (!fresh || !['PENDING_ASSIGNMENT', 'OFFERED'].includes(fresh.status)) return null;
    const to: DeliveryStatus = candidates.length ? 'OFFERED' : 'PENDING_ASSIGNMENT';
    const update: Record<string, unknown> = { $set: { dispatchRound: round, nextDispatchAt: expiresAt, status: to } };
    if (fresh.status !== to) {
      assertTransition(deliveryTransitions, fresh.status as DeliveryStatus, to, 'SYSTEM');
      update.$push = { statusHistory: historyEntry(fresh.status, to, now, 'SYSTEM', null, to === 'OFFERED' ? `round ${round}` : 'offers expired') };
    }
    const res = await ctx.models.Job.updateOne({ _id: fresh._id, status: fresh.status, dispatchRound: fresh.dispatchRound }, update, { session });
    if (!res.modifiedCount) throw new DomainError('CONFLICT', 'job changed during dispatch');
    if (!candidates.length) return [];
    return ctx.models.Offer.insertMany(
      candidates.map((c) => ({
        jobId: fresh._id,
        partnerId: c.partner._id,
        partnerUserId: c.partner.userId,
        status: 'OFFERED',
        expiresAt,
        batchEvaluation: c.evaluation,
        distanceToPickupKm: Math.round(c.distanceKm * 100) / 100,
        round,
      })),
      { session },
    );
  });
  if (offers === null) return { kind: 'skipped' };

  for (const o of offers) {
    await publishRealtime(ctx.redis, realtimeChannel.partner(o.partnerUserId), 'partner.offer', {
      offerId: o._id.toString(),
      jobId: o.jobId.toString(),
      expiresAt: o.expiresAt.toISOString(),
    }).catch((err) => ctx.logger.warn({ err, offerId: o._id.toString() }, 'partner.offer publish failed'));
  }
  return { kind: 'offered', round, offers: offers.length };
}

/** Expire OFFERED offers past their TTL (conditional on status, so an in-flight accept wins or loses atomically). */
export async function expireOffers(ctx: DeliveryContext): Promise<number> {
  const now = ctx.now();
  const res = await ctx.models.Offer.updateMany({ status: 'OFFERED', expiresAt: { $lte: now } }, { $set: { status: 'EXPIRED', respondedAt: now } });
  return res.modifiedCount;
}

/** Jobs due for their next dispatch step (no live offers). */
export async function dueJobs(ctx: DeliveryContext, limit = 100): Promise<Types.ObjectId[]> {
  const now = ctx.now();
  const jobs = await ctx.models.Job.find(
    {
      status: { $in: ['PENDING_ASSIGNMENT', 'OFFERED'] },
      partnerId: null,
      exception: { $ne: true },
      $or: [{ nextDispatchAt: null }, { nextDispatchAt: { $lte: now } }],
    },
    { _id: 1 },
  )
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  if (!jobs.length) return [];
  const live = await ctx.models.Offer.distinct('jobId', { jobId: { $in: jobs.map((j) => j._id) }, status: 'OFFERED', expiresAt: { $gt: now } });
  const liveSet = new Set(live.map(String));
  return jobs.map((j) => j._id).filter((id) => !liveSet.has(id.toString()));
}
