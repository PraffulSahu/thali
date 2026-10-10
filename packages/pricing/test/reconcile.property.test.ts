import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  priceCheckout,
  type Breakdown,
  type LineInput,
  type MembershipBenefitInput,
  type RestaurantInput,
} from '../src/index.js';

const KEYS: (keyof Breakdown)[] = [
  'itemsSubtotalPaise',
  'couponDiscountPaise',
  'membershipDiscountPaise',
  'packagingFeePaise',
  'deliveryFeePaise',
  'deliveryDiscountPaise',
  'platformFeePaise',
  'foodTaxPaise',
  'feeTaxPaise',
  'totalPaise',
];

const lineArb: fc.Arbitrary<LineInput> = fc.record({
  itemId: fc.string({ minLength: 1, maxLength: 6 }),
  name: fc.string({ maxLength: 8 }),
  unitPricePaise: fc.integer({ min: 0, max: 200_000 }),
  addOns: fc.array(
    fc.record({ id: fc.string({ minLength: 1, maxLength: 4 }), name: fc.string({ maxLength: 6 }), pricePaise: fc.integer({ min: 0, max: 20_000 }) }),
    { maxLength: 3 },
  ),
  quantity: fc.integer({ min: 1, max: 10 }),
});

const scenarioArb = fc
  .record({
    n: fc.integer({ min: 1, max: 5 }),
    restaurants: fc.array(
      fc.record({
        lines: fc.array(lineArb, { minLength: 1, maxLength: 6 }),
        packagingFeePaise: fc.integer({ min: 0, max: 10_000 }),
        deliveryFeePaise: fc.integer({ min: 0, max: 20_000 }),
        free: fc.boolean(),
      }),
      { minLength: 5, maxLength: 5 },
    ),
    couponFrac: fc.integer({ min: 0, max: 10_000 }),
    couponFull: fc.boolean(),
    membership: fc.option(
      fc.record({ extraDiscountBps: fc.integer({ min: 0, max: 3000 }), extraDiscountCapPaise: fc.integer({ min: 0, max: 100_000 }) }),
      { nil: null },
    ),
    foodTaxBps: fc.integer({ min: 0, max: 2800 }),
    feeTaxBps: fc.integer({ min: 0, max: 2800 }),
    platformFeePaise: fc.integer({ min: 0, max: 2000 }),
  })
  .map((s) => {
    const rs: RestaurantInput[] = s.restaurants.slice(0, s.n).map((r, i) => ({
      restaurantId: `r${i}`,
      lines: r.lines,
      packagingFeePaise: r.packagingFeePaise,
      deliveryFeePaise: r.deliveryFeePaise,
    }));
    const sum = rs.reduce(
      (acc, r) => acc + r.lines.reduce((a, l) => a + (l.unitPricePaise + l.addOns.reduce((x, y) => x + y.pricePaise, 0)) * l.quantity, 0),
      0,
    );
    const coupon = s.couponFull ? sum : Math.floor((sum * s.couponFrac) / 10_000);
    const m: MembershipBenefitInput | null = s.membership
      ? {
          ...s.membership,
          freeDeliveryRestaurantIds: s.restaurants.slice(0, s.n).flatMap((r, i) => (r.free ? [`r${i}`] : [])),
        }
      : null;
    return {
      rs,
      coupon,
      m,
      config: { foodTaxBps: s.foodTaxBps, feeTaxBps: s.feeTaxBps, platformFeePaise: s.platformFeePaise },
    };
  });

describe('priceCheckout reconciliation (property)', () => {
  it('holds all invariants', () => {
    fc.assert(
      fc.property(scenarioArb, ({ rs, coupon, m, config }) => {
        const out = priceCheckout(rs, { couponDiscountPaise: coupon }, m, config);
        expect(out.children).toHaveLength(rs.length);

        for (const k of KEYS) {
          const sum = out.children.reduce((a, c) => a + c.breakdown[k], 0);
          expect(out.totals[k]).toBe(sum);
        }
        for (const c of out.children) {
          for (const k of KEYS) {
            expect(Number.isInteger(c.breakdown[k])).toBe(true);
            expect(c.breakdown[k]).toBeGreaterThanOrEqual(0);
          }
          const b = c.breakdown;
          expect(b.totalPaise).toBe(
            b.itemsSubtotalPaise - b.couponDiscountPaise - b.membershipDiscountPaise + b.packagingFeePaise +
              b.deliveryFeePaise - b.deliveryDiscountPaise + b.platformFeePaise + b.foodTaxPaise + b.feeTaxPaise,
          );
          expect(b.deliveryDiscountPaise === 0 || b.deliveryDiscountPaise === b.deliveryFeePaise).toBe(true);
          expect(c.lines.reduce((a, l) => a + l.lineTotalPaise, 0)).toBe(b.itemsSubtotalPaise);
        }
        expect(out.totals.couponDiscountPaise).toBe(coupon);
        expect(out.totals.membershipDiscountPaise).toBeLessThanOrEqual(m?.extraDiscountCapPaise ?? 0);
        expect(out.totals.totalPaise).toBe(out.children.reduce((a, c) => a + c.breakdown.totalPaise, 0));
        // determinism
        expect(priceCheckout([...rs].reverse(), { couponDiscountPaise: coupon }, m, config)).toEqual(out);
      }),
      { numRuns: 500 },
    );
  });
});
