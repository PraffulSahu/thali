/**
 * Memberships (context §3 "Membership", LLD 3.2, §6, §9).
 *
 *  - Prepaid plans only (no auto-renewal). `planSnapshot` freezes price + benefits at purchase.
 *  - Purchase: PENDING_PAYMENT membership (one per user+plan, reused) → payments
 *    `POST /internal/payment-intents {purpose:'MEMBERSHIP', referenceId: membershipId}` (idempotent per
 *    reference). Nothing is emitted until `payment.captured` (purpose MEMBERSHIP) activates it.
 *  - Activation: PENDING_PAYMENT|CANCELLED → ACTIVE iff the captured amount equals the snapshot price;
 *    `startsAt = now` (or the end of a still-active membership), `endsAt = startsAt + durationDays`;
 *    emits `membership.activated` in the same transaction. Re-deliveries are no-ops.
 *  - Benefits (LLD 6): children with `itemsSubtotal ≥ freeDeliveryMinOrderPaise` and a non-zero fee,
 *    highest fee first (ties by restaurantId), limited to the remaining quota
 *    (`freeDeliveriesPerPeriod − used − held`, per membership term).
 */
import { Types, type ClientSession } from 'mongoose';
import { DomainError, type EventPayloads } from '@thali/contracts';
import { emitEvent } from '@thali/service-kit';
import type { AppContext } from '../context.js';
import type { MembershipDoc } from '../models/membership.js';
import type { MembershipPlanDoc } from '../models/membership-plan.js';

export type MembershipLean = MembershipDoc & { _id: Types.ObjectId; createdAt?: Date; updatedAt?: Date };
export type PlanLean = MembershipPlanDoc & { _id: Types.ObjectId; createdAt?: Date; updatedAt?: Date };

const DAY_MS = 86_400_000;
const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

export function benefitsView(b: PlanLean['benefits']) {
  return {
    freeDeliveryMinOrderPaise: b.freeDeliveryMinOrderPaise,
    freeDeliveriesPerPeriod: b.freeDeliveriesPerPeriod,
    extraDiscountBps: b.extraDiscountBps,
    extraDiscountCapPaise: b.extraDiscountCapPaise,
  };
}

export function planView(p: PlanLean) {
  return {
    id: String(p._id),
    name: p.name,
    pricePaise: p.pricePaise,
    durationDays: p.durationDays,
    benefits: benefitsView(p.benefits),
    terms: p.terms ?? '',
    active: p.active !== false,
  };
}

export const remainingFreeDeliveries = (m: Pick<MembershipLean, 'planSnapshot' | 'freeDeliveriesUsed' | 'freeDeliveriesHeld'>) =>
  Math.max(0, m.planSnapshot.benefits.freeDeliveriesPerPeriod - (m.freeDeliveriesUsed ?? 0) - (m.freeDeliveriesHeld ?? 0));

export function membershipView(m: MembershipLean) {
  return {
    id: String(m._id),
    planId: String(m.planId),
    plan: {
      name: m.planSnapshot.name,
      pricePaise: m.planSnapshot.pricePaise,
      durationDays: m.planSnapshot.durationDays,
      benefits: benefitsView(m.planSnapshot.benefits),
      terms: m.planSnapshot.terms ?? '',
    },
    status: m.status,
    startsAt: iso(m.startsAt),
    endsAt: iso(m.endsAt),
    paymentIntentId: m.paymentIntentId ?? null,
    freeDeliveriesUsed: m.freeDeliveriesUsed ?? 0,
    freeDeliveriesRemaining: m.status === 'ACTIVE' ? remainingFreeDeliveries(m) : 0,
    createdAt: iso(m.createdAt),
  };
}

export async function listActivePlans(ctx: AppContext) {
  const rows = await ctx.models.MembershipPlan.find({ active: true }).sort({ pricePaise: 1, _id: 1 }).lean<PlanLean[]>();
  return rows.map(planView);
}

/** The user's membership in force right now (ACTIVE and inside its term), if any. */
export async function currentMembership(ctx: AppContext, userId: string, session?: ClientSession) {
  const now = ctx.now();
  const q = ctx.models.Membership.findOne({ userId, status: 'ACTIVE', startsAt: { $lte: now }, endsAt: { $gt: now } }).sort({ endsAt: -1 });
  if (session) q.session(session);
  return q.lean<MembershipLean>();
}

export async function myMemberships(ctx: AppContext, userId: string) {
  const [current, history] = await Promise.all([
    currentMembership(ctx, userId),
    ctx.models.Membership.find({ userId }).sort({ createdAt: -1, _id: -1 }).limit(50).lean<MembershipLean[]>(),
  ]);
  return { current: current ? membershipView(current) : null, history: history.map(membershipView) };
}

export async function purchaseMembership(ctx: AppContext, userId: string, planId: string) {
  if (!Types.ObjectId.isValid(planId)) throw new DomainError('NOT_FOUND', 'Plan not found');
  const plan = await ctx.models.MembershipPlan.findOne({ _id: new Types.ObjectId(planId), active: true }).lean<PlanLean>();
  if (!plan) throw new DomainError('NOT_FOUND', 'Plan not found');
  const active = await currentMembership(ctx, userId);
  if (active) throw new DomainError('CONFLICT', `You already have an active membership until ${iso(active.endsAt)}`, undefined, { membershipId: String(active._id) });

  const snapshot = { name: plan.name, pricePaise: plan.pricePaise, durationDays: plan.durationDays, benefits: benefitsView(plan.benefits), terms: plan.terms ?? '' };
  // a pending purchase whose price no longer matches the plan is superseded
  await ctx.models.Membership.updateMany(
    { userId, planId: plan._id, status: 'PENDING_PAYMENT', 'planSnapshot.pricePaise': { $ne: plan.pricePaise } },
    { $set: { status: 'CANCELLED', statusReason: 'SUPERSEDED' } },
  );
  let pending: MembershipLean | null = null;
  for (let attempt = 0; attempt < 3 && !pending; attempt++) {
    try {
      pending = await ctx.models.Membership.findOneAndUpdate(
        { userId, planId: plan._id, status: 'PENDING_PAYMENT' },
        { $setOnInsert: { userId, planId: plan._id, planSnapshot: snapshot, status: 'PENDING_PAYMENT', freeDeliveriesUsed: 0, freeDeliveriesHeld: 0, usage: [] } },
        { upsert: true, new: true },
      ).lean<MembershipLean>();
    } catch (e) {
      if ((e as { code?: number })?.code !== 11000) throw e; // concurrent upsert lost the race → re-read
    }
  }
  if (!pending) throw new DomainError('CONFLICT', 'Could not start the purchase, please retry');

  let payment;
  try {
    payment = await ctx.payments.createIntent({ purpose: 'MEMBERSHIP', referenceId: String(pending._id), userId, amountPaise: pending.planSnapshot.pricePaise });
  } catch (err) {
    ctx.logger.warn({ err, membershipId: String(pending._id) }, 'membership payment intent failed');
    throw new DomainError('PAYMENT_PROVIDER_UNAVAILABLE', 'Payments are temporarily unavailable, please retry');
  }
  const updated = await ctx.models.Membership.findOneAndUpdate({ _id: pending._id }, { $set: { paymentIntentId: payment.paymentIntentId } }, { new: true }).lean<MembershipLean>();
  return { membership: membershipView(updated ?? pending), payment };
}

/** `payment.captured` (purpose MEMBERSHIP) — inside the consumer's transaction. */
export async function activateMembership(ctx: AppContext, session: ClientSession, p: EventPayloads['payment.captured'], correlationId?: string) {
  if (!Types.ObjectId.isValid(p.referenceId)) return 'MISSING';
  const m = await ctx.models.Membership.findById(p.referenceId).session(session).lean<MembershipLean>();
  if (!m) {
    ctx.logger.warn({ referenceId: p.referenceId }, 'payment.captured for unknown membership');
    return 'MISSING';
  }
  if (m.status !== 'PENDING_PAYMENT' && m.status !== 'CANCELLED') return 'NOOP';
  if (p.amountPaise !== m.planSnapshot.pricePaise) {
    ctx.logger.error({ membershipId: String(m._id), amountPaise: p.amountPaise, expected: m.planSnapshot.pricePaise }, 'membership capture amount mismatch; not activating');
    return 'AMOUNT_MISMATCH';
  }
  const now = ctx.now();
  const other = await currentMembership(ctx, m.userId, session);
  const startsAt = other?.endsAt && new Date(other.endsAt) > now ? new Date(other.endsAt) : now;
  const endsAt = new Date(startsAt.getTime() + m.planSnapshot.durationDays * DAY_MS);
  const upd = await ctx.models.Membership.updateOne(
    { _id: m._id, status: { $in: ['PENDING_PAYMENT', 'CANCELLED'] } },
    { $set: { status: 'ACTIVE', startsAt, endsAt, paymentIntentId: p.paymentIntentId }, $unset: { statusReason: 1 } },
    { session },
  );
  if (upd.modifiedCount !== 1) return 'NOOP';
  await emitEvent(
    ctx.conn,
    session,
    'membership.activated',
    { membershipId: String(m._id), userId: m.userId, planId: String(m.planId), endsAt: endsAt.toISOString() },
    { producer: 'marketplace', aggregateId: String(m._id), ...(correlationId ? { correlationId } : {}) },
  );
  return 'ACTIVATED';
}

/** `payment.failed` (purpose MEMBERSHIP). A later capture on the same provider order still activates. */
export async function failMembershipPayment(ctx: AppContext, session: ClientSession, p: EventPayloads['payment.failed']) {
  if (!Types.ObjectId.isValid(p.referenceId)) return;
  await ctx.models.Membership.updateOne(
    { _id: new Types.ObjectId(p.referenceId), status: 'PENDING_PAYMENT' },
    { $set: { status: 'CANCELLED', statusReason: `PAYMENT_FAILED: ${p.reason}`.slice(0, 200) } },
    { session },
  );
}

export interface BenefitsInput {
  userId: string;
  children: { restaurantId: string; itemsSubtotalPaise: number; deliveryFeePaise: number }[];
}

/** `POST /internal/memberships/benefits` (LLD §6 free-delivery selection rule). */
export async function membershipBenefits(ctx: AppContext, input: BenefitsInput) {
  const m = await currentMembership(ctx, input.userId);
  if (!m) return { membershipId: null, freeDeliveryRestaurantIds: [] as string[], extraDiscountBps: 0, extraDiscountCapPaise: 0 };
  const b = m.planSnapshot.benefits;
  const remaining = remainingFreeDeliveries(m);
  const free = input.children
    .filter((c) => c.itemsSubtotalPaise >= b.freeDeliveryMinOrderPaise && c.deliveryFeePaise > 0)
    .sort((x, y) => y.deliveryFeePaise - x.deliveryFeePaise || (x.restaurantId < y.restaurantId ? -1 : x.restaurantId > y.restaurantId ? 1 : 0))
    .slice(0, remaining)
    .map((c) => c.restaurantId);
  return {
    membershipId: String(m._id),
    freeDeliveryRestaurantIds: free,
    extraDiscountBps: b.extraDiscountBps,
    extraDiscountCapPaise: b.extraDiscountCapPaise,
    freeDeliveriesRemaining: remaining,
    endsAt: iso(m.endsAt),
  };
}

/** Sweeper: ACTIVE memberships past `endsAt` → EXPIRED. */
export async function expireMemberships(ctx: AppContext): Promise<number> {
  const r = await ctx.models.Membership.updateMany({ status: 'ACTIVE', endsAt: { $lte: ctx.now() } }, { $set: { status: 'EXPIRED' } });
  return r.modifiedCount;
}
