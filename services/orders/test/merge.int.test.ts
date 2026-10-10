import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, oid, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('merge');
});
afterAll(async () => {
  await h.cleanup();
});

async function guestWithTwoRestaurants() {
  const s = h.marketplace.seedTwo();
  const token = (await request(h.app).post('/api/v1/cart/guest')).body.guestToken as string;
  const add = (body: object) => request(h.app).post('/api/v1/cart/items').set('X-Guest-Cart', token).send(body);
  expect((await add({ restaurantId: s.a.id, itemId: s.dal.id, quantity: 2 })).status).toBe(201);
  expect((await add({ restaurantId: s.b.id, itemId: s.dosa.id, quantity: 19 })).status).toBe(201);
  return { s, token };
}

describe('guest → user cart merge', () => {
  it('identity internal merge after OTP login: user cart has the lines; merging twice does not duplicate; token dead', async () => {
    const { s, token } = await guestWithTwoRestaurants();
    const u = await asUser(h);
    // user already has 3 dosas → merged quantity capped at 20
    await u.post('/api/v1/cart/items', { restaurantId: s.b.id, itemId: s.dosa.id, quantity: 3 });

    const svc = await h.internalToken('identity');
    const m1 = await request(h.app)
      .post('/internal/cart/merge')
      .set('authorization', `Bearer ${svc}`)
      .send({ userId: u.userId, guestToken: token });
    expect(m1.status).toBe(200);
    expect(m1.body).toEqual({ merged: true, lineCount: 2 });

    const cart = await u.get('/api/v1/cart');
    expect(cart.body.groups).toHaveLength(2);
    const dosa = cart.body.groups.find((g: { restaurantId: string }) => g.restaurantId === s.b.id).lines[0];
    expect(dosa.quantity).toBe(20);
    const dal = cart.body.groups.find((g: { restaurantId: string }) => g.restaurantId === s.a.id).lines[0];
    expect(dal.quantity).toBe(2);

    const m2 = await request(h.app)
      .post('/internal/cart/merge')
      .set('authorization', `Bearer ${await h.internalToken('identity')}`)
      .send({ userId: u.userId, guestToken: token });
    expect(m2.status).toBe(200);
    expect(m2.body).toEqual({ merged: false, lineCount: 2 });
    expect((await u.get('/api/v1/cart')).body.itemCount).toBe(22);

    // guest token no longer resolves
    expect((await request(h.app).get('/api/v1/cart').set('X-Guest-Cart', token)).status).toBe(404);
  });

  it('user-initiated POST /cart/merge works and is idempotent', async () => {
    const { token } = await guestWithTwoRestaurants();
    const u = await asUser(h);
    const r1 = await u.post('/api/v1/cart/merge', { guestToken: token });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ merged: true, lineCount: 2 });
    const r2 = await u.post('/api/v1/cart/merge', { guestToken: token });
    expect(r2.body).toEqual({ merged: false, lineCount: 2 });
  });

  it('internal merge requires an identity service token', async () => {
    const r = await request(h.app).post('/internal/cart/merge').send({ userId: oid(), guestToken: 'x'.repeat(43) });
    expect(r.status).toBe(401);
    const wrong = await request(h.app)
      .post('/internal/cart/merge')
      .set('authorization', `Bearer ${await h.internalToken('delivery')}`)
      .send({ userId: oid(), guestToken: 'x'.repeat(43) });
    expect(wrong.status).toBe(403);
  });

  it('concurrent merges of the same guest cart never duplicate lines', async () => {
    const { token } = await guestWithTwoRestaurants();
    const u = await asUser(h);
    const svc = await h.internalToken('identity');
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        request(h.app).post('/internal/cart/merge').set('authorization', `Bearer ${svc}`).send({ userId: u.userId, guestToken: token }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.merged).length).toBe(1);
    expect((await u.get('/api/v1/cart')).body.itemCount).toBe(21);
  });
});
