/** Owner dashboard (metrics from orders stats + own menu/ratings) and admin marketplace overview. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, seedRestaurant, type Harness } from './helpers.js';
import { oid, seedActiveMembership, seedCoupon, seedItem } from './commerce-helpers.js';

let h: Harness;
let ownerId: string;
let rid: string;
beforeAll(async () => {
  h = await createHarness('dashboard');
  ownerId = oid();
  rid = await seedRestaurant(h.models, { ownerUserId: ownerId, ratingSum: 23, ratingCount: 5 });
  await seedItem(h, rid);
  await seedItem(h, rid, { available: false });
  await seedItem(h, rid, { trackStock: true, stockQty: 2, reservedQty: 2 }); // out of stock
  await seedItem(h, rid, { trackStock: true, stockQty: 4, reservedQty: 1, name: 'Low Biryani' }); // low (3 left)
  await seedItem(h, rid, { trackStock: true, stockQty: 50 });
});
afterAll(async () => h?.close());

const dash = async (userId: string, q: Record<string, string> = {}, roles = true) =>
  request(h.app)
    .get(`/api/v1/owner/restaurants/${rid}/dashboard`)
    .query(q)
    .set(bearer(roles ? await h.ownerToken(userId) : await h.consumerToken(userId)));

describe('GET /owner/restaurants/:id/dashboard', () => {
  it('order metrics come from orders /internal/orders/stats; menu + rating from stored records', async () => {
    h.orders.stats = {
      restaurantId: rid,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-08T00:00:00.000Z',
      ordersTotal: 12,
      byStatus: { DELIVERED: 9, REJECTED: 1, PLACED: 2 },
      acceptanceRate: 0.9,
      avgAcceptSeconds: 75,
      grossPaise: 540000,
      netRevenuePaise: 442800,
    };
    const res = await dash(ownerId, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(h.orders.statsCalls.at(-1)).toEqual({ restaurantId: rid, from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' });
    expect(res.body.orders).toMatchObject({ ordersTotal: 12, acceptanceRate: 0.9, grossPaise: 540000, netRevenuePaise: 442800 });
    expect(res.body.ordersAvailable).toBe(true);
    expect(res.body.restaurant).toMatchObject({ id: rid, status: 'APPROVED', open: true });
    expect(res.body.rating).toEqual({ average: 4.6, count: 5 });
    expect(res.body.menu).toMatchObject({ itemsTotal: 5, itemsUnavailable: 1, itemsOutOfStock: 1 });
    expect(res.body.menu.lowStock).toEqual([expect.objectContaining({ name: 'Low Biryani', availableQty: 3 })]);
    expect(res.body.period).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' });
  });

  it('defaults to the last 30 days', async () => {
    h.orders.stats = null;
    const t0 = Date.now();
    const res = await dash(ownerId);
    expect(res.status).toBe(200);
    const q = h.orders.statsCalls.at(-1)!;
    expect(new Date(q.to).getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(new Date(q.to).getTime() - new Date(q.from).getTime()).toBe(30 * 86400000);
  });

  it('orders unavailable → still 200 with menu metrics and orders: null (no fabricated numbers)', async () => {
    h.orders.fail = true;
    try {
      const res = await dash(ownerId);
      expect(res.status).toBe(200);
      expect(res.body.orders).toBeNull();
      expect(res.body.ordersAvailable).toBe(false);
      expect(res.body.menu.itemsTotal).toBe(5);
    } finally {
      h.orders.fail = false;
    }
  });

  it('isolation: another owner → 404, non-owner role → 403, bad range → 400', async () => {
    expect((await dash(oid())).status).toBe(404);
    expect((await dash(ownerId, {}, false)).status).toBe(403);
    expect((await dash(ownerId, { from: '2026-10-08T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' })).status).toBe(400);
  });
});

describe('GET /admin/marketplace/overview', () => {
  it('counts from stored records; ADMIN + MFA', async () => {
    await seedRestaurant(h.models, { status: 'APPROVAL_PENDING' });
    await seedCoupon(h);
    await seedCoupon(h, { active: false });
    await seedActiveMembership(h, oid());
    await h.models.StockReservation.create({ checkoutId: oid(), userId: oid(), lines: [], status: 'HELD', expiresAt: new Date(Date.now() + 60000) });
    const res = await request(h.app).get('/api/v1/admin/marketplace/overview').set(bearer(await h.adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.restaurants.byStatus).toMatchObject({ APPROVED: 1, APPROVAL_PENDING: 1 });
    expect(res.body.restaurants.total).toBe(2);
    expect(res.body.restaurants.pendingApproval).toBe(1);
    expect(res.body.coupons).toMatchObject({ active: 1, total: 2 });
    expect(res.body.memberships.active).toBe(1);
    expect(res.body.reservations.held).toBe(1);
    expect(res.body.ratings.total).toBe(0);
    expect(res.body.menu.items).toBe(5);
    expect(typeof res.body.generatedAt).toBe('string');
    expect((await request(h.app).get('/api/v1/admin/marketplace/overview').set(bearer(await h.adminToken({ mfa: false })))).status).toBe(403);
  });
});
