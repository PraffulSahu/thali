/**
 * Coupons (LLD 3.2, §6 step 2, §8 step 4). Marketplace computes the coupon discount D against the
 * checkout's Σ itemsSubtotal; `@thali/pricing` allocates it pro-rata across children.
 *
 *  - FLAT: `min(valuePaise, subtotal)`.
 *  - PERCENT: `bpsOf(subtotal, valueBps)` (integer half-up), capped by `maxDiscountPaise`, ≤ subtotal.
 *  - Invalid → 422 COUPON_INVALID with `details.reason` (NOT_FOUND | INACTIVE | NOT_STARTED | EXPIRED |
 *    MIN_ORDER | FIRST_ORDER_ONLY | NO_DISCOUNT); exhausted → 422 COUPON_LIMIT_REACHED
 *    (`details.reason` TOTAL_LIMIT | PER_USER_LIMIT). Per-user usage counts HELD + REDEEMED.
 *  - "First order" = the user has no COMMITTED stock reservation (every placed checkout commits one).
 */
import type { ClientSession } from 'mongoose';
import { bpsOf, DomainError } from '@thali/contracts';
import type { AppContext } from '../context.js';
import type { CouponDoc } from '../models/coupon.js';

export type CouponLean = CouponDoc & { _id: unknown; createdAt?: Date; updatedAt?: Date };

export const normalizeCode = (code: string) => code.trim().toUpperCase();

export function computeDiscount(c: Pick<CouponLean, 'type' | 'valuePaise' | 'valueBps' | 'maxDiscountPaise'>, subtotalPaise: number): number {
  const subtotal = Math.max(0, Math.floor(subtotalPaise));
  let d = c.type === 'FLAT' ? (c.valuePaise ?? 0) : bpsOf(subtotal, c.valueBps ?? 0);
  if (c.type === 'PERCENT' && c.maxDiscountPaise != null) d = Math.min(d, c.maxDiscountPaise);
  return Math.max(0, Math.min(d, subtotal));
}

export const couponInvalid = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  new DomainError('COUPON_INVALID', message, undefined, { reason, ...extra });
export const couponLimit = (reason: 'TOTAL_LIMIT' | 'PER_USER_LIMIT', message: string) =>
  new DomainError('COUPON_LIMIT_REACHED', message, undefined, { reason });

/** Active + inside the validity window (throws COUPON_INVALID). */
export function assertCouponLive(c: CouponLean | null, now: Date): asserts c is CouponLean {
  if (!c) throw couponInvalid('NOT_FOUND', 'This coupon code is not valid');
  if (!c.active) throw couponInvalid('INACTIVE', 'This coupon is no longer active');
  if (now < new Date(c.validFrom)) throw couponInvalid('NOT_STARTED', 'This coupon is not active yet', { validFrom: new Date(c.validFrom).toISOString() });
  if (now > new Date(c.validTo)) throw couponInvalid('EXPIRED', 'This coupon has expired');
}

export async function hasPlacedOrder(ctx: AppContext, userId: string, session?: ClientSession): Promise<boolean> {
  const q = ctx.models.StockReservation.exists({ userId, status: 'COMMITTED' });
  if (session) q.session(session);
  return !!(await q);
}

export async function userRedemptionCount(ctx: AppContext, couponId: unknown, userId: string, session?: ClientSession): Promise<number> {
  const q = ctx.models.CouponRedemption.countDocuments({ couponId, userId, status: { $in: ['HELD', 'REDEEMED'] } });
  if (session) q.session(session);
  return q;
}

export const totalExhausted = (c: Pick<CouponLean, 'totalLimit' | 'usedCount' | 'heldCount'>) =>
  c.totalLimit != null && (c.usedCount ?? 0) + (c.heldCount ?? 0) >= c.totalLimit;

/** `POST /internal/coupons/validate` → `{ code, discountPaise }` (+ description for display). */
export async function validateCoupon(ctx: AppContext, input: { code: string; userId: string; itemsSubtotalPaise: number }) {
  const code = normalizeCode(input.code);
  const c = await ctx.models.Coupon.findOne({ code }).lean<CouponLean>();
  assertCouponLive(c, ctx.now());
  if (input.itemsSubtotalPaise < (c.minOrderPaise ?? 0)) {
    throw couponInvalid('MIN_ORDER', `Add items worth ₹${((c.minOrderPaise ?? 0) / 100).toFixed(2)} or more to use this coupon`, { minOrderPaise: c.minOrderPaise ?? 0 });
  }
  if (c.firstOrderOnly && (await hasPlacedOrder(ctx, input.userId))) throw couponInvalid('FIRST_ORDER_ONLY', 'This coupon is valid on your first order only');
  if (totalExhausted(c)) throw couponLimit('TOTAL_LIMIT', 'This coupon has been fully used');
  if (c.perUserLimit != null && (await userRedemptionCount(ctx, c._id, input.userId)) >= c.perUserLimit) {
    throw couponLimit('PER_USER_LIMIT', 'You have already used this coupon');
  }
  const discountPaise = computeDiscount(c, input.itemsSubtotalPaise);
  if (discountPaise <= 0) throw couponInvalid('NO_DISCOUNT', 'This coupon gives no discount on this order');
  return { code: c.code, discountPaise, description: c.description ?? '' };
}

export function couponPublicView(c: CouponLean, remainingUses: number | null) {
  return {
    code: c.code,
    description: c.description ?? '',
    type: c.type,
    valuePaise: c.type === 'FLAT' ? (c.valuePaise ?? 0) : null,
    valueBps: c.type === 'PERCENT' ? (c.valueBps ?? 0) : null,
    maxDiscountPaise: c.maxDiscountPaise ?? null,
    minOrderPaise: c.minOrderPaise ?? 0,
    validTo: new Date(c.validTo).toISOString(),
    firstOrderOnly: !!c.firstOrderOnly,
    remainingUses,
  };
}

/** `GET /coupons/available` — coupons this user can apply right now (server-enforced eligibility). */
export async function availableCoupons(ctx: AppContext, userId: string) {
  const now = ctx.now();
  const rows = await ctx.models.Coupon.find({ active: true, validFrom: { $lte: now }, validTo: { $gte: now } })
    .sort({ validTo: 1, _id: 1 })
    .limit(100)
    .lean<CouponLean[]>();
  const live = rows.filter((c) => !totalExhausted(c));
  if (!live.length) return [];
  const [placed, used] = await Promise.all([
    hasPlacedOrder(ctx, userId),
    ctx.models.CouponRedemption.aggregate<{ _id: unknown; n: number }>([
      { $match: { userId, couponId: { $in: live.map((c) => c._id) }, status: { $in: ['HELD', 'REDEEMED'] } } },
      { $group: { _id: '$couponId', n: { $sum: 1 } } },
    ]),
  ]);
  const usedBy = new Map(used.map((u) => [String(u._id), u.n]));
  return live
    .filter((c) => !(c.firstOrderOnly && placed))
    .map((c) => ({ c, remaining: c.perUserLimit == null ? null : c.perUserLimit - (usedBy.get(String(c._id)) ?? 0) }))
    .filter((x) => x.remaining === null || x.remaining > 0)
    .map((x) => couponPublicView(x.c, x.remaining));
}
