/** POST /internal/reservations (LLD §8 step 6, ADR-004) — atomic stock / coupon / membership holds under real concurrency. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, seedRestaurant, type Harness } from './helpers.js';
import { item, listen, oid, seedActiveMembership, seedCoupon, seedItem } from './commerce-helpers.js';

let h: Harness;
let tok: string;
let srv: { url: string; close: () => Promise<void> };
let rid: string;

type Body = {
  checkoutId?: string;
  userId?: string;
  lines: { restaurantId: string; itemId: string; qty: number }[];
  couponCode?: string;
  couponDiscountPaise?: number;
  membership?: { membershipId: string; freeDeliveries: number; discountPaise: number };
  ttlSec?: number;
};
const reserve = (b: Body) =>
  request(srv.url)
    .post('/internal/reservations')
    .set(bearer(tok))
    .send({ checkoutId: oid(), userId: oid(), couponDiscountPaise: 0, ttlSec: 900, ...b });

beforeAll(async () => {
  h = await createHarness('reservations');
  tok = await h.internalToken('orders');
  srv = await listen(h);
  rid = await seedRestaurant(h.models);
});
afterAll(async () => {
  await srv?.close();
  await h?.close();
});

describe('stock holds', () => {
  it('stock 1, two concurrent reservations → exactly one HELD, the other 409 OUT_OF_STOCK', async () => {
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 1 });
    const lines = [{ restaurantId: rid, itemId: it1, qty: 1 }];
    const [a, b] = await Promise.all([reserve({ lines }), reserve({ lines })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('OUT_OF_STOCK');
    expect(loser.body.error.details.problems[0]).toMatchObject({ code: 'OUT_OF_STOCK', restaurantId: rid, itemId: it1 });
    const winner = a.status === 200 ? a : b;
    expect(winner.body).toMatchObject({ status: 'HELD' });
    expect((await item(h, it1))!.reservedQty).toBe(1);
    expect(await h.models.StockReservation.countDocuments({ 'lines.itemId': it1 })).toBe(1);
  });

  it('stock 3, ten concurrent reservations → exactly three succeed, never oversold', async () => {
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 3 });
    const res = await Promise.all(Array.from({ length: 10 }, () => reserve({ lines: [{ restaurantId: rid, itemId: it1, qty: 1 }] })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(3);
    expect(res.filter((r) => r.status === 409)).toHaveLength(7);
    const doc = (await item(h, it1))!;
    expect(doc.reservedQty).toBe(3);
    expect(doc.stockQty).toBe(3);
  });

  it('same checkoutId twice → same result, stock reserved once (sequential and concurrent)', async () => {
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 10 });
    const body = { checkoutId: oid(), userId: oid(), lines: [{ restaurantId: rid, itemId: it1, qty: 2 }] };
    const a = await reserve(body);
    const b = await reserve(body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect((await item(h, it1))!.reservedQty).toBe(2);

    const body2 = { checkoutId: oid(), userId: oid(), lines: [{ restaurantId: rid, itemId: it1, qty: 3 }] };
    const both = await Promise.all([reserve(body2), reserve(body2), reserve(body2)]);
    expect(both.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(both[1]!.body).toEqual(both[0]!.body);
    expect((await item(h, it1))!.reservedQty).toBe(5);
    expect(await h.models.StockReservation.countDocuments({ checkoutId: body2.checkoutId })).toBe(1);
  });

  it('replaying a released reservation → 409 (never reported as a live hold); another user’s checkoutId → 409', async () => {
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 5 });
    const body = { checkoutId: oid(), userId: oid(), lines: [{ restaurantId: rid, itemId: it1, qty: 1 }] };
    expect((await reserve(body)).status).toBe(200);
    expect((await reserve({ ...body, userId: oid() })).status).toBe(409);
    await h.models.StockReservation.updateOne({ checkoutId: body.checkoutId }, { $set: { status: 'RELEASED' } });
    const again = await reserve(body);
    expect(again.status).toBe(409);
    expect(again.body.error.details.reason).toBe('RESERVATION_RELEASED');
  });

  it('response shape {checkoutId, status, expiresAt = now + ttlSec}', async () => {
    const it1 = await seedItem(h, rid);
    const checkoutId = oid();
    const t0 = Date.now();
    const res = await reserve({ checkoutId, lines: [{ restaurantId: rid, itemId: it1, qty: 1 }], ttlSec: 600 });
    expect(res.body.checkoutId).toBe(checkoutId);
    const exp = new Date(res.body.expiresAt).getTime();
    expect(exp).toBeGreaterThanOrEqual(t0 + 600_000 - 2000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 600_000 + 2000);
  });

  it('untracked items always succeed (stockQty 0)', async () => {
    const it1 = await seedItem(h, rid, { trackStock: false, stockQty: 0 });
    const res = await Promise.all(Array.from({ length: 5 }, () => reserve({ lines: [{ restaurantId: rid, itemId: it1, qty: 20 }] })));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await item(h, it1))!.reservedQty).toBe(0);
  });

  it('multi-line: one line short → whole reservation rolled back', async () => {
    const plenty = await seedItem(h, rid, { trackStock: true, stockQty: 10 });
    const short = await seedItem(h, rid, { trackStock: true, stockQty: 1 });
    const checkoutId = oid();
    const res = await reserve({
      checkoutId,
      lines: [
        { restaurantId: rid, itemId: plenty, qty: 2 },
        { restaurantId: rid, itemId: short, qty: 2 },
      ],
    });
    expect(res.status).toBe(409);
    expect((await item(h, plenty))!.reservedQty).toBe(0);
    expect(await h.models.StockReservation.countDocuments({ checkoutId })).toBe(0);
  });

  it('item not in that restaurant → 422 ITEM_UNAVAILABLE', async () => {
    const res = await reserve({ lines: [{ restaurantId: rid, itemId: oid(), qty: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
  });

  it('only orders may call; body validated', async () => {
    const it1 = await seedItem(h, rid);
    const r = await request(srv.url)
      .post('/internal/reservations')
      .set(bearer(await h.internalToken('delivery')))
      .send({ checkoutId: oid(), userId: oid(), lines: [{ restaurantId: rid, itemId: it1, qty: 1 }], couponDiscountPaise: 0, ttlSec: 900 });
    expect(r.status).toBe(403);
    expect((await reserve({ lines: [] })).status).toBe(400);
    expect((await reserve({ lines: [{ restaurantId: rid, itemId: it1, qty: 0 }] })).status).toBe(400);
  });
});

describe('coupon holds', () => {
  it('totalLimit 1 with two concurrent checkouts → one HELD, one 422 COUPON_LIMIT_REACHED (and its stock rolled back)', async () => {
    const { id: couponId, code } = await seedCoupon(h, { totalLimit: 1 });
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 10 });
    const lines = [{ restaurantId: rid, itemId: it1, qty: 1 }];
    const [a, b] = await Promise.all([
      reserve({ lines, couponCode: code, couponDiscountPaise: 5000 }),
      reserve({ lines, couponCode: code, couponDiscountPaise: 5000 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect((a.status === 422 ? a : b).body.error.code).toBe('COUPON_LIMIT_REACHED');
    const c = (await h.models.Coupon.findById(couponId).lean())!;
    expect(c.heldCount).toBe(1);
    expect(c.usedCount).toBe(0);
    expect((await item(h, it1))!.reservedQty).toBe(1);
    expect(await h.models.CouponRedemption.countDocuments({ couponId, status: 'HELD' })).toBe(1);
  });

  it('restaurant-scoped coupon (MKT-8): none of its restaurants in the lines → 422 NOT_APPLICABLE; in scope → HELD', async () => {
    const it1 = await seedItem(h, rid);
    const other = await seedCoupon(h, { restaurantIds: [oid()] });
    const na = await reserve({ lines: [{ restaurantId: rid, itemId: it1, qty: 1 }], couponCode: other.code, couponDiscountPaise: 100 });
    expect(na.status).toBe(422);
    expect(na.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason: 'NOT_APPLICABLE' } });
    const mine = await seedCoupon(h, { restaurantIds: [rid] });
    const ok = await reserve({ lines: [{ restaurantId: rid, itemId: it1, qty: 1 }], couponCode: mine.code, couponDiscountPaise: 100 });
    expect(ok.status).toBe(200);
  });

  it('totalLimit counts used + held', async () => {
    const { code } = await seedCoupon(h, { totalLimit: 3, usedCount: 2, heldCount: 1 });
    const it1 = await seedItem(h, rid);
    const res = await reserve({ lines: [{ restaurantId: rid, itemId: it1, qty: 1 }], couponCode: code, couponDiscountPaise: 100 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COUPON_LIMIT_REACHED');
  });

  it('perUserLimit counts HELD + REDEEMED redemptions (RELEASED do not count)', async () => {
    const { id: couponId, code } = await seedCoupon(h, { perUserLimit: 1 });
    const it1 = await seedItem(h, rid);
    const userId = oid();
    const lines = [{ restaurantId: rid, itemId: it1, qty: 1 }];
    const first = await reserve({ userId, lines, couponCode: code, couponDiscountPaise: 5000 });
    expect(first.status).toBe(200);
    const second = await reserve({ userId, lines, couponCode: code, couponDiscountPaise: 5000 });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('COUPON_LIMIT_REACHED');

    await h.models.CouponRedemption.updateOne({ couponId, userId }, { $set: { status: 'REDEEMED' } });
    expect((await reserve({ userId, lines, couponCode: code, couponDiscountPaise: 5000 })).status).toBe(422);

    await h.models.CouponRedemption.updateOne({ couponId, userId }, { $set: { status: 'RELEASED' } });
    expect((await reserve({ userId, lines, couponCode: code, couponDiscountPaise: 5000 })).status).toBe(200);
    // another user is unaffected
    expect((await reserve({ lines, couponCode: code, couponDiscountPaise: 5000 })).status).toBe(200);
  });

  it('perUserLimit holds under concurrency for the same user', async () => {
    const { id: couponId, code } = await seedCoupon(h, { perUserLimit: 1, totalLimit: 50 });
    const it1 = await seedItem(h, rid);
    const userId = oid();
    const res = await Promise.all(
      Array.from({ length: 4 }, () => reserve({ userId, lines: [{ restaurantId: rid, itemId: it1, qty: 1 }], couponCode: code, couponDiscountPaise: 100 })),
    );
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await h.models.CouponRedemption.countDocuments({ couponId, userId })).toBe(1);
    expect((await h.models.Coupon.findById(couponId).lean())!.heldCount).toBe(1);
  });

  it('coupon hold failure rolls back the stock already reserved in the same transaction', async () => {
    const { code } = await seedCoupon(h, { totalLimit: 1, usedCount: 1 });
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 4 });
    const checkoutId = oid();
    const res = await reserve({ checkoutId, lines: [{ restaurantId: rid, itemId: it1, qty: 3 }], couponCode: code, couponDiscountPaise: 100 });
    expect(res.status).toBe(422);
    const doc = (await item(h, it1))!;
    expect(doc.reservedQty).toBe(0);
    expect(doc.stockQty).toBe(4);
    expect(await h.models.StockReservation.countDocuments({ checkoutId })).toBe(0);
    expect(await h.models.CouponRedemption.countDocuments({ checkoutId })).toBe(0);
  });

  it('first-order-only: a HELD/REDEEMED redemption of ANY first-order coupon disqualifies another (sequential + concurrent)', async () => {
    const a = await seedCoupon(h, { firstOrderOnly: true });
    const b = await seedCoupon(h, { firstOrderOnly: true });
    const it1 = await seedItem(h, rid);
    const lines = [{ restaurantId: rid, itemId: it1, qty: 1 }];
    const userId = oid();
    const first = await reserve({ userId, lines, couponCode: a.code, couponDiscountPaise: 100 });
    expect(first.status).toBe(200);
    const stacked = await reserve({ userId, lines, couponCode: b.code, couponDiscountPaise: 100 });
    expect(stacked.status).toBe(422);
    expect(stacked.body.error).toMatchObject({ code: 'COUPON_INVALID', details: { reason: 'FIRST_ORDER_ONLY' } });
    const v = await request(srv.url).post('/internal/coupons/validate').set(bearer(tok)).send({ code: b.code, userId, itemsSubtotalPaise: 30000 });
    expect(v.body.error.details.reason).toBe('FIRST_ORDER_ONLY');

    // released hold frees the first-order right again
    await h.ctx.conn.transaction(async (session) => {
      const { releaseReservation } = await import('../src/domain/reservations.js');
      await releaseReservation(h.ctx, session, first.body.checkoutId, 'EXPIRED');
    });
    expect((await reserve({ userId, lines, couponCode: b.code, couponDiscountPaise: 100 })).status).toBe(200);

    // concurrent: two different first-order coupons for a fresh user → exactly one
    const c1 = await seedCoupon(h, { firstOrderOnly: true });
    const c2 = await seedCoupon(h, { firstOrderOnly: true });
    const fresh = oid();
    const res = await Promise.all([
      reserve({ userId: fresh, lines, couponCode: c1.code, couponDiscountPaise: 100 }),
      reserve({ userId: fresh, lines, couponCode: c2.code, couponDiscountPaise: 100 }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(await h.models.CouponRedemption.countDocuments({ userId: fresh, firstOrderGuard: true })).toBe(1);
  });

  it('inactive / expired coupon → 422 COUPON_INVALID', async () => {
    const it1 = await seedItem(h, rid);
    const lines = [{ restaurantId: rid, itemId: it1, qty: 1 }];
    const inactive = await seedCoupon(h, { active: false });
    const expired = await seedCoupon(h, { validTo: new Date(Date.now() - 1000) });
    for (const c of [inactive, expired, { code: 'NOPE123' }]) {
      const res = await reserve({ lines, couponCode: c.code, couponDiscountPaise: 100 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('COUPON_INVALID');
    }
  });
});

describe('membership usage holds', () => {
  it('holds free deliveries (usage HELD) and enforces the remaining quota atomically', async () => {
    const userId = oid();
    const membershipId = await seedActiveMembership(h, userId, { freeDeliveriesUsed: 1 }); // quota 2 → 1 left
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 5 });
    const lines = [{ restaurantId: rid, itemId: it1, qty: 1 }];
    const membership = { membershipId, freeDeliveries: 1, discountPaise: 500 };
    const [a, b] = await Promise.all([reserve({ userId, lines, membership }), reserve({ userId, lines, membership })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const m = (await h.models.Membership.findById(membershipId).lean())!;
    expect(m.freeDeliveriesHeld).toBe(1);
    expect(m.usage).toHaveLength(1);
    expect(m.usage[0]).toMatchObject({ freeDeliveries: 1, discountPaise: 500, status: 'HELD' });
    expect((await item(h, it1))!.reservedQty).toBe(1); // loser's stock rolled back
  });

  it("someone else's / expired membership → 409, nothing held", async () => {
    const membershipId = await seedActiveMembership(h, oid());
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 5 });
    const res = await reserve({ lines: [{ restaurantId: rid, itemId: it1, qty: 1 }], membership: { membershipId, freeDeliveries: 1, discountPaise: 0 } });
    expect(res.status).toBe(409);
    const userId = oid();
    const expired = await seedActiveMembership(h, userId, { endsAt: new Date(Date.now() - 1000) });
    const res2 = await reserve({ userId, lines: [{ restaurantId: rid, itemId: it1, qty: 1 }], membership: { membershipId: expired, freeDeliveries: 0, discountPaise: 300 } });
    expect(res2.status).toBe(409);
    expect((await item(h, it1))!.reservedQty).toBe(0);
  });
});

describe('synchronous release (I-2: orders supersedes an unpaid checkout before quoting the new one)', () => {
  const release = (checkoutId: string, body: Record<string, unknown>) =>
    request(srv.url).post(`/internal/reservations/${checkoutId}/release`).set(bearer(tok)).send(body);

  it('frees stock, coupon (per-user limit) and membership holds at once; idempotent; the async checkout.released is then a no-op', async () => {
    const userId = oid();
    const { id: couponId, code } = await seedCoupon(h, { perUserLimit: 1 });
    const membershipId = await seedActiveMembership(h, userId);
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 2 });
    const lines = [{ restaurantId: rid, itemId: it1, qty: 2 }];
    const first = await reserve({ userId, lines, couponCode: code, couponDiscountPaise: 5000, membership: { membershipId, freeDeliveries: 1, discountPaise: 0 } });
    expect(first.status).toBe(200);
    const checkoutId = first.body.checkoutId as string;

    const r1 = await release(checkoutId, { userId, reason: 'SUPERSEDED' });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ checkoutId, released: true, status: 'RELEASED' });
    expect((await item(h, it1))!.reservedQty).toBe(0);
    expect((await h.models.Coupon.findById(couponId).lean())!.heldCount).toBe(0);
    expect((await h.models.Membership.findById(membershipId).lean())!.freeDeliveriesHeld).toBe(0);
    expect((await h.models.StockReservation.findOne({ checkoutId }).lean())!.releaseReason).toBe('SUPERSEDED');

    const r2 = await release(checkoutId, { userId, reason: 'SUPERSEDED' });
    expect(r2.body).toEqual({ checkoutId, released: false, status: 'RELEASED' });
    // the outbox event arriving later changes nothing
    await h.ctx.conn.transaction(async (session) => {
      const { releaseReservation } = await import('../src/domain/reservations.js');
      expect(await releaseReservation(h.ctx, session, checkoutId, 'EXPIRED')).toBe(false);
    });
    expect((await item(h, it1))!.reservedQty).toBe(0);
    expect((await h.models.Coupon.findById(couponId).lean())!.heldCount).toBe(0);

    // the same user can hold the per-user-limit-1 coupon again right away
    expect((await reserve({ userId, lines, couponCode: code, couponDiscountPaise: 5000 })).status).toBe(200);
  });

  it('unknown checkout → released:false MISSING; committed → untouched; another user’s hold → 409; only orders may call', async () => {
    expect((await release(oid(), { userId: oid(), reason: 'SUPERSEDED' })).body).toMatchObject({ released: false, status: 'MISSING' });
    const userId = oid();
    const it1 = await seedItem(h, rid, { trackStock: true, stockQty: 5 });
    const held = await reserve({ userId, lines: [{ restaurantId: rid, itemId: it1, qty: 1 }] });
    const theirs = await release(held.body.checkoutId, { userId: oid(), reason: 'SUPERSEDED' });
    expect(theirs.status).toBe(409);
    expect((await item(h, it1))!.reservedQty).toBe(1);
    await h.ctx.conn.transaction(async (session) => {
      const { commitReservation } = await import('../src/domain/reservations.js');
      await commitReservation(h.ctx, session, held.body.checkoutId);
    });
    expect((await release(held.body.checkoutId, { userId, reason: 'SUPERSEDED' })).body).toMatchObject({ released: false, status: 'COMMITTED' });
    expect((await item(h, it1))!.stockQty).toBe(4);
    const other = await h.internalToken('delivery');
    expect((await request(srv.url).post(`/internal/reservations/${oid()}/release`).set(bearer(other)).send({ userId, reason: 'X' })).status).toBe(403);
    expect((await release('not-an-id', { userId, reason: 'X' })).status).toBe(400);
  });
});

describe('excludeCheckoutIds (I-2: preview ignores the caller’s own unpaid overlapping checkouts)', () => {
  it('validate: a HELD redemption of an excluded checkout does not count toward perUserLimit / totalLimit / first-order', async () => {
    const userId = oid();
    const it1 = await seedItem(h, rid);
    const lines = [{ restaurantId: rid, itemId: it1, qty: 1 }];
    const once = await seedCoupon(h, { perUserLimit: 1, totalLimit: 1 });
    const held = await reserve({ userId, lines, couponCode: once.code, couponDiscountPaise: 5000 });
    expect(held.status).toBe(200);
    const validate = (code: string, extra: Record<string, unknown> = {}) =>
      request(srv.url).post('/internal/coupons/validate').set(bearer(tok)).send({ code, userId, itemsSubtotalPaise: 30000, ...extra });
    expect((await validate(once.code)).status).toBe(422);
    const ok = await validate(once.code, { excludeCheckoutIds: [held.body.checkoutId] });
    expect(ok.status).toBe(200);
    // another user's checkout id in the list changes nothing for this user's count
    expect((await validate(once.code, { excludeCheckoutIds: [oid()] })).status).toBe(422);

    const first = await seedCoupon(h, { firstOrderOnly: true });
    const fresh = oid();
    const fh = await reserve({ userId: fresh, lines, couponCode: first.code, couponDiscountPaise: 100 });
    const second = await seedCoupon(h, { firstOrderOnly: true });
    const v1 = await request(srv.url).post('/internal/coupons/validate').set(bearer(tok)).send({ code: second.code, userId: fresh, itemsSubtotalPaise: 30000 });
    expect(v1.body.error.details.reason).toBe('FIRST_ORDER_ONLY');
    const v2 = await request(srv.url)
      .post('/internal/coupons/validate')
      .set(bearer(tok))
      .send({ code: second.code, userId: fresh, itemsSubtotalPaise: 30000, excludeCheckoutIds: [fh.body.checkoutId] });
    expect(v2.status).toBe(200);
  });

  it('benefits: free deliveries held by an excluded checkout count as remaining', async () => {
    const userId = oid();
    const membershipId = await seedActiveMembership(h, userId, { freeDeliveriesUsed: 1 }); // quota 2 → 1 left
    const it1 = await seedItem(h, rid);
    const held = await reserve({ userId, lines: [{ restaurantId: rid, itemId: it1, qty: 1 }], membership: { membershipId, freeDeliveries: 1, discountPaise: 0 } });
    expect(held.status).toBe(200);
    const children = [{ restaurantId: rid, itemsSubtotalPaise: 50000, deliveryFeePaise: 3000 }];
    const benefits = (extra: Record<string, unknown> = {}) => request(srv.url).post('/internal/memberships/benefits').set(bearer(tok)).send({ userId, children, ...extra });
    expect((await benefits()).body.freeDeliveryRestaurantIds).toEqual([]);
    const ex = await benefits({ excludeCheckoutIds: [held.body.checkoutId] });
    expect(ex.body.freeDeliveryRestaurantIds).toEqual([rid]);
    expect(ex.body.freeDeliveriesRemaining).toBe(1);
  });
});
