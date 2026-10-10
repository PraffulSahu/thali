/**
 * ORD-3: check out one restaurant's part of the cart (`restaurantIds` on preview + checkout), the
 * `{userId, cartVersion, restaurantSetKey}` duplicate-submit index and its boot migration.
 */
import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@thali/service-kit';
import { applyCapturedPayment } from '../src/domain/place.js';
import { ACTIVE_CHECKOUT_INDEX, LEGACY_ACTIVE_CHECKOUT_INDEX, initOrdersDb, migrateCheckoutIndexes } from '../src/models/index.js';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, idemKey, oid, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('subset_checkout');
});
afterAll(async () => {
  await h.cleanup();
});

function checkoutReq(token: string, body: object) {
  return request(h.app).post('/api/v1/checkouts').set('authorization', `Bearer ${token}`).set('Idempotency-Key', idemKey()).send(body);
}

describe('ORD-3 subset preview', () => {
  it('quotes and prices only the selected restaurants', async () => {
    const u = await asUser(h);
    const s = await fillTwoRestaurantCart(h, u);
    const full = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS });
    const onlyB = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, restaurantIds: [s.b.id] });
    expect(onlyB.status).toBe(200);
    expect(onlyB.body.children.map((c: { restaurantId: string }) => c.restaurantId)).toEqual([s.b.id]);
    const fullB = full.body.children.find((c: { restaurantId: string }) => c.restaurantId === s.b.id);
    expect(onlyB.body.children[0].breakdown.itemsSubtotalPaise).toBe(fullB.breakdown.itemsSubtotalPaise);
    expect(onlyB.body.pricing.itemsSubtotalPaise).toBe(30000);
    expect(onlyB.body.canCheckout).toBe(true);
    const lastQuote = h.marketplace.quoteCalls.at(-1)!;
    expect(lastQuote.items.every((i) => i.restaurantId === s.b.id)).toBe(true);
  });

  it('a restaurant that is not in the cart → 422 VALIDATION_FAILED; bad ids → 400', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    const missing = oid();
    const r = await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, restaurantIds: [missing] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(r.body.error.details.restaurantIds).toEqual([missing]);
    expect((await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, restaurantIds: [] })).status).toBe(400);
    expect((await u.post('/api/v1/cart/preview', { address: DROP_ADDRESS, restaurantIds: ['nope'] })).status).toBe(400);
  });
});

describe('ORD-3 subset checkout', () => {
  it('places only the selected restaurant, reserves only its lines and allows a second subset on the same cart version', async () => {
    const u = await asUser(h);
    h.identity.addUser(u.userId);
    const s = await fillTwoRestaurantCart(h, u);
    const rA = await checkoutReq(u.token, { address: DROP_ADDRESS, restaurantIds: [s.a.id] });
    expect(rA.status).toBe(201);
    expect(rA.body.checkout.children.map((c: { restaurantId: string }) => c.restaurantId)).toEqual([s.a.id]);
    const reserveA = h.marketplace.reserveCalls.find((c) => c.checkoutId === rA.body.checkout.id)!;
    expect(reserveA.lines.every((l) => l.restaurantId === s.a.id)).toBe(true);
    const groupA = await h.ctx.models.CheckoutGroup.findById(rA.body.checkout.id).lean();
    expect(groupA!.restaurantSetKey).toBe(s.a.id.toLowerCase());

    // same cart version, other restaurant → a separate checkout (the old {userId, cartVersion} index would block it)
    const rB = await checkoutReq(u.token, { address: DROP_ADDRESS, restaurantIds: [s.b.id] });
    expect(rB.status).toBe(201);
    expect(rB.body.checkout.id).not.toBe(rA.body.checkout.id);
    expect(rB.body.checkout.cartVersion).toBe(rA.body.checkout.cartVersion);

    // same subset again (different key) → the existing checkout
    const rA2 = await checkoutReq(u.token, { address: DROP_ADDRESS, restaurantIds: [s.a.id] });
    expect(rA2.status).toBe(200);
    expect(rA2.body.checkout.id).toBe(rA.body.checkout.id);
  });

  it('a subset covering every cart restaurant is the whole cart (one checkout, key "*")', async () => {
    const u = await asUser(h);
    h.identity.addUser(u.userId);
    const s = await fillTwoRestaurantCart(h, u);
    const r1 = await checkoutReq(u.token, { address: DROP_ADDRESS, restaurantIds: [s.b.id, s.a.id] });
    expect(r1.status).toBe(201);
    const r2 = await checkoutReq(u.token, { address: DROP_ADDRESS });
    expect(r2.status).toBe(200);
    expect(r2.body.checkout.id).toBe(r1.body.checkout.id);
    expect((await h.ctx.models.CheckoutGroup.findById(r1.body.checkout.id).lean())!.restaurantSetKey).toBe('*');
  });

  it('placing a subset clears only the purchased lines; the other restaurant stays in the cart', async () => {
    const u = await asUser(h);
    h.identity.addUser(u.userId);
    const s = await fillTwoRestaurantCart(h, u);
    const r = await checkoutReq(u.token, { address: DROP_ADDRESS, restaurantIds: [s.a.id] });
    expect(r.status).toBe(201);
    const outcome = await withTransaction(h.ctx.conn, (session) =>
      applyCapturedPayment(h.ctx, session, {
        checkoutId: r.body.checkout.id,
        paymentIntentId: r.body.payment.intentId,
        amountPaise: r.body.checkout.pricing.totalPaise,
        source: 'payment.captured',
      }),
    );
    expect(outcome).toBe('PLACED');
    const cart = await u.get('/api/v1/cart');
    expect(cart.body.groups.map((g: { restaurantId: string }) => g.restaurantId)).toEqual([s.b.id]);
    expect(cart.body.groups[0].lines[0].quantity).toBe(2);
  });

  it('legacy groups without restaurantSetKey count as the whole cart', async () => {
    const u = await asUser(h);
    h.identity.addUser(u.userId);
    await fillTwoRestaurantCart(h, u);
    const r1 = await checkoutReq(u.token, { address: DROP_ADDRESS });
    expect(r1.status).toBe(201);
    await h.ctx.models.CheckoutGroup.collection.updateOne({ _id: new Types.ObjectId(r1.body.checkout.id as string) }, { $unset: { restaurantSetKey: '' } });
    const r2 = await checkoutReq(u.token, { address: DROP_ADDRESS });
    expect(r2.status).toBe(200);
    expect(r2.body.checkout.id).toBe(r1.body.checkout.id);
  });

  it('checkout with a restaurant that is not in the cart → 422 VALIDATION_FAILED, nothing reserved', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    const before = h.marketplace.reserveCalls.length;
    const r = await checkoutReq(u.token, { address: DROP_ADDRESS, restaurantIds: [oid()] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(h.marketplace.reserveCalls.length).toBe(before);
  });
});

describe('ORD-3 index migration', () => {
  it('has the new unique partial index and no legacy one', async () => {
    const idx = await h.ctx.models.CheckoutGroup.collection.indexes();
    const set = idx.find((i) => i.name === ACTIVE_CHECKOUT_INDEX)!;
    expect(set.key).toEqual({ userId: 1, cartVersion: 1, restaurantSetKey: 1 });
    expect(set.unique).toBe(true);
    expect(set.partialFilterExpression).toEqual({ status: 'AWAITING_PAYMENT' });
    expect(idx.some((i) => i.name === LEGACY_ACTIVE_CHECKOUT_INDEX)).toBe(false);
  });

  it('drops a pre-redesign {userId, cartVersion} index at boot and tolerates re-runs', async () => {
    const coll = h.ctx.models.CheckoutGroup.collection;
    await coll.deleteMany({}); // the subset checkouts above would violate the legacy index (that is the point of ORD-3)
    await coll.createIndex(
      { userId: 1, cartVersion: 1 },
      { unique: true, partialFilterExpression: { status: 'AWAITING_PAYMENT' }, name: LEGACY_ACTIVE_CHECKOUT_INDEX },
    );
    expect((await coll.indexes()).some((i) => i.name === LEGACY_ACTIVE_CHECKOUT_INDEX)).toBe(true);
    await initOrdersDb(h.ctx.conn);
    const names = (await coll.indexes()).map((i) => i.name);
    expect(names).toContain(ACTIVE_CHECKOUT_INDEX);
    expect(names).not.toContain(LEGACY_ACTIVE_CHECKOUT_INDEX);
    await migrateCheckoutIndexes(h.ctx.conn); // already migrated → no-op
    await initOrdersDb(h.ctx.conn);
  });
});
