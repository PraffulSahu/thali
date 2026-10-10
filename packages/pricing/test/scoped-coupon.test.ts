import { DomainError } from '@thali/contracts';
import { describe, expect, it } from 'vitest';
import {
  COUPON_NOT_APPLICABLE,
  couponScope,
  priceCheckout,
  type LineInput,
  type PricingConfig,
  type RestaurantInput,
} from '../src/index.js';

const config: PricingConfig = { foodTaxBps: 500, feeTaxBps: 1800, platformFeePaise: 500 };
const line = (itemId: string, unitPricePaise: number): LineInput => ({ itemId, name: itemId, unitPricePaise, addOns: [], quantity: 1 });
const A: RestaurantInput = { restaurantId: 'rA', lines: [line('a', 53000)], packagingFeePaise: 2000, deliveryFeePaise: 3000 };
const B: RestaurantInput = { restaurantId: 'rB', lines: [line('b', 15000)], packagingFeePaise: 1000, deliveryFeePaise: 4000 };
const C: RestaurantInput = { restaurantId: 'rC', lines: [line('c', 7000)], packagingFeePaise: 0, deliveryFeePaise: 2000 };

describe('scoped coupons (MKT-8)', () => {
  it('absent or empty scope keeps the platform-wide pro-rata allocation', () => {
    const base = priceCheckout([A, B], { couponDiscountPaise: 10000 }, null, config);
    expect(priceCheckout([A, B], { couponDiscountPaise: 10000, couponRestaurantIds: [] }, null, config)).toEqual(base);
    expect(base.children.map((c) => c.breakdown.couponDiscountPaise)).toEqual([7794, 2206]);
  });

  it('allocates only across eligible children; ineligible children get 0', () => {
    const o = priceCheckout([A, B, C], { couponDiscountPaise: 1100, couponRestaurantIds: ['rB', 'rC', 'rZ'] }, null, config);
    const share = Object.fromEntries(o.children.map((c) => [c.restaurantId, c.breakdown.couponDiscountPaise]));
    // eligible weights B 15000, C 7000 (Σ 22000): B = 1100*15000/22000 = 750, C = 350
    expect(share).toEqual({ rA: 0, rB: 750, rC: 350 });
    expect(o.totals.couponDiscountPaise).toBe(1100);
    // A is priced exactly as if no coupon touched it
    const plainA = priceCheckout([A], { couponDiscountPaise: 0 }, null, config).children[0]!.breakdown;
    expect(o.children[0]!.breakdown).toEqual(plainA);
  });

  it('membership extra discount is computed after the scoped coupon', () => {
    const m = { freeDeliveryRestaurantIds: [], extraDiscountBps: 1000, extraDiscountCapPaise: 1_000_000 };
    const o = priceCheckout([A, B], { couponDiscountPaise: 5000, couponRestaurantIds: ['rB'] }, m, config);
    expect(o.children.map((c) => c.breakdown.couponDiscountPaise)).toEqual([0, 5000]);
    // net A 53000, B 10000, Σ 63000 → 10% = 6300 → A 5300, B 1000
    expect(o.children.map((c) => c.breakdown.membershipDiscountPaise)).toEqual([5300, 1000]);
  });

  it('a scoped coupon may not exceed the eligible subtotal', () => {
    expect(() => priceCheckout([A, B], { couponDiscountPaise: 15001, couponRestaurantIds: ['rB'] }, null, config)).toThrow(RangeError);
    expect(() => priceCheckout([A, B], { couponDiscountPaise: 15000, couponRestaurantIds: ['rB'] }, null, config)).not.toThrow();
  });

  it('no eligible child → COUPON_INVALID {reason: NOT_APPLICABLE}', () => {
    let err: unknown;
    try {
      priceCheckout([A, B], { couponCode: 'SPICE20', couponDiscountPaise: 0, couponRestaurantIds: ['rZ'] }, null, config);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('COUPON_INVALID');
    expect((err as DomainError).details).toEqual({ reason: 'NOT_APPLICABLE' });
    expect(COUPON_NOT_APPLICABLE).toBe('NOT_APPLICABLE');
  });

  it('couponScope reports the eligible ids + subtotal, or NOT_APPLICABLE', () => {
    const groups = [
      { restaurantId: 'rA', itemsSubtotalPaise: 53000 },
      { restaurantId: 'rB', itemsSubtotalPaise: 15000 },
    ];
    expect(couponScope(groups, undefined)).toEqual({ ok: true, eligibleRestaurantIds: ['rA', 'rB'], eligibleSubtotalPaise: 68000 });
    expect(couponScope(groups, [])).toEqual({ ok: true, eligibleRestaurantIds: ['rA', 'rB'], eligibleSubtotalPaise: 68000 });
    expect(couponScope(groups, ['rB', 'rX'])).toEqual({ ok: true, eligibleRestaurantIds: ['rB'], eligibleSubtotalPaise: 15000 });
    expect(couponScope(groups, ['rX'])).toEqual({ ok: false, reason: 'NOT_APPLICABLE' });
    expect(couponScope([], ['rX'])).toEqual({ ok: false, reason: 'NOT_APPLICABLE' });
  });
});
