import { DomainError } from '@thali/contracts';
import type { CouponScopeGroup, CouponScopeResult } from './types.js';

/** `details.reason` when a restaurant-scoped coupon matches no restaurant in the cart (MKT-8). */
export const COUPON_NOT_APPLICABLE = 'NOT_APPLICABLE' as const;

/** 422 `COUPON_INVALID { reason: 'NOT_APPLICABLE' }` (same envelope as marketplace's other coupon reasons). */
export function couponNotApplicableError(): DomainError {
  return new DomainError('COUPON_INVALID', 'This coupon is not valid for the restaurants in your cart', undefined, {
    reason: COUPON_NOT_APPLICABLE,
  });
}

/**
 * Which cart groups a coupon applies to (MKT-8). `couponRestaurantIds` absent/empty = all groups.
 * Marketplace computes the discount against `eligibleSubtotalPaise`, then passes the same ids to
 * `priceCheckout` as `couponRestaurantIds`. Result order follows the input order.
 */
export function couponScope(groups: readonly CouponScopeGroup[], couponRestaurantIds?: readonly string[] | null): CouponScopeResult {
  const scope = couponRestaurantIds && couponRestaurantIds.length > 0 ? new Set(couponRestaurantIds) : null;
  const eligible = scope ? groups.filter((g) => scope.has(g.restaurantId)) : [...groups];
  if (scope && eligible.length === 0) return { ok: false, reason: COUPON_NOT_APPLICABLE };
  return {
    ok: true,
    eligibleRestaurantIds: eligible.map((g) => g.restaurantId),
    eligibleSubtotalPaise: eligible.reduce((acc, g) => acc + g.itemsSubtotalPaise, 0),
  };
}
