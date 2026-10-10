import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { priceCheckout } from '@thali/pricing';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('preview');
});
afterAll(async () => {
  await h.cleanup();
});

const pricingCfg = { foodTaxBps: 500, feeTaxBps: 1800, platformFeePaise: 500 };

describe('POST /cart/preview (server quote + pricing, no reservation)', () => {
  it('returns pricing identical to priceCheckout with per-restaurant breakdowns', async () => {
    const u = await asUser(h);
    const s = await fillTwoRestaurantCart(h, u);
    h.marketplace.coupons.set('SAVE100', { discountPaise: 10000 });

    const r = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, couponCode: 'save100' });
    expect(r.status).toBe(200);
    const expected = priceCheckout(
      [
        {
          restaurantId: s.a.id,
          packagingFeePaise: 2000,
          deliveryFeePaise: 3000,
          lines: [
            {
              itemId: s.paneer.id,
              name: 'Paneer Tikka',
              unitPricePaise: 25000,
              quantity: 1,
              addOns: [
                { id: s.size.options[1]!.id, name: 'Large', pricePaise: 3000 },
                { id: s.extras.options[0]!.id, name: 'Cheese', pricePaise: 2000 },
              ],
            },
          ],
        },
        {
          restaurantId: s.b.id,
          packagingFeePaise: 1000,
          deliveryFeePaise: 4000,
          lines: [{ itemId: s.dosa.id, name: 'Masala Dosa', unitPricePaise: 15000, quantity: 2, addOns: [] }],
        },
      ],
      { couponCode: 'SAVE100', couponDiscountPaise: 10000 },
      null,
      pricingCfg,
    );
    expect(r.body.pricing).toEqual(expected.totals);
    expect(r.body.children).toHaveLength(2);
    for (const c of expected.children) {
      const got = r.body.children.find((x: { restaurantId: string }) => x.restaurantId === c.restaurantId);
      expect(got.breakdown).toEqual(c.breakdown);
      expect(got.delivery.note).toBe('Delivered separately by restaurant');
    }
    expect(r.body.coupon).toMatchObject({ code: 'SAVE100', valid: true, discountPaise: 10000 });
    expect(r.body.problems).toEqual([]);
    expect(r.body.canCheckout).toBe(true);
    // quote was asked with the drop point; nothing reserved, nothing persisted
    expect(h.marketplace.quoteCalls.at(-1)!.drop).toEqual(DROP_ADDRESS.location);
    expect(h.marketplace.reserveCalls).toHaveLength(0);
    expect(await h.db.conn.collection('checkout_groups').countDocuments()).toBe(0);
  });

  it('applies membership benefits when useMembership', async () => {
    const u = await asUser(h);
    const s = await fillTwoRestaurantCart(h, u);
    h.marketplace.membership = {
      membershipId: 'm1',
      freeDeliveryRestaurantIds: [s.b.id],
      extraDiscountBps: 1000,
      extraDiscountCapPaise: 5000,
    };
    const r = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, useMembership: true });
    h.marketplace.membership = null;
    expect(r.status).toBe(200);
    expect(r.body.pricing.deliveryDiscountPaise).toBe(4000);
    expect(r.body.pricing.membershipDiscountPaise).toBe(5000);
    expect(h.marketplace.membershipCalls.at(-1)).toMatchObject({ userId: u.userId });
  });

  it('reports problems (closed restaurant) and invalid coupons without failing', async () => {
    const u = await asUser(h);
    const s = await fillTwoRestaurantCart(h, u);
    s.b.open = false;
    const r = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, couponCode: 'NOPE' });
    expect(r.status).toBe(200);
    expect(r.body.canCheckout).toBe(false);
    expect(r.body.problems).toEqual([expect.objectContaining({ code: 'RESTAURANT_CLOSED', restaurantId: s.b.id })]);
    expect(r.body.coupon).toMatchObject({ code: 'NOPE', valid: false });
    expect(r.body.pricing.couponDiscountPaise).toBe(0);
  });

  it('uses the cart address when none is given; empty cart → 422 CART_EMPTY; no address → 400', async () => {
    const u = await asUser(h);
    expect((await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS })).body.error.code).toBe('CART_EMPTY');
    await fillTwoRestaurantCart(h, u);
    expect((await u.post('/api/v1/cart/preview', {})).status).toBe(400);
    await u.put('/api/v1/cart/address', { address: DROP_ADDRESS });
    const r = await u.post('/api/v1/cart/preview', {});
    expect(r.status).toBe(200);
    expect(r.body.deliveryAddress.line1).toBe(DROP_ADDRESS.line1);
  });
});
