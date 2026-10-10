/**
 * Coupons (LLD 3.2, §6 step 2, §8 step 4). Marketplace computes the coupon discount D against the
 * checkout's Σ itemsSubtotal; `@thali/pricing` allocates it pro-rata across children.
 *
 *  - FLAT: `min(valuePaise, subtotal)`.
 *  - PERCENT: `bpsOf(subtotal, valueBps)` (integer half-up), capped by `maxDiscountPaise`, ≤ subtotal.
 *  - Invalid → 422 COUPON_INVALID with `details.reason` (NOT_FOUND | INACTIVE | NOT_STARTED | EXPIRED |
 *    MIN_ORDER | FIRST_ORDER_ONLY | NO_DISCOUNT); exhausted → 422 COUPON_LIMIT_REACHED
 *    (`details.reason` TOTAL_LIMIT | PER_USER_LIMIT). Per-user usage counts HELD + REDEEMED.
 *  - First-order-only: disqualified by any COMMITTED stock reservation (every placed checkout commits
 *    one) OR any HELD/REDEEMED redemption of any firstOrderOnly coupon (`firstOrderGuard`, unique per user).
 */
import type { ClientSession } from 'mongoose';
import { bpsOf, DomainError } from '@thali/contracts';
import { couponNotApplicableError, couponScope } from '@thali/pricing';
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

/** True when the user may no longer use a firstOrderOnly coupon. */
export async function firstOrderUsed(ctx: AppContext, userId: string, session?: ClientSession): Promise<boolean> {
  if (await hasPlacedOrder(ctx, userId, session)) return true;
  const q = ctx.models.CouponRedemption.exists({ userId, firstOrderGuard: true });
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

const rupees = (paise: number) => {
  const r = paise / 100;
  return `₹${Number.isInteger(r) ? r.toLocaleString('en-IN') : r.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** MKT-7: "50% off up to ₹100" / "₹100 off" — one server-side wording for every client. */
export function offerHeadline(c: Pick<CouponLean, 'type' | 'valuePaise' | 'valueBps' | 'maxDiscountPaise'>): string {
  if (c.type === 'PERCENT') return `${percent(c.valueBps ?? 0)} off${c.maxDiscountPaise != null ? ` up to ${rupees(c.maxDiscountPaise)}` : ''}`;
  return `${rupees(c.valuePaise ?? 0)} off`;
}

/** MKT-8: card badge — the admin's `badgeLabel`, else "20% OFF" / "₹100 OFF". */
export function badgeOf(c: Pick<CouponLean, 'type' | 'valuePaise' | 'valueBps' | 'badgeLabel'>): string {
  if (c.badgeLabel) return c.badgeLabel;
  return c.type === 'PERCENT' ? `${percent(c.valueBps ?? 0)} OFF` : `${rupees(c.valuePaise ?? 0)} OFF`;
}

export const scopeOf = (c: Pick<CouponLean, 'restaurantIds'>) => (c.restaurantIds ?? []).map((id) => String(id));

export interface ValidateCouponInput {
  code: string;
  userId: string;
  itemsSubtotalPaise: number;
  /** Per-restaurant item subtotals (MKT-8): a scoped coupon is computed on the eligible ones only. */
  restaurantSubtotals?: { restaurantId: string; subtotalPaise: number }[];
}

/**
 * `POST /internal/coupons/validate` → `{ code, discountPaise, description, restaurantIds, badgeLabel }`.
 * Scoped coupons (non-empty `restaurantIds`) need `restaurantSubtotals`: the discount and min-order use
 * the eligible restaurants' subtotal; none eligible (or no subtotals) → 422 COUPON_INVALID NOT_APPLICABLE.
 */
export async function validateCoupon(ctx: AppContext, input: ValidateCouponInput) {
  const code = normalizeCode(input.code);
  const c = await ctx.models.Coupon.findOne({ code }).lean<CouponLean>();
  assertCouponLive(c, ctx.now());
  const scope = scopeOf(c);
  let subtotal = input.itemsSubtotalPaise;
  const subtotals = input.restaurantSubtotals ?? [];
  const seen = new Set<string>();
  for (const g of subtotals) {
    const k = g.restaurantId.toLowerCase();
    if (seen.has(k)) {
      throw new DomainError('VALIDATION_FAILED', 'restaurantSubtotals lists a restaurant twice', 422, {
        issues: [{ path: 'body.restaurantSubtotals', message: `Duplicate restaurantId ${g.restaurantId}` }],
      });
    }
    seen.add(k);
  }
  if (scope.length) {
    const groups = subtotals.map((g) => ({ restaurantId: g.restaurantId, itemsSubtotalPaise: g.subtotalPaise }));
    const s = couponScope(groups, scope);
    if (!s.ok) throw couponNotApplicableError();
    // never exceed the checkout's own Σ itemsSubtotal (priceCheckout would otherwise throw downstream)
    subtotal = Math.min(s.eligibleSubtotalPaise, input.itemsSubtotalPaise);
  }
  if (subtotal < (c.minOrderPaise ?? 0)) {
    throw couponInvalid('MIN_ORDER', `Add items worth ₹${((c.minOrderPaise ?? 0) / 100).toFixed(2)} or more to use this coupon`, { minOrderPaise: c.minOrderPaise ?? 0 });
  }
  if (c.firstOrderOnly && (await firstOrderUsed(ctx, input.userId))) throw couponInvalid('FIRST_ORDER_ONLY', 'This coupon is valid on your first order only');
  if (totalExhausted(c)) throw couponLimit('TOTAL_LIMIT', 'This coupon has been fully used');
  if (c.perUserLimit != null && (await userRedemptionCount(ctx, c._id, input.userId)) >= c.perUserLimit) {
    throw couponLimit('PER_USER_LIMIT', 'You have already used this coupon');
  }
  const discountPaise = computeDiscount(c, subtotal);
  if (discountPaise <= 0) throw couponInvalid('NO_DISCOUNT', 'This coupon gives no discount on this order');
  return { code: c.code, discountPaise, description: c.description ?? '', restaurantIds: scope, badgeLabel: c.badgeLabel ?? null };
}

export type CouponEligibility = 'ELIGIBLE' | 'SIGN_IN_TO_CHECK';

export function couponPublicView(c: CouponLean, remainingUses: number | null, eligibility: CouponEligibility = 'ELIGIBLE') {
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
    offerHeadline: offerHeadline(c),
    eligibility,
    restaurantIds: scopeOf(c),
    badgeLabel: c.badgeLabel ?? null,
  };
}

const liveCoupons = async (ctx: AppContext) => {
  const now = ctx.now();
  const rows = await ctx.models.Coupon.find({ active: true, validFrom: { $lte: now }, validTo: { $gte: now } })
    .sort({ validTo: 1, _id: 1 })
    .limit(100)
    .lean<CouponLean[]>();
  return rows.filter((c) => !totalExhausted(c));
};

/** MKT-7 guests: every live coupon; per-user rules cannot be checked (`SIGN_IN_TO_CHECK`). */
export async function guestCoupons(ctx: AppContext) {
  return (await liveCoupons(ctx)).map((c) => couponPublicView(c, null, 'SIGN_IN_TO_CHECK'));
}

/** MKT-8: best live scoped offer per restaurant (by discount on a ₹500 basket), for discovery cards. */
export async function scopedOffers(ctx: AppContext): Promise<Map<string, { label: string; code: string }>> {
  const now = ctx.now();
  const rows = await ctx.models.Coupon.find({ active: true, validFrom: { $lte: now }, validTo: { $gte: now }, 'restaurantIds.0': { $exists: true } })
    .limit(500)
    .lean<CouponLean[]>();
  const best = new Map<string, { c: CouponLean; value: number }>();
  for (const c of rows) {
    if (totalExhausted(c)) continue;
    const value = computeDiscount(c, 50000);
    for (const rid of scopeOf(c)) {
      const cur = best.get(rid);
      if (!cur || value > cur.value || (value === cur.value && c.code < cur.c.code)) best.set(rid, { c, value });
    }
  }
  return new Map([...best].map(([rid, { c }]) => [rid, { label: badgeOf(c), code: c.code }]));
}

/** `GET /coupons/available` — coupons this user can apply right now (server-enforced eligibility). */
export async function availableCoupons(ctx: AppContext, userId: string) {
  const live = await liveCoupons(ctx);
  if (!live.length) return [];
  const [placed, used] = await Promise.all([
    firstOrderUsed(ctx, userId),
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
    .map((x) => couponPublicView(x.c, x.remaining, 'ELIGIBLE'));
}
