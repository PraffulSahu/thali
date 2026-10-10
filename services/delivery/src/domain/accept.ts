/**
 * Atomic offer acceptance — LLD 7, implemented exactly as four conditional writes inside ONE
 * Mongo transaction (snapshot isolation, majority write concern):
 *   1. offer  {_id, partnerId: me, status: OFFERED, expiresAt > now} → ACCEPTED   else 409 OFFER_EXPIRED
 *   2. job    {_id, status ∈ [PENDING_ASSIGNMENT, OFFERED], partnerId: null} → ASSIGNED   else 409 ASSIGNMENT_TAKEN
 *   3. partner {_id, status: APPROVED, online: true, |activeJobIds| < MAX} → $push jobId   else 409 CAPACITY_EXCEEDED
 *   4. cancel the job's other OFFERED offers; outbox `delivery.assigned`.
 * Any failure throws → the whole transaction aborts (no partial assignment). Concurrent accepts that
 * touch the same job/partner document hit a WriteConflict; the driver retries the callback, and the
 * retried filters no longer match → the loser gets its 409. Exactly one winner per job, and a
 * partner can never exceed capacity.
 */
import type { Types } from 'mongoose';
import { DomainError, assertTransition, deliveryTransitions, type DeliveryStatus } from '@thali/contracts';
import { withTransaction } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import type { JobLean } from '../models/delivery-job.js';
import type { OfferLean } from '../models/delivery-offer.js';
import type { PartnerLean } from '../models/partner.js';
import { emit, historyEntry } from './job-state.js';
import { requirePartner } from './onboarding.js';

export async function acceptOffer(ctx: DeliveryContext, userId: string, offerId: string): Promise<{ offer: OfferLean; job: JobLean }> {
  const me = await requirePartner(ctx, userId);
  const owned = await ctx.models.Offer.exists({ _id: offerId, partnerId: me._id });
  if (!owned) throw new DomainError('NOT_FOUND', 'Offer not found');

  return withTransaction(ctx.conn, async (session) => {
    const now = ctx.now();

    // 1. claim my live offer
    const offer = await ctx.models.Offer.findOneAndUpdate(
      { _id: offerId, partnerId: me._id, status: 'OFFERED', expiresAt: { $gt: now } },
      { $set: { status: 'ACCEPTED', respondedAt: now } },
      { session, new: true },
    ).lean<OfferLean>();
    if (!offer) throw new DomainError('OFFER_EXPIRED', 'This offer has expired or is no longer available');

    // 2. assign the job iff nobody else holds it
    const before = await ctx.models.Job.findOneAndUpdate(
      { _id: offer.jobId, status: { $in: ['PENDING_ASSIGNMENT', 'OFFERED'] }, partnerId: null },
      { $set: { status: 'ASSIGNED', partnerId: me._id, partnerUserId: me.userId, assignedAt: now, nextDispatchAt: null, codeAttempts: 0 } },
      { session, new: false },
    ).lean<JobLean>();
    if (!before) throw new DomainError('ASSIGNMENT_TAKEN', 'Another partner already accepted this delivery');
    assertTransition(deliveryTransitions, before.status as DeliveryStatus, 'ASSIGNED', 'PARTNER');
    const job = await ctx.models.Job.findOneAndUpdate(
      { _id: before._id },
      { $push: { statusHistory: historyEntry(before.status, 'ASSIGNED', now, 'PARTNER', me.userId) } },
      { session, new: true },
    ).lean<JobLean>();

    // 3. reserve partner capacity
    const partner = await reserveCapacity(ctx, me._id, before._id, session);
    if (!partner) throw new DomainError('CAPACITY_EXCEEDED', 'You are at your active delivery limit or not online');

    // 4. close competing offers + outbox
    await ctx.models.Offer.updateMany(
      { jobId: before._id, status: 'OFFERED', _id: { $ne: offer._id } },
      { $set: { status: 'CANCELLED', respondedAt: now } },
      { session },
    );
    await emitAssigned(ctx, session, job!, partner);
    return { offer, job: job! };
  });
}

/** LLD 7 step 3 (shared with admin manual assign). */
export function reserveCapacity(ctx: DeliveryContext, partnerId: Types.ObjectId, jobId: Types.ObjectId, session: import('mongoose').ClientSession) {
  const max = ctx.config.MAX_ACTIVE_DELIVERIES;
  return ctx.models.Partner.findOneAndUpdate(
    {
      _id: partnerId,
      status: 'APPROVED',
      online: true,
      $expr: { $lt: [{ $size: '$activeJobIds' }, { $min: [{ $ifNull: ['$maxActive', max] }, max] }] },
    },
    { $push: { activeJobIds: jobId } },
    { session, new: true },
  ).lean<PartnerLean>();
}

export function emitAssigned(ctx: DeliveryContext, session: import('mongoose').ClientSession, job: JobLean, partner: PartnerLean) {
  return emit(
    ctx,
    session,
    'delivery.assigned',
    {
      jobId: job._id.toString(),
      childOrderId: job.childOrderId,
      partnerId: partner._id.toString(),
      partnerUserId: partner.userId,
      partnerName: partner.name,
      vehicle: { type: partner.vehicle!.type, registrationNumber: partner.vehicle!.registrationNumber },
    },
    job._id.toString(),
  );
}

/** POST /deliveries/offers/:offerId/reject. If no live offers remain, the next round starts on the next tick. */
export async function rejectOffer(ctx: DeliveryContext, userId: string, offerId: string): Promise<OfferLean> {
  const me = await requirePartner(ctx, userId);
  const now = ctx.now();
  const offer = await ctx.models.Offer.findOneAndUpdate(
    { _id: offerId, partnerId: me._id, status: 'OFFERED', expiresAt: { $gt: now } },
    { $set: { status: 'REJECTED', respondedAt: now } },
    { new: true },
  ).lean<OfferLean>();
  if (!offer) {
    const exists = await ctx.models.Offer.exists({ _id: offerId, partnerId: me._id });
    if (!exists) throw new DomainError('NOT_FOUND', 'Offer not found');
    throw new DomainError('OFFER_EXPIRED', 'This offer has expired or is no longer available');
  }
  const live = await ctx.models.Offer.exists({ jobId: offer.jobId, status: 'OFFERED', expiresAt: { $gt: now } });
  if (!live) await ctx.models.Job.updateOne({ _id: offer.jobId, partnerId: null, status: { $in: ['PENDING_ASSIGNMENT', 'OFFERED'] } }, { $set: { nextDispatchAt: now } });
  return offer;
}
