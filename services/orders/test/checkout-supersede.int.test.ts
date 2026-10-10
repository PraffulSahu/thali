/**
 * ORD-3 fix round 1 (payment safety): a customer never holds two payable checkouts for the same
 * restaurant. Overlapping AWAITING_PAYMENT checkouts (any cart version) are superseded (EXPIRED +
 * checkout.released) when a new one is created; a late capture on them is refunded; if one got paid
 * meanwhile the new checkout is refused with 409 CONFLICT CHECKOUT_ALREADY_PAID.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thali/service-kit';
import { applyCapturedPayment } from '../src/domain/place.js';
import { supersedeCheckout } from '../src/domain/checkout.js';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, idemKey, outboxEvents, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('checkout_supersede');
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

type U = Awaited<ReturnType<typeof asUser>>;
const checkout = (u: U, body: object) =>
  request(h.app).post('/api/v1/checkouts').set('authorization', `Bearer ${u.token}`).set('Idempotency-Key', idemKey()).send({ address: DROP_ADDRESS, ...body });
const capture = (c: { body: { checkout: { id: string; pricing: { totalPaise: number } }; payment: { intentId: string } } }) =>
  withTransaction(h.ctx.conn, (session) =>
    applyCapturedPayment(h.ctx, session, {
      checkoutId: c.body.checkout.id,
      paymentIntentId: c.body.payment.intentId,
      amountPaise: c.body.checkout.pricing.totalPaise,
      source: 'payment.captured',
    }),
  );
const groupOf = (id: string) => h.ctx.models.CheckoutGroup.findById(id).lean();
const released = async () => (await outboxEvents(h, 'checkout.released')).map((e) => e.payload.checkoutId);

async function newUser() {
  const u = await asUser(h);
  h.identity.addUser(u.userId);
  const s = await fillTwoRestaurantCart(h, u);
  return { u, s };
}

describe('superseding overlapping checkouts', () => {
  it('{A} then the whole cart: {A} is released (EXPIRED); a late capture on it is refunded, never placed', async () => {
    const { u, s } = await newUser();
    const a = await checkout(u, { restaurantIds: [s.a.id] });
    expect(a.status).toBe(201);
    const all = await checkout(u, {});
    expect(all.status).toBe(201);
    expect(all.body.checkout.id).not.toBe(a.body.checkout.id);

    const old = await groupOf(a.body.checkout.id);
    expect(old!.status).toBe('EXPIRED');
    expect(old!.statusHistory.at(-1)!.reason).toBe(`superseded by ${all.body.checkout.id}`);
    expect(await released()).toContain(a.body.checkout.id);
    const oldKids = await h.ctx.models.ChildOrder.find({ checkoutGroupId: a.body.checkout.id }).lean();
    expect(oldKids.map((k) => k.status)).toEqual(['EXPIRED']);
    expect(await h.ctx.models.CheckoutGroup.countDocuments({ userId: u.userId, status: 'AWAITING_PAYMENT' })).toBe(1);

    // the customer still approves the old UPI request → late payment → refund, nothing placed
    expect(await capture(a)).toBe('LATE_PAYMENT');
    const late = (await outboxEvents(h, 'checkout.late_payment')).filter((e) => e.payload.checkoutId === a.body.checkout.id);
    expect(late).toHaveLength(1);
    expect(late[0]!.payload.amountPaise).toBe(a.body.checkout.pricing.totalPaise);
    expect((await groupOf(a.body.checkout.id))!.status).toBe('EXPIRED');
    expect(await capture(all)).toBe('PLACED');
  });

  it('{A}@v and {B}@v, {A} paid (cart → v+1), retry B: the stale {B}@v is superseded', async () => {
    const { u, s } = await newUser();
    const a = await checkout(u, { restaurantIds: [s.a.id] });
    const b = await checkout(u, { restaurantIds: [s.b.id] });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await capture(a)).toBe('PLACED');
    const b2 = await checkout(u, { restaurantIds: [s.b.id] });
    expect(b2.status).toBe(201);
    expect(b2.body.checkout.cartVersion).toBe(b.body.checkout.cartVersion + 1);
    expect((await groupOf(b.body.checkout.id))!.status).toBe('EXPIRED');
    expect((await groupOf(a.body.checkout.id))!.status).toBe('PAID_PLACED'); // a paid checkout is never touched
    expect(await released()).toContain(b.body.checkout.id);
  });

  it('the old checkout is already released before the new reservation; a capture during it is refunded, the new one proceeds', async () => {
    const { u, s } = await newUser();
    const a = await checkout(u, { restaurantIds: [s.a.id] });
    expect(a.status).toBe(201);
    let atReserve: string | undefined;
    h.marketplace.beforeReserve = async () => {
      atReserve = (await groupOf(a.body.checkout.id))!.status;
      expect(await capture(a)).toBe('LATE_PAYMENT');
    };
    let r;
    try {
      r = await checkout(u, {});
    } finally {
      h.marketplace.beforeReserve = null;
    }
    expect(atReserve).toBe('EXPIRED');
    expect(r.status).toBe(201);
    expect((await outboxEvents(h, 'checkout.late_payment')).some((e) => e.payload.checkoutId === a.body.checkout.id)).toBe(true);
  });

  it('a checkout created AND paid while another submit is in flight → 409 CART_CHANGED, no second payable checkout, hold released', async () => {
    const { u, s } = await newUser();
    let inFlightId: string | null = null;
    let paidA: string | null = null;
    h.marketplace.beforeReserve = async (req) => {
      h.marketplace.beforeReserve = null; // only for the outer (whole-cart) submit
      inFlightId = req.checkoutId;
      const a = await checkout(u, { restaurantIds: [s.a.id] });
      expect(a.status).toBe(201);
      expect(await capture(a)).toBe('PLACED'); // bumps the cart version
      paidA = a.body.checkout.id;
    };
    let r;
    try {
      r = await checkout(u, {});
    } finally {
      h.marketplace.beforeReserve = null;
    }
    expect(r.status).toBe(409);
    expect(r.body.error.details).toEqual({ reason: 'CART_CHANGED' });
    expect(await h.ctx.models.CheckoutGroup.findById(inFlightId).lean()).toBeNull();
    expect(await released()).toContain(inFlightId);
    expect((await groupOf(paidA!))!.status).toBe('PAID_PLACED');
    expect(await h.ctx.models.CheckoutGroup.countDocuments({ userId: u.userId, status: 'AWAITING_PAYMENT' })).toBe(0);
  });

  it('an overlapping checkout created (unpaid) while another submit is in flight is superseded by the in-transaction re-check', async () => {
    const { u, s } = await newUser();
    let aId: string | null = null;
    h.marketplace.beforeReserve = async () => {
      h.marketplace.beforeReserve = null;
      const a = await checkout(u, { restaurantIds: [s.a.id] });
      expect(a.status).toBe(201);
      aId = a.body.checkout.id;
    };
    let r;
    try {
      r = await checkout(u, {});
    } finally {
      h.marketplace.beforeReserve = null;
    }
    expect(r.status).toBe(201);
    expect((await groupOf(aId!))!.status).toBe('EXPIRED');
    expect(await h.ctx.models.CheckoutGroup.countDocuments({ userId: u.userId, status: 'AWAITING_PAYMENT' })).toBe(1);
  });

  it('supersedeCheckout refuses a checkout that is already paid (409 CHECKOUT_ALREADY_PAID) and is a no-op for closed ones', async () => {
    const { u, s } = await newUser();
    const a = await checkout(u, { restaurantIds: [s.a.id] });
    expect(await capture(a)).toBe('PLACED');
    const err = await withTransaction(h.ctx.conn, (session) => supersedeCheckout(h.ctx, session, a.body.checkout.id, 'new')).catch((e) => e);
    expect(err).toMatchObject({ code: 'CONFLICT', httpStatus: 409, details: { reason: 'CHECKOUT_ALREADY_PAID', checkoutId: a.body.checkout.id } });
    expect((await groupOf(a.body.checkout.id))!.status).toBe('PAID_PLACED');
    const b = await checkout(u, { restaurantIds: [s.b.id] });
    await withTransaction(h.ctx.conn, (session) => supersedeCheckout(h.ctx, session, b.body.checkout.id, 'x'));
    await withTransaction(h.ctx.conn, (session) => supersedeCheckout(h.ctx, session, b.body.checkout.id, 'y')); // already EXPIRED → no-op
    expect((await groupOf(b.body.checkout.id))!.status).toBe('EXPIRED');
  });

  it('superseding a checkout with a recorded amount-mismatch capture refunds that capture (late payment)', async () => {
    const { u, s } = await newUser();
    const a = await checkout(u, { restaurantIds: [s.a.id] });
    const wrong = a.body.checkout.pricing.totalPaise - 100;
    const outcome = await withTransaction(h.ctx.conn, (session) =>
      applyCapturedPayment(h.ctx, session, { checkoutId: a.body.checkout.id, paymentIntentId: a.body.payment.intentId, amountPaise: wrong, source: 'payment.captured' }),
    );
    expect(outcome).toBe('AMOUNT_MISMATCH');
    const all = await checkout(u, {});
    expect(all.status).toBe(201);
    const old = await groupOf(a.body.checkout.id);
    expect(old!.status).toBe('EXPIRED');
    expect(old!.latePayment).toMatchObject({ amountPaise: wrong, paymentIntentId: a.body.payment.intentId });
    const late = (await outboxEvents(h, 'checkout.late_payment')).filter((e) => e.payload.checkoutId === a.body.checkout.id);
    expect(late.map((e) => e.payload.amountPaise)).toEqual([wrong]);
  });

  it('{A} with a perUserLimit-1 coupon, then the whole cart with the same coupon → succeeds (old hold released first)', async () => {
    const { u, s } = await newUser();
    h.marketplace.coupons.set('ONCE50', { discountPaise: 5000, perUserLimit: 1 });
    h.marketplace.isHoldLive = async (id) => (await groupOf(id))?.status === 'AWAITING_PAYMENT';
    try {
      const a = await checkout(u, { restaurantIds: [s.a.id], couponCode: 'ONCE50' });
      expect(a.status).toBe(201);
      expect(a.body.checkout.couponCode).toBe('ONCE50');
      const all = await checkout(u, { couponCode: 'ONCE50' });
      expect(all.status).toBe(201);
      expect(all.body.checkout.pricing.couponDiscountPaise).toBe(5000);
      expect((await groupOf(a.body.checkout.id))!.status).toBe('EXPIRED');
    } finally {
      h.marketplace.isHoldLive = async () => true;
    }
  });

  it('concurrent submits with different restaurant sets → exactly one payable checkout contains A', async () => {
    const { u, s } = await newUser();
    h.marketplace.reserveDelayMs = 100;
    let results;
    try {
      results = await Promise.all([checkout(u, { restaurantIds: [s.a.id] }), checkout(u, {})]);
    } finally {
      h.marketplace.reserveDelayMs = 0;
    }
    for (const r of results) expect([201, 409]).toContain(r.status);
    const payableWithA = await h.ctx.models.ChildOrder.countDocuments({ userId: u.userId, restaurantId: s.a.id, status: 'AWAITING_PAYMENT' });
    expect(payableWithA).toBe(1);
  });

  it('a duplicate submit of the same cart version + set is still answered with the existing checkout (not superseded)', async () => {
    const { u, s } = await newUser();
    const a1 = await checkout(u, { restaurantIds: [s.a.id] });
    const a2 = await checkout(u, { restaurantIds: [s.a.id] });
    expect([a1.status, a2.status]).toEqual([201, 200]);
    expect(a2.body.checkout.id).toBe(a1.body.checkout.id);
    expect((await groupOf(a1.body.checkout.id))!.status).toBe('AWAITING_PAYMENT');
  });

  it('checkouts for other restaurants are left alone', async () => {
    const { u, s } = await newUser();
    const a = await checkout(u, { restaurantIds: [s.a.id] });
    const b = await checkout(u, { restaurantIds: [s.b.id] });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await groupOf(a.body.checkout.id))!.status).toBe('AWAITING_PAYMENT');
  });
});

describe('checkout couponCode', () => {
  it('couponCode: null checks out without the cart coupon', async () => {
    const { u } = await newUser();
    h.marketplace.coupons.set('SAVE50', { discountPaise: 5000 });
    expect((await u.put('/api/v1/cart/coupon', { couponCode: 'SAVE50' })).status).toBe(200);
    const r = await checkout(u, { couponCode: null });
    expect(r.status).toBe(201);
    expect(r.body.checkout.pricing.couponDiscountPaise).toBe(0);
    expect(r.body.checkout.couponCode).toBeNull();
  });

  it('subset checkout drops a cart coupon that does not apply to the selection (like preview); a body coupon still fails', async () => {
    const { u, s } = await newUser();
    h.marketplace.coupons.set('DOSAONLY50', { discountPaise: 5000, restaurantIds: [s.b.id] });
    expect((await u.put('/api/v1/cart/coupon', { couponCode: 'DOSAONLY50' })).status).toBe(200);
    const strict = await checkout(u, { restaurantIds: [s.a.id], couponCode: 'DOSAONLY50' });
    expect(strict.status).toBe(422);
    expect(strict.body.error.details).toMatchObject({ reason: 'NOT_APPLICABLE' });
    const preview = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, restaurantIds: [s.a.id] });
    const r = await checkout(u, { restaurantIds: [s.a.id], expectedTotalPaise: preview.body.pricing.totalPaise });
    expect(r.status).toBe(201);
    expect(r.body.checkout.pricing.couponDiscountPaise).toBe(0);
  });
});
