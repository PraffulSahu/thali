import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setKeyPrefix } from '@thali/service-kit';
import { buildApp } from '../src/app.js';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, idemKey, outboxEvents, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('checkout_idem');
});
afterAll(async () => {
  await h.cleanup();
});

function checkoutReq(token: string, key: string, body: object = { address: DROP_ADDRESS }) {
  return request(h.app).post('/api/v1/checkouts').set('authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
}

describe('checkout duplicate-submit protection', () => {
  it('same Idempotency-Key twice → same checkout; reserve and createIntent called once', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    const key = idemKey();
    const r1 = await checkoutReq(u.token, key);
    expect(r1.status).toBe(201);
    const r2 = await checkoutReq(u.token, key);
    expect(r2.status).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body.checkout.id).toBe(r1.body.checkout.id);
    expect(r2.text).toBe(r1.text);
    expect(h.marketplace.reserveCalls.filter((c) => c.userId === u.userId)).toHaveLength(1);
    expect(h.payments.createCalls.filter((c) => c.userId === u.userId)).toHaveLength(1);
  });

  it('same key with a different body → 409 IDEMPOTENCY_CONFLICT', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    const key = idemKey();
    expect((await checkoutReq(u.token, key)).status).toBe(201);
    const r = await checkoutReq(u.token, key, { address: DROP_ADDRESS, useMembership: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('sequential submit with a different key for the same cart version → returns the existing AWAITING_PAYMENT checkout', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    const r1 = await checkoutReq(u.token, idemKey());
    const r2 = await checkoutReq(u.token, idemKey());
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.checkout.id).toBe(r1.body.checkout.id);
    expect(r2.body.payment.intentId).toBe(r1.body.payment.intentId);
    expect(h.marketplace.reserveCalls.filter((c) => c.userId === u.userId)).toHaveLength(1);
    expect(await h.db.conn.collection('checkout_groups').countDocuments({ userId: u.userId })).toBe(1);
  });

  it('concurrent double-submit with different keys → never two checkouts', async () => {
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    h.marketplace.reserveDelayMs = 150; // widen the race window
    let results;
    try {
      results = await Promise.all([checkoutReq(u.token, idemKey()), checkoutReq(u.token, idemKey()), checkoutReq(u.token, idemKey())]);
    } finally {
      h.marketplace.reserveDelayMs = 0;
    }
    for (const r of results) expect([200, 201]).toContain(r.status);
    const ids = new Set(results.map((r) => r.body.checkout.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await h.db.conn.collection('checkout_groups').countDocuments({ userId: u.userId, status: 'AWAITING_PAYMENT' })).toBe(1);
    expect(await h.db.conn.collection('checkout_groups').countDocuments({ userId: u.userId })).toBe(1);
  });

  it('without the Redis lock (Redis SET failing) the unique partial index still yields one checkout; losers release their holds', async () => {
    const lockless = new Proxy(h.tr.redis, {
      get(target, prop) {
        if (prop === 'set') return async () => Promise.reject(new Error('redis down'));
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    setKeyPrefix(lockless, h.tr.prefix);
    const app = buildApp({ ...h.deps, redis: lockless });
    const u = await asUser(h);
    await fillTwoRestaurantCart(h, u);
    h.marketplace.reserveDelayMs = 150;
    let results;
    try {
      results = await Promise.all(
        [0, 1, 2].map(() =>
          request(app).post('/api/v1/checkouts').set('authorization', `Bearer ${u.token}`).set('Idempotency-Key', idemKey()).send({ address: DROP_ADDRESS }),
        ),
      );
    } finally {
      h.marketplace.reserveDelayMs = 0;
    }
    for (const r of results) expect([200, 201]).toContain(r.status);
    expect(new Set(results.map((r) => r.body.checkout.id)).size).toBe(1);
    expect(await h.db.conn.collection('checkout_groups').countDocuments({ userId: u.userId })).toBe(1);
    const winnerId = results[0]!.body.checkout.id;
    const reserved = h.marketplace.reserveCalls.filter((c) => c.userId === u.userId).map((c) => c.checkoutId);
    const losers = reserved.filter((id) => id !== winnerId);
    expect(losers.length).toBeGreaterThan(0); // the race really reached the index
    const released = (await outboxEvents(h, 'checkout.released')).map((e) => e.payload.checkoutId);
    for (const id of losers) expect(released).toContain(id);
    expect(released).not.toContain(winnerId);
  });

  it('the unique partial index rejects a second AWAITING_PAYMENT checkout for the same {userId, cartVersion, restaurantSetKey}', async () => {
    const indexes = await h.db.conn.collection('checkout_groups').indexes();
    const idx = indexes.find((i) => i.key.userId === 1 && i.key.cartVersion === 1 && i.key.restaurantSetKey === 1);
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(true);
    expect(idx!.partialFilterExpression).toEqual({ status: 'AWAITING_PAYMENT' });
  });

  it('changing the cart allows a new checkout (new cartVersion)', async () => {
    const u = await asUser(h);
    const s = await fillTwoRestaurantCart(h, u);
    const r1 = await checkoutReq(u.token, idemKey());
    await u.post('/api/v1/cart/items', { restaurantId: s.a.id, itemId: s.dal.id, quantity: 1 });
    const r2 = await checkoutReq(u.token, idemKey());
    expect(r2.status).toBe(201);
    expect(r2.body.checkout.id).not.toBe(r1.body.checkout.id);
  });
});
