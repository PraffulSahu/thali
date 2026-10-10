import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@thali/contracts';
import { priceCheckout } from '@thali/pricing';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, idemKey, oid, outboxEvents, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('checkout');
});
afterAll(async () => {
  await h.cleanup();
});

const CODE_RE = /^TH-[0-9A-HJKMNP-TV-Z]{8}$/;
const pricingCfg = { foodTaxBps: 500, feeTaxBps: 1800, platformFeePaise: 500 };

function checkoutReq(u: Awaited<ReturnType<typeof asUser>>, body: object, key = idemKey()) {
  return request(h.app).post('/api/v1/checkouts').set('authorization', `Bearer ${u.token}`).set('Idempotency-Key', key).send(body);
}

describe('POST /checkouts — happy path', () => {
  it('two-restaurant cart → 201 with priced children, reservation and payment intent', async () => {
    const u = await asUser(h);
    h.identity.addUser(u.userId, { name: 'Asha Rao', phone: '+919876543210' });
    const s = await fillTwoRestaurantCart(h, u);
    const reserveBefore = h.marketplace.reserveCalls.length;

    const r = await checkoutReq(u, { address: DROP_ADDRESS, useMembership: false });
    expect(r.status).toBe(201);
    const { checkout, payment } = r.body;

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
      { couponDiscountPaise: 0 },
      null,
      pricingCfg,
    );
    expect(checkout.status).toBe('AWAITING_PAYMENT');
    expect(checkout.code).toMatch(CODE_RE);
    expect(checkout.pricing).toEqual(expected.totals);
    expect(checkout.children).toHaveLength(2);
    const codes = checkout.children.map((c: { code: string }) => c.code);
    expect(new Set([...codes, checkout.code]).size).toBe(3);
    for (const c of checkout.children) {
      expect(c.code).toMatch(CODE_RE);
      expect(c.status).toBe('AWAITING_PAYMENT');
      expect(c.delivery.note).toBe('Delivered separately by restaurant');
      expect(c.breakdown).toEqual(expected.children.find((e) => e.restaurantId === c.restaurantId)!.breakdown);
    }
    expect(new Date(checkout.expiresAt).getTime() - Date.now()).toBeGreaterThan(890_000);

    // payment intent for exactly the total
    expect(payment).toMatchObject({ provider: 'mock', amountPaise: expected.totals.totalPaise, currency: 'INR' });
    expect(payment.intentId).toBeTruthy();
    expect(payment.providerOrderId).toBeTruthy();
    const call = h.payments.createCalls.at(-1)!;
    expect(call).toEqual({ purpose: 'CHECKOUT', referenceId: checkout.id, userId: u.userId, amountPaise: expected.totals.totalPaise });
    expect(checkout.paymentIntentId).toBe(payment.intentId);

    // reservation keyed by the checkout id
    expect(h.marketplace.reserveCalls.length).toBe(reserveBefore + 1);
    const res = h.marketplace.reserveCalls.at(-1)!;
    expect(res.checkoutId).toBe(checkout.id);
    expect(res.userId).toBe(u.userId);
    expect(res.ttlSec).toBe(900);
    expect(res.lines).toEqual(
      expect.arrayContaining([
        { restaurantId: s.a.id, itemId: s.paneer.id, qty: 1 },
        { restaurantId: s.b.id, itemId: s.dosa.id, qty: 2 },
      ]),
    );

    // persisted child orders carry what Task 12 / delivery need
    const children = await h.db.conn.collection('child_orders').find({ checkoutGroupId: { $exists: true } }).toArray();
    const mine = children.filter((c) => c.userId === u.userId);
    expect(mine).toHaveLength(2);
    const childA = mine.find((c) => c.restaurantId === s.a.id)!;
    expect(childA.restaurantOwnerId).toBe(s.a.ownerUserId);
    expect(childA.restaurantName).toBe('Spice Route');
    expect(childA.restaurantLocation).toEqual({ type: 'Point', coordinates: [77.59, 12.97] });
    expect(childA.restaurantAddress).toMatchObject({ line1: '1 MG Road', city: 'Bengaluru', pincode: '560001' });
    expect(childA.commissionBps).toBe(1800);
    expect(childA.dropAddress).toMatchObject({ line1: DROP_ADDRESS.line1, location: { type: 'Point', coordinates: [77.5946, 12.9716] } });
    expect(childA.customerContact).toEqual({ name: 'Asha Rao', phoneMasked: '+91******3210' });
    expect(childA.pickupCode).toMatch(/^\d{4}$/);
    expect(childA.deliveryCode).toMatch(/^\d{4}$/);
    expect(childA.lines[0].selections).toHaveLength(2);
    expect(childA.refundStatus).toBe('NONE');

    // outbox checkout.created; cart is NOT cleared yet
    const created = (await outboxEvents(h, 'checkout.created')).filter((e) => e.payload.checkoutId === checkout.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({ userId: u.userId, totalPaise: expected.totals.totalPaise });
    expect(created[0]!.payload.childOrderIds).toHaveLength(2);
    expect((await u.get('/api/v1/cart')).body.itemCount).toBe(3);

    // owner can read it; others get 404; internal status endpoint
    const mineView = await u.get(`/api/v1/checkouts/${checkout.id}`);
    expect(mineView.status).toBe(200);
    expect(mineView.body.checkout.id).toBe(checkout.id);
    const other = await asUser(h);
    expect((await other.get(`/api/v1/checkouts/${checkout.id}`)).status).toBe(404);
    const st = await request(h.app)
      .get(`/internal/checkouts/${checkout.id}/status`)
      .set('authorization', `Bearer ${await h.internalToken('marketplace')}`);
    expect(st.status).toBe(200);
    expect(st.body).toEqual({ id: checkout.id, status: 'AWAITING_PAYMENT', paymentIntentId: payment.intentId });
    const missing = await request(h.app)
      .get(`/internal/checkouts/${oid()}/status`)
      .set('authorization', `Bearer ${await h.internalToken('marketplace')}`);
    expect(missing.status).toBe(404);
  });

  it('addressId resolves to the cart address snapshot; coupon is validated and reserved', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    await u.put('/api/v1/cart/address', { addressId: 'home-1', address: DROP_ADDRESS });
    h.marketplace.coupons.set('SAVE100', { discountPaise: 10000 });
    const r = await checkoutReq(u, { addressId: 'home-1', couponCode: 'save100' });
    expect(r.status).toBe(201);
    expect(r.body.checkout.pricing.couponDiscountPaise).toBe(10000);
    expect(r.body.checkout.couponCode).toBe('SAVE100');
    expect(h.marketplace.reserveCalls.at(-1)).toMatchObject({ couponCode: 'SAVE100', couponDiscountPaise: 10000 });
    const bad = await checkoutReq(u, { addressId: 'other-address' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /checkouts — failure branches', () => {
  it('restaurant closed in quote → 422 RESTAURANT_CLOSED with problems, nothing reserved', async () => {
    const u = await asUser(h);
    const s = await fillTwoRestaurantCart(h, u);
    s.a.open = false;
    const before = h.marketplace.reserveCalls.length;
    const r = await checkoutReq(u, { address: DROP_ADDRESS });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('RESTAURANT_CLOSED');
    expect(r.body.error.details.problems).toEqual([expect.objectContaining({ code: 'RESTAURANT_CLOSED', restaurantId: s.a.id })]);
    expect(h.marketplace.reserveCalls.length).toBe(before);
    expect(await h.db.conn.collection('checkout_groups').countDocuments({ userId: u.userId })).toBe(0);
  });

  it('expectedTotalPaise mismatch → 422 PRICE_CHANGED with the new breakdown; cart snapshot refreshed', async () => {
    const u = await asUser(h);
    const s = await fillTwoRestaurantCart(h, u);
    s.dosa.pricePaise = 16000; // price rose after the item was added
    const r = await checkoutReq(u, { address: DROP_ADDRESS, expectedTotalPaise: 12345 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PRICE_CHANGED');
    expect(r.body.error.details.pricing.totalPaise).toBeGreaterThan(0);
    expect(r.body.error.details.pricing.totalPaise).not.toBe(12345);
    expect(r.body.error.details.children).toHaveLength(2);
    expect(h.marketplace.reserveCalls.filter((c) => c.userId === u.userId)).toHaveLength(0);
    const cart = await u.get('/api/v1/cart');
    const dosa = cart.body.groups.find((g: { restaurantId: string }) => g.restaurantId === s.b.id).lines[0];
    expect(dosa.unitPricePaise).toBe(16000);

    // confirming the new total succeeds
    const ok = await checkoutReq(u, { address: DROP_ADDRESS, expectedTotalPaise: r.body.error.details.pricing.totalPaise });
    expect(ok.status).toBe(201);
  });

  it('reserve OUT_OF_STOCK → 409 and no checkout persisted', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    h.marketplace.failReserveWith = new DomainError('OUT_OF_STOCK', 'Paneer Tikka just sold out', 409);
    try {
      const r = await checkoutReq(u, { address: DROP_ADDRESS });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('OUT_OF_STOCK');
    } finally {
      h.marketplace.failReserveWith = null;
    }
    expect(await h.db.conn.collection('checkout_groups').countDocuments({ userId: u.userId })).toBe(0);
    expect(await h.db.conn.collection('child_orders').countDocuments({ userId: u.userId })).toBe(0);
  });

  it('invalid coupon → 422 COUPON_INVALID, nothing reserved', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    const r = await checkoutReq(u, { address: DROP_ADDRESS, couponCode: 'BOGUS' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('COUPON_INVALID');
    expect(h.marketplace.reserveCalls.filter((c) => c.userId === u.userId)).toHaveLength(0);
  });

  it('payments down → checkout PAYMENT_FAILED + checkout.released + 502', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    h.payments.down = true;
    let r;
    try {
      r = await checkoutReq(u, { address: DROP_ADDRESS });
    } finally {
      h.payments.down = false;
    }
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    const group = await h.db.conn.collection('checkout_groups').findOne({ userId: u.userId });
    expect(group!.status).toBe('PAYMENT_FAILED');
    const children = await h.db.conn.collection('child_orders').find({ checkoutGroupId: group!._id }).toArray();
    expect(children.map((c) => c.status)).toEqual(['PAYMENT_FAILED', 'PAYMENT_FAILED']);
    const released = (await outboxEvents(h, 'checkout.released')).filter((e) => e.payload.checkoutId === String(group!._id));
    expect(released).toHaveLength(1);
    expect(released[0]!.payload.reason).toBe('PAYMENT_FAILED');

    // a retry (new key) creates a fresh checkout because the failed one no longer blocks the cart version
    const retry = await checkoutReq(u, { address: DROP_ADDRESS });
    expect(retry.status).toBe(201);
  });

  it('empty cart → 422 CART_EMPTY; missing Idempotency-Key → 400; invalid body → 400', async () => {
    const u = await asUser(h);
    expect((await checkoutReq(u, { address: DROP_ADDRESS })).body.error.code).toBe('CART_EMPTY');
    const noKey = await request(h.app).post('/api/v1/checkouts').set('authorization', `Bearer ${u.token}`).send({ address: DROP_ADDRESS });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const both = await checkoutReq(u, { address: DROP_ADDRESS, addressId: 'x' });
    expect(both.status).toBe(400);
    const anon = await request(h.app).post('/api/v1/checkouts').set('Idempotency-Key', idemKey()).send({ address: DROP_ADDRESS });
    expect(anon.status).toBe(401);
  });

  it('checkout create is rate limited to 10/min per user', async () => {
    const u = await asUser(h);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await checkoutReq(u, { address: DROP_ADDRESS })).status);
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
