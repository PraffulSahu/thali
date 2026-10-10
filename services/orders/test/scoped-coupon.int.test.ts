/**
 * Contract 1 (MKT-8 ↔ orders quote): orders sends per-restaurant subtotals to
 * `/internal/coupons/validate` and prices a restaurant-scoped coupon only on the eligible children.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, idemKey, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('scoped_coupon');
});
afterAll(async () => {
  await h.cleanup();
});

type Child = { restaurantId: string; breakdown: { couponDiscountPaise: number } };

describe('restaurant-scoped coupons', () => {
  it('sends restaurantSubtotals and allocates the discount only to the eligible restaurant', async () => {
    const u = await asUser(h);
    const s = await fillTwoRestaurantCart(h, u);
    h.marketplace.coupons.set('DOSA50', { discountPaise: 5000, restaurantIds: [s.b.id] });
    const r = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, couponCode: 'DOSA50' });
    expect(r.status).toBe(200);
    expect(h.marketplace.couponCalls.at(-1)!.restaurantSubtotals).toEqual(
      expect.arrayContaining([
        { restaurantId: s.a.id, subtotalPaise: 30000 },
        { restaurantId: s.b.id, subtotalPaise: 30000 },
      ]),
    );
    expect(r.body.coupon).toMatchObject({ code: 'DOSA50', valid: true, discountPaise: 5000, restaurantIds: [s.b.id] });
    const a = r.body.children.find((c: Child) => c.restaurantId === s.a.id);
    const b = r.body.children.find((c: Child) => c.restaurantId === s.b.id);
    expect(a.breakdown.couponDiscountPaise).toBe(0);
    expect(b.breakdown.couponDiscountPaise).toBe(5000);
  });

  it('an unscoped coupon still splits pro-rata across all restaurants', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    h.marketplace.coupons.set('ALL60', { discountPaise: 6000 });
    const r = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, couponCode: 'ALL60' });
    expect(r.body.coupon).toMatchObject({ valid: true, discountPaise: 6000, restaurantIds: [] });
    expect(r.body.children.map((c: Child) => c.breakdown.couponDiscountPaise)).toEqual([3000, 3000]);
  });

  it('subset preview without the coupon restaurant → coupon reported invalid (NOT_APPLICABLE); checkout → 422 COUPON_INVALID', async () => {
    const u = await asUser(h);
    h.identity.addUser(u.userId);
    const s = await fillTwoRestaurantCart(h, u);
    h.marketplace.coupons.set('DOSAONLY', { discountPaise: 5000, restaurantIds: [s.b.id] });
    const p = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, couponCode: 'DOSAONLY', restaurantIds: [s.a.id] });
    expect(p.status).toBe(200);
    expect(p.body.coupon).toMatchObject({ code: 'DOSAONLY', valid: false, discountPaise: 0 });
    expect(p.body.pricing.couponDiscountPaise).toBe(0);

    const c = await request(h.app)
      .post('/api/v1/checkouts')
      .set('authorization', `Bearer ${u.token}`)
      .set('Idempotency-Key', idemKey())
      .send({ address: DROP_ADDRESS, couponCode: 'DOSAONLY', restaurantIds: [s.a.id] });
    expect(c.status).toBe(422);
    expect(c.body.error.code).toBe('COUPON_INVALID');
    expect(c.body.error.details).toMatchObject({ reason: 'NOT_APPLICABLE' });
  });

  it('a marketplace that ignores the scope but reports it is re-checked locally (discount capped to the eligible subtotal)', async () => {
    const u = await asUser(h);
    const s = await fillTwoRestaurantCart(h, u);
    // scope says B only, but the fake is asked without subtotals → returns the full discount; orders caps it to B's 30000
    h.marketplace.coupons.set('BIG', { discountPaise: 50000, restaurantIds: [s.b.id] });
    const orig = h.marketplace.validateCoupon.bind(h.marketplace);
    h.marketplace.validateCoupon = (req) => orig({ ...req, restaurantSubtotals: undefined });
    try {
      const r = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, couponCode: 'BIG' });
      expect(r.status).toBe(200);
      expect(r.body.coupon).toMatchObject({ valid: true, discountPaise: 30000 });
      expect(r.body.children.find((c: Child) => c.restaurantId === s.a.id).breakdown.couponDiscountPaise).toBe(0);
    } finally {
      h.marketplace.validateCoupon = orig;
    }
  });
});
