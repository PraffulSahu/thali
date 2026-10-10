import { describe, expect, it } from 'vitest';
import {
  lineTotal,
  priceCheckout,
  type LineInput,
  type PricingConfig,
  type RestaurantInput,
} from '../src/index.js';

const config: PricingConfig = { foodTaxBps: 500, feeTaxBps: 1800, platformFeePaise: 500 };

// Restaurant A: "item 25000 x2 + one addon 3000 on one unit" => two lines.
const lineA1: LineInput = {
  itemId: 'i1',
  name: 'Paneer Thali',
  unitPricePaise: 25000,
  addOns: [{ id: 'ao1', name: 'Extra Roti', pricePaise: 3000 }],
  quantity: 1,
};
const lineA2: LineInput = { itemId: 'i1', name: 'Paneer Thali', unitPricePaise: 25000, addOns: [], quantity: 1 };
const lineB1: LineInput = { itemId: 'i2', name: 'Dosa', unitPricePaise: 15000, addOns: [], quantity: 1 };

const A: RestaurantInput = { restaurantId: 'rA', lines: [lineA1, lineA2], packagingFeePaise: 2000, deliveryFeePaise: 3000 };
const B: RestaurantInput = { restaurantId: 'rB', lines: [lineB1], packagingFeePaise: 1000, deliveryFeePaise: 4000 };
const coupon = { couponCode: 'SAVE100', couponDiscountPaise: 10000 };

/*
 * HAND DERIVATION (LLD §6), no membership.
 *
 * Line totals: A1 = (25000+3000)*1 = 28000; A2 = 25000; B1 = 15000.
 * itemsSubtotal: A = 53000, B = 15000, Σ = 68000.
 *
 * Coupon D=10000, weights [53000, 15000], Σw = 68000:
 *   A: 10000*53000 = 530,000,000; /68000 = 7794.1 -> base 7794; 68000*7794 = 529,992,000; fraction = 8000
 *   B: 10000*15000 = 150,000,000; /68000 = 2205.9 -> base 2205; 68000*2205 = 149,940,000; fraction = 60000
 *   Σ base = 9999, R = 1 -> to the largest fraction (B: 60000 > A: 8000) => A=7794, B=2206.
 *   (Fractions sum to R*Σw = 68000, consistent.)
 *
 * A: foodTaxable = 53000 - 7794 + 2000 = 47206; foodTax = floor((47206*500 + 5000)/10000)
 *      = floor(23,608,000/10000) = 2360
 *    feeTaxable = 3000 + 500 = 3500; feeTax = floor((3500*1800 + 5000)/10000) = floor(6,305,000/10000) = 630
 *    total = 53000 - 7794 + 2000 + 3000 + 500 + 2360 + 630 = 53696
 * B: foodTaxable = 15000 - 2206 + 1000 = 13794; foodTax = floor((13794*500 + 5000)/10000)
 *      = floor(6,902,000/10000) = 690
 *    feeTaxable = 4000 + 500 = 4500; feeTax = floor((4500*1800 + 5000)/10000) = floor(8,105,000/10000) = 810
 *    total = 15000 - 2206 + 1000 + 4000 + 500 + 690 + 810 = 19794
 * Group: items 68000; coupon 10000; membership 0; packaging 3000; delivery 7000; deliveryDiscount 0;
 *        platform 1000; foodTax 2360+690 = 3050; feeTax 630+810 = 1440;
 *        total = 53696 + 19794 = 73490
 *        (check: 68000-10000+3000+7000+1000+3050+1440 = 73490)
 */
describe('priceCheckout worked example (no membership)', () => {
  const out = priceCheckout([A, B], coupon, null, config);

  it('computes line totals', () => {
    expect(lineTotal(lineA1)).toBe(28000);
    expect(lineTotal(lineA2)).toBe(25000);
    expect(lineTotal(lineB1)).toBe(15000);
  });

  it('prices restaurant A', () => {
    const a = out.children[0]!;
    expect(a.restaurantId).toBe('rA');
    expect(a.lines.map((l) => l.lineTotalPaise)).toEqual([28000, 25000]);
    expect(a.breakdown).toEqual({
      itemsSubtotalPaise: 53000,
      couponDiscountPaise: 7794,
      membershipDiscountPaise: 0,
      packagingFeePaise: 2000,
      deliveryFeePaise: 3000,
      deliveryDiscountPaise: 0,
      platformFeePaise: 500,
      foodTaxPaise: 2360,
      feeTaxPaise: 630,
      totalPaise: 53696,
    });
  });

  it('prices restaurant B (coupon remainder goes to larger fraction)', () => {
    const b = out.children[1]!;
    expect(b.restaurantId).toBe('rB');
    expect(b.lines.map((l) => l.lineTotalPaise)).toEqual([15000]);
    expect(b.breakdown).toEqual({
      itemsSubtotalPaise: 15000,
      couponDiscountPaise: 2206,
      membershipDiscountPaise: 0,
      packagingFeePaise: 1000,
      deliveryFeePaise: 4000,
      deliveryDiscountPaise: 0,
      platformFeePaise: 500,
      foodTaxPaise: 690,
      feeTaxPaise: 810,
      totalPaise: 19794,
    });
  });

  it('sums group totals', () => {
    expect(out.totals).toEqual({
      itemsSubtotalPaise: 68000,
      couponDiscountPaise: 10000,
      membershipDiscountPaise: 0,
      packagingFeePaise: 3000,
      deliveryFeePaise: 7000,
      deliveryDiscountPaise: 0,
      platformFeePaise: 1000,
      foodTaxPaise: 3050,
      feeTaxPaise: 1440,
      totalPaise: 73490,
    });
  });

  it('is deterministic and independent of input restaurant order', () => {
    expect(priceCheckout([B, A], coupon, null, config)).toEqual(out);
    expect(out.children.map((c) => c.restaurantId)).toEqual(['rA', 'rB']);
  });

  it('does not mutate its inputs', () => {
    const snapshot = JSON.stringify([A, B]);
    priceCheckout([A, B], coupon, null, config);
    expect(JSON.stringify([A, B])).toBe(snapshot);
  });
});

/*
 * HAND DERIVATION with membership { extraDiscountBps: 1000, extraDiscountCapPaise: 5000,
 * freeDeliveryRestaurantIds: ['rA'] }, same coupon (A 7794, B 2206).
 *
 * Net after coupon: A = 53000-7794 = 45206; B = 15000-2206 = 12794; Σ = 58000.
 * M = min(5000, floor(58000*1000/10000) = 5800) = 5000 (cap binds).
 * Allocate 5000 over weights [45206, 12794], Σw = 58000:
 *   A: 5000*45206 = 226,030,000 /58000 = 3897.07 -> 3897; 58000*3897 = 226,026,000; fraction 4000
 *   B: 5000*12794 =  63,970,000 /58000 = 1102.9  -> 1102; 58000*1102 =  63,916,000; fraction 54000
 *   Σ base = 4999, R=1 -> B (54000 > 4000) => A=3897, B=1103.
 * A: deliveryDiscount = 3000.
 *    foodTaxable = 53000-7794-3897+2000 = 43309; foodTax = floor((43309*500+5000)/10000)
 *      = floor(21,659,500/10000) = 2165
 *    feeTaxable = (3000-3000)+500 = 500; feeTax = floor((500*1800+5000)/10000) = floor(905,000/10000) = 90
 *    total = 53000-7794-3897+2000+3000-3000+500+2165+90 = 46064
 * B: foodTaxable = 15000-2206-1103+1000 = 12691; foodTax = floor((12691*500+5000)/10000)
 *      = floor(6,350,500/10000) = 635
 *    feeTaxable = 4500; feeTax = 810
 *    total = 15000-2206-1103+1000+4000+500+635+810 = 18636
 * Group: items 68000; coupon 10000; membership 5000; packaging 3000; delivery 7000; deliveryDiscount 3000;
 *        platform 1000; foodTax 2165+635 = 2800; feeTax 90+810 = 900; total 46064+18636 = 64700
 *        (check: 68000-10000-5000+3000+7000-3000+1000+2800+900 = 64700)
 */
describe('priceCheckout with membership', () => {
  const m = { extraDiscountBps: 1000, extraDiscountCapPaise: 5000, freeDeliveryRestaurantIds: ['rA'] };
  const out = priceCheckout([A, B], coupon, m, config);

  it('applies capped extra discount and free delivery for A only', () => {
    expect(out.children[0]!.breakdown).toEqual({
      itemsSubtotalPaise: 53000,
      couponDiscountPaise: 7794,
      membershipDiscountPaise: 3897,
      packagingFeePaise: 2000,
      deliveryFeePaise: 3000,
      deliveryDiscountPaise: 3000,
      platformFeePaise: 500,
      foodTaxPaise: 2165,
      feeTaxPaise: 90,
      totalPaise: 46064,
    });
    expect(out.children[1]!.breakdown).toEqual({
      itemsSubtotalPaise: 15000,
      couponDiscountPaise: 2206,
      membershipDiscountPaise: 1103,
      packagingFeePaise: 1000,
      deliveryFeePaise: 4000,
      deliveryDiscountPaise: 0,
      platformFeePaise: 500,
      foodTaxPaise: 635,
      feeTaxPaise: 810,
      totalPaise: 18636,
    });
    expect(out.totals).toEqual({
      itemsSubtotalPaise: 68000,
      couponDiscountPaise: 10000,
      membershipDiscountPaise: 5000,
      packagingFeePaise: 3000,
      deliveryFeePaise: 7000,
      deliveryDiscountPaise: 3000,
      platformFeePaise: 1000,
      foodTaxPaise: 2800,
      feeTaxPaise: 900,
      totalPaise: 64700,
    });
  });

  /*
   * Uncapped: M = min(100000, 5800) = 5800 over weights [45206, 12794], Σw = 58000:
   *   A: 5800*45206 = 262,194,800; /58000 = 4520.6 -> 4520; 58000*4520 = 262,160,000; fraction 34800
   *   B: 5800*12794 =  74,205,200; /58000 = 1279.4 -> 1279; 58000*1279 =  74,182,000; fraction 23200
   *   Σ base = 5799, R=1 -> A (34800 > 23200) => A=4521, B=1279.
   */
  it('gives the membership remainder to the larger fraction when uncapped', () => {
    const o = priceCheckout(
      [A, B],
      coupon,
      { extraDiscountBps: 1000, extraDiscountCapPaise: 100000, freeDeliveryRestaurantIds: [] },
      config,
    );
    expect(o.children[0]!.breakdown.membershipDiscountPaise).toBe(4521);
    expect(o.children[1]!.breakdown.membershipDiscountPaise).toBe(1279);
    expect(o.totals.membershipDiscountPaise).toBe(5800);
  });

  it('treats membership with zero bps and no free delivery like no membership', () => {
    const o = priceCheckout(
      [A, B],
      coupon,
      { extraDiscountBps: 0, extraDiscountCapPaise: 0, freeDeliveryRestaurantIds: [] },
      config,
    );
    expect(o).toEqual(priceCheckout([A, B], coupon, null, config));
  });
});

describe('priceCheckout edge cases and guards', () => {
  it('handles zero coupon and a single restaurant', () => {
    const o = priceCheckout([A], { couponDiscountPaise: 0 }, null, config);
    expect(o.children).toHaveLength(1);
    // 53000 + 2000 + 3000 + 500 + foodTax floor((55000*500+5000)/10000)=2750 + feeTax 630 = 61880
    expect(o.totals.totalPaise).toBe(61880);
  });

  it('returns zeroed totals for no restaurants', () => {
    const o = priceCheckout([], { couponDiscountPaise: 0 }, null, config);
    expect(o.children).toEqual([]);
    expect(o.totals.totalPaise).toBe(0);
  });

  it('allows a coupon equal to the whole subtotal', () => {
    const o = priceCheckout([A, B], { couponDiscountPaise: 68000 }, null, config);
    expect(o.children[0]!.breakdown.couponDiscountPaise).toBe(53000);
    expect(o.children[1]!.breakdown.couponDiscountPaise).toBe(15000);
  });

  it('rejects coupon greater than the subtotal', () => {
    expect(() => priceCheckout([A, B], { couponDiscountPaise: 68001 }, null, config)).toThrow(RangeError);
  });

  it('rejects negative / non-integer money and bad quantities', () => {
    const d = { couponDiscountPaise: 0 };
    expect(() => priceCheckout([A], { couponDiscountPaise: -1 }, null, config)).toThrow(RangeError);
    expect(() => priceCheckout([A], { couponDiscountPaise: 1.5 }, null, config)).toThrow(RangeError);
    expect(() => priceCheckout([{ ...A, packagingFeePaise: -1 }], d, null, config)).toThrow(RangeError);
    expect(() => priceCheckout([{ ...A, deliveryFeePaise: 10.5 }], d, null, config)).toThrow(RangeError);
    expect(() => priceCheckout([{ ...A, lines: [{ ...lineA1, unitPricePaise: -5 }] }], d, null, config)).toThrow(RangeError);
    expect(() =>
      priceCheckout([{ ...A, lines: [{ ...lineA1, addOns: [{ id: 'x', name: 'x', pricePaise: 0.5 }] }] }], d, null, config),
    ).toThrow(RangeError);
    expect(() => priceCheckout([{ ...A, lines: [{ ...lineA1, quantity: 0 }] }], d, null, config)).toThrow(RangeError);
    expect(() => priceCheckout([A], d, null, { ...config, platformFeePaise: -1 })).toThrow(RangeError);
    expect(() => priceCheckout([A], d, null, { ...config, foodTaxBps: 5.5 })).toThrow(RangeError);
    expect(() =>
      priceCheckout([A], d, { extraDiscountBps: -1, extraDiscountCapPaise: 0, freeDeliveryRestaurantIds: [] }, config),
    ).toThrow(RangeError);
    expect(() =>
      priceCheckout([A], d, { extraDiscountBps: 100, extraDiscountCapPaise: 1.5, freeDeliveryRestaurantIds: [] }, config),
    ).toThrow(RangeError);
  });

  it('rejects duplicate restaurant ids', () => {
    expect(() => priceCheckout([A, A], { couponDiscountPaise: 0 }, null, config)).toThrow(RangeError);
  });
});
