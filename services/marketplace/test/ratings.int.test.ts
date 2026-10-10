/** Ratings: only the order's customer, only after DELIVERED (orders internal lookup), once per child order. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, northOf, seedRestaurant, seedServiceArea, type Harness } from './helpers.js';
import { oid } from './commerce-helpers.js';

let h: Harness;
let rid: string;
const loc = { lat: 12.9716, lng: 77.6412 };

beforeAll(async () => {
  h = await createHarness('ratings');
  await seedServiceArea(h.models);
  rid = await seedRestaurant(h.models, { location: loc });
});
afterAll(async () => h?.close());

function child(userId: string, fields: Record<string, unknown> = {}) {
  const id = oid();
  h.orders.children.set(id, {
    id,
    code: 'TH-ABCDEFGH',
    checkoutGroupId: oid(),
    userId,
    restaurantId: rid,
    restaurantOwnerId: oid(),
    status: 'DELIVERED',
    deliveredAt: new Date().toISOString(),
    ...fields,
  });
  return id;
}

const rate = async (userId: string | null, body: Record<string, unknown>, restaurantId = rid) => {
  const r = request(h.app).post(`/api/v1/restaurants/${restaurantId}/ratings`);
  if (userId) r.set(bearer(await h.consumerToken(userId)));
  return r.send(body);
};

describe('POST /restaurants/:id/ratings', () => {
  it('the customer rates a delivered order once; restaurant aggregates updated', async () => {
    const u = oid();
    const c = child(u);
    const res = await rate(u, { childOrderId: c, stars: 4, comment: 'Great dal' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ restaurantId: rid, childOrderId: c, stars: 4, comment: 'Great dal' });
    expect(h.orders.childCalls).toContain(c);
    expect(await h.models.Restaurant.findById(rid).lean()).toMatchObject({ ratingSum: 4, ratingCount: 1 });
    const again = await rate(u, { childOrderId: c, stars: 5 });
    expect(again.status).toBe(409);
    expect(await h.models.Restaurant.findById(rid).lean()).toMatchObject({ ratingSum: 4, ratingCount: 1 });
  });

  it('concurrent double submit → exactly one rating', async () => {
    const u = oid();
    const c = child(u);
    const before = (await h.models.Restaurant.findById(rid).lean())!.ratingCount!;
    const res = await Promise.all([rate(u, { childOrderId: c, stars: 5 }), rate(u, { childOrderId: c, stars: 5 })]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await h.models.Restaurant.findById(rid).lean())!.ratingCount).toBe(before + 1);
  });

  it('only the order’s customer (403), only after DELIVERED (409), unknown order (404), wrong restaurant (400)', async () => {
    const u = oid();
    expect((await rate(oid(), { childOrderId: child(u), stars: 5 })).status).toBe(403);
    const notYet = await rate(u, { childOrderId: child(u, { status: 'OUT_FOR_DELIVERY', deliveredAt: null }), stars: 5 });
    expect(notYet.status).toBe(409);
    expect((await rate(u, { childOrderId: oid(), stars: 5 })).status).toBe(404);
    expect((await rate(u, { childOrderId: child(u, { restaurantId: oid() }), stars: 5 })).status).toBe(400);
  });

  it('validation + auth', async () => {
    const u = oid();
    expect((await rate(u, { childOrderId: child(u), stars: 6 })).status).toBe(400);
    expect((await rate(u, { childOrderId: child(u), stars: 0 })).status).toBe(400);
    expect((await rate(null, { childOrderId: child(u), stars: 5 })).status).toBe(401);
    expect((await rate(u, { childOrderId: child(u), stars: 5 }, oid())).status).toBe(404);
  });

  it('orders unreachable → 502, nothing stored', async () => {
    const u = oid();
    const c = child(u);
    h.orders.fail = true;
    try {
      expect((await rate(u, { childOrderId: c, stars: 5 })).status).toBeGreaterThanOrEqual(502);
    } finally {
      h.orders.fail = false;
    }
    expect(await h.models.Rating.countDocuments({ childOrderId: c })).toBe(0);
  });

  it('rating appears in discovery only after 5 ratings', async () => {
    const r2 = await seedRestaurant(h.models, { location: loc });
    const page = () => request(h.app).get(`/api/v1/restaurants/${r2}`);
    const list = () => request(h.app).get('/api/v1/discovery/restaurants').query(northOf(loc, 1));
    const stars = [5, 4, 5, 3, 5];
    for (let i = 0; i < stars.length; i++) {
      if (i === 4) {
        expect((await page()).body.restaurant.rating).toBeNull();
      }
      const u = oid();
      const c = child(u, { restaurantId: r2 });
      expect((await rate(u, { childOrderId: c, stars: stars[i] }, r2)).status).toBe(201);
    }
    expect((await page()).body.restaurant.rating).toEqual({ average: 4.4, count: 5 });
    const row = (await list()).body.items.find((x: { id: string }) => x.id === r2);
    expect(row.rating).toEqual({ average: 4.4, count: 5 });
  });
});

describe('GET /restaurants/ratings/mine (MKT-14)', () => {
  it('returns only my ratings for the asked child orders; unrated ids are absent', async () => {
    const me = oid();
    const someone = oid();
    const rated = child(me);
    const unrated = child(me);
    const theirs = child(someone);
    expect((await rate(me, { childOrderId: rated, stars: 4 })).status).toBe(201);
    expect((await rate(someone, { childOrderId: theirs, stars: 2 })).status).toBe(201);
    const res = await request(h.app)
      .get('/api/v1/restaurants/ratings/mine')
      .query({ childOrderIds: `${rated},${unrated},${theirs}` })
      .set(bearer(await h.consumerToken(me)));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ childOrderId: rated, restaurantId: rid, stars: 4, createdAt: expect.any(String) }]);
  });

  it('auth required; 1–50 ids', async () => {
    expect((await request(h.app).get('/api/v1/restaurants/ratings/mine').query({ childOrderIds: 'a' })).status).toBe(401);
    const tok = await h.consumerToken(oid());
    expect((await request(h.app).get('/api/v1/restaurants/ratings/mine').set(bearer(tok))).status).toBe(400);
    const many = Array.from({ length: 51 }, () => oid()).join(',');
    expect((await request(h.app).get('/api/v1/restaurants/ratings/mine').query({ childOrderIds: many }).set(bearer(tok))).status).toBe(400);
  });
});
