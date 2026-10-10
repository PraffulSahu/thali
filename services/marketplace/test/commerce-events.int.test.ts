/** Commerce event consumers (LLD §9) + reservation expiry sweeper. Real stream consumer, real reservations via HTTP. */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deadLetterModel } from '@thali/service-kit';
import { bearer, createHarness, seedRestaurant, type Harness } from './helpers.js';
import { item, oid, processed, publishEvent, seedActiveMembership, seedCoupon, seedItem, startCommerceConsumer } from './commerce-helpers.js';
import { sweepExpiredReservations } from '../src/jobs/reservation-expiry.js';

let h: Harness;
let consumer: ReturnType<typeof startCommerceConsumer>;
let r1: string;
let r2: string;

beforeAll(async () => {
  h = await createHarness('commerce_events');
  consumer = startCommerceConsumer(h);
  await consumer.ready;
  r1 = await seedRestaurant(h.models);
  r2 = await seedRestaurant(h.models);
});
afterAll(async () => {
  await consumer?.stop();
  await h?.close();
});

interface Setup {
  checkoutId: string;
  userId: string;
  a: string; // r1 tracked item (qty 2)
  b: string; // r2 tracked item (qty 3)
  u: string; // r2 untracked
  couponId: string;
  membershipId: string;
}

/** Reserve a two-restaurant checkout with a coupon + one held free delivery. */
async function setup(opts: { ttlSec?: number } = {}): Promise<Setup> {
  const userId = oid();
  const a = await seedItem(h, r1, { trackStock: true, stockQty: 10 });
  const b = await seedItem(h, r2, { trackStock: true, stockQty: 10 });
  const u = await seedItem(h, r2);
  const { id: couponId, code } = await seedCoupon(h, { totalLimit: 10 });
  const membershipId = await seedActiveMembership(h, userId);
  const checkoutId = oid();
  const res = await request(h.app)
    .post('/internal/reservations')
    .set(bearer(await h.internalToken('orders')))
    .send({
      checkoutId,
      userId,
      lines: [
        { restaurantId: r1, itemId: a, qty: 2 },
        { restaurantId: r2, itemId: b, qty: 3 },
        { restaurantId: r2, itemId: u, qty: 1 },
      ],
      couponCode: code,
      couponDiscountPaise: 5000,
      membership: { membershipId, freeDeliveries: 1, discountPaise: 700 },
      ttlSec: opts.ttlSec ?? 900,
    });
  expect(res.status).toBe(200);
  return { checkoutId, userId, a, b, u, couponId, membershipId };
}

const reservation = (checkoutId: string) => h.models.StockReservation.findOne({ checkoutId }).lean();
const coupon = (id: string) => h.models.Coupon.findById(id).lean();
const membership = (id: string) => h.models.Membership.findById(id).lean();

async function confirm(s: Setup, childOrderIds = [oid(), oid()]) {
  const e = await publishEvent(h, 'orders', 'checkout.confirmed', { checkoutId: s.checkoutId, userId: s.userId, childOrderIds });
  await processed(h, e.id);
  return childOrderIds;
}

describe('checkout.confirmed', () => {
  it('commits stock (stockQty -= qty, reservedQty -= qty), redeems the coupon, uses the membership; duplicates idempotent', async () => {
    const s = await setup();
    await confirm(s);
    const r = (await reservation(s.checkoutId))!;
    expect(r.status).toBe('COMMITTED');
    expect(await item(h, s.a)).toMatchObject({ stockQty: 8, reservedQty: 0 });
    expect(await item(h, s.b)).toMatchObject({ stockQty: 7, reservedQty: 0 });
    expect(await item(h, s.u)).toMatchObject({ stockQty: 0, reservedQty: 0 });
    expect(await coupon(s.couponId)).toMatchObject({ usedCount: 1, heldCount: 0 });
    expect((await h.models.CouponRedemption.findOne({ checkoutId: s.checkoutId }).lean())!.status).toBe('REDEEMED');
    const m = (await membership(s.membershipId))!;
    expect(m).toMatchObject({ freeDeliveriesUsed: 1, freeDeliveriesHeld: 0 });
    expect(m.usage[0]!.status).toBe('USED');

    await confirm(s); // redelivered with a new event id
    expect(await item(h, s.a)).toMatchObject({ stockQty: 8, reservedQty: 0 });
    expect(await coupon(s.couponId)).toMatchObject({ usedCount: 1, heldCount: 0 });
    expect((await membership(s.membershipId))!.freeDeliveriesUsed).toBe(1);
  });
});

describe('checkout.released', () => {
  it('releases holds and restores counters; duplicates idempotent', async () => {
    const s = await setup();
    expect(await item(h, s.a)).toMatchObject({ stockQty: 10, reservedQty: 2 });
    for (let i = 0; i < 2; i++) {
      const e = await publishEvent(h, 'orders', 'checkout.released', { checkoutId: s.checkoutId, reason: 'PAYMENT_FAILED' });
      await processed(h, e.id);
    }
    expect((await reservation(s.checkoutId))!.status).toBe('RELEASED');
    expect(await item(h, s.a)).toMatchObject({ stockQty: 10, reservedQty: 0 });
    expect(await item(h, s.b)).toMatchObject({ stockQty: 10, reservedQty: 0 });
    expect(await coupon(s.couponId)).toMatchObject({ usedCount: 0, heldCount: 0 });
    expect((await h.models.CouponRedemption.findOne({ checkoutId: s.checkoutId }).lean())!.status).toBe('RELEASED');
    const m = (await membership(s.membershipId))!;
    expect(m).toMatchObject({ freeDeliveriesUsed: 0, freeDeliveriesHeld: 0 });
    expect(m.usage[0]!.status).toBe('RELEASED');
  });

  it('unknown checkoutId (orphan release from orders) is a no-op success', async () => {
    const e = await publishEvent(h, 'orders', 'checkout.released', { checkoutId: oid(), reason: 'EXPIRED' });
    await processed(h, e.id);
    expect(await deadLetterModel(h.db.conn).countDocuments({})).toBe(0);
  });

  it('released after commit does nothing', async () => {
    const s = await setup();
    await confirm(s);
    const e = await publishEvent(h, 'orders', 'checkout.released', { checkoutId: s.checkoutId, reason: 'EXPIRED' });
    await processed(h, e.id);
    expect((await reservation(s.checkoutId))!.status).toBe('COMMITTED');
    expect(await item(h, s.a)).toMatchObject({ stockQty: 8, reservedQty: 0 });
  });
});

describe('order.rejected / order.cancelled', () => {
  const rejected = (s: Setup, childOrderId: string, restaurantId: string) =>
    publishEvent(h, 'orders', 'order.rejected', { childOrderId, checkoutId: s.checkoutId, userId: s.userId, restaurantId, reason: 'Out of paneer', refundPaise: 1000 });

  it('rejected child after commit → restock only that restaurant’s lines, once', async () => {
    const s = await setup();
    const [c1] = await confirm(s);
    const e1 = await rejected(s, c1!, r1);
    const e2 = await rejected(s, c1!, r1);
    await processed(h, e1.id, e2.id);
    expect(await item(h, s.a)).toMatchObject({ stockQty: 10, reservedQty: 0 }); // r1 restocked
    expect(await item(h, s.b)).toMatchObject({ stockQty: 7, reservedQty: 0 }); // r2 untouched
    expect(await coupon(s.couponId)).toMatchObject({ usedCount: 1 }); // partial → coupon stays redeemed
  });

  it('all children rejected/cancelled → coupon redemption released (LLD §6)', async () => {
    const s = await setup();
    const [c1, c2] = await confirm(s);
    const e1 = await rejected(s, c1!, r1);
    const e2 = await publishEvent(h, 'orders', 'order.cancelled', { childOrderId: c2!, checkoutId: s.checkoutId, userId: s.userId, restaurantId: r2, actor: 'CUSTOMER', reason: 'changed mind', refundPaise: 100 });
    await processed(h, e1.id, e2.id);
    expect(await item(h, s.b)).toMatchObject({ stockQty: 10 }); // customer cancel (only possible from PLACED) restocks
    expect(await coupon(s.couponId)).toMatchObject({ usedCount: 0, heldCount: 0 });
    expect((await h.models.CouponRedemption.findOne({ checkoutId: s.checkoutId }).lean())!.status).toBe('RELEASED');
  });

  it('admin cancel after PREPARING does not restock; with fromStatus ACCEPTED it does', async () => {
    const s = await setup();
    const [c1, c2] = await confirm(s);
    const e1 = await publishEvent(h, 'orders', 'order.cancelled', { childOrderId: c1!, checkoutId: s.checkoutId, userId: s.userId, restaurantId: r1, actor: 'ADMIN', reason: 'x', refundPaise: 0, fromStatus: 'PREPARING' } as never);
    const e2 = await publishEvent(h, 'orders', 'order.cancelled', { childOrderId: c2!, checkoutId: s.checkoutId, userId: s.userId, restaurantId: r2, actor: 'ADMIN', reason: 'x', refundPaise: 0, fromStatus: 'ACCEPTED' } as never);
    await processed(h, e1.id, e2.id);
    expect(await item(h, s.a)).toMatchObject({ stockQty: 8 });
    expect(await item(h, s.b)).toMatchObject({ stockQty: 10 });
  });

  it('rejection that overtakes checkout.confirmed commits first, then restocks', async () => {
    const s = await setup();
    const e = await rejected(s, oid(), r1);
    await processed(h, e.id);
    expect((await reservation(s.checkoutId))!.status).toBe('COMMITTED');
    expect(await item(h, s.a)).toMatchObject({ stockQty: 10, reservedQty: 0 });
    expect(await item(h, s.b)).toMatchObject({ stockQty: 7, reservedQty: 0 });
  });
});

describe('reservation expiry sweeper', () => {
  const past = async (checkoutId: string, ms: number) =>
    h.models.StockReservation.updateOne({ checkoutId }, { $set: { expiresAt: new Date(Date.now() - ms) } });

  it('asks orders before acting: AWAITING_PAYMENT → extend, placed → commit, failed/expired/404 → release; inside grace → untouched', async () => {
    const waiting = await setup();
    const placed = await setup();
    const failed = await setup();
    const missing = await setup();
    const fresh = await setup();
    for (const s of [waiting, placed, failed, missing]) await past(s.checkoutId, 6 * 60_000);
    await past(fresh.checkoutId, 60_000); // expired but within the 5 min grace
    h.orders.checkouts.set(waiting.checkoutId, { id: waiting.checkoutId, status: 'AWAITING_PAYMENT', paymentIntentId: oid() });
    h.orders.checkouts.set(placed.checkoutId, { id: placed.checkoutId, status: 'PAID_PLACED', paymentIntentId: oid() });
    h.orders.checkouts.set(failed.checkoutId, { id: failed.checkoutId, status: 'PAYMENT_FAILED', paymentIntentId: null });
    h.orders.statusCalls.length = 0;

    const out = await sweepExpiredReservations(h.ctx);
    expect(out).toMatchObject({ extended: 1, committed: 1, released: 2, skipped: 0 });
    expect(h.orders.statusCalls).not.toContain(fresh.checkoutId);

    const w = (await reservation(waiting.checkoutId))!;
    expect(w.status).toBe('HELD');
    expect(new Date(w.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect((await reservation(placed.checkoutId))!.status).toBe('COMMITTED');
    expect(await item(h, placed.a)).toMatchObject({ stockQty: 8, reservedQty: 0 });
    expect((await reservation(failed.checkoutId))!.status).toBe('RELEASED');
    expect(await item(h, failed.a)).toMatchObject({ stockQty: 10, reservedQty: 0 });
    expect(await coupon(failed.couponId)).toMatchObject({ heldCount: 0, usedCount: 0 });
    expect((await reservation(missing.checkoutId))!.status).toBe('RELEASED');
    expect((await reservation(fresh.checkoutId))!.status).toBe('HELD');
  });

  it('orders unreachable → leaves the hold for the next run', async () => {
    const s = await setup();
    await past(s.checkoutId, 10 * 60_000);
    h.orders.fail = true;
    try {
      const out = await sweepExpiredReservations(h.ctx);
      expect(out.skipped).toBeGreaterThanOrEqual(1);
    } finally {
      h.orders.fail = false;
    }
    expect((await reservation(s.checkoutId))!.status).toBe('HELD');
    expect(await item(h, s.a)).toMatchObject({ reservedQty: 2 });
  });

  it('stuck rows back off instead of starving newer ones (more stuck rows than the batch)', async () => {
    const stuck = [await setup(), await setup(), await setup()];
    const newer = await setup();
    for (const [i, s] of stuck.entries()) {
      await past(s.checkoutId, (30 - i) * 60_000); // oldest first
      h.orders.failIds.add(s.checkoutId);
    }
    await past(newer.checkoutId, 10 * 60_000);
    h.orders.checkouts.set(newer.checkoutId, { id: newer.checkoutId, status: 'EXPIRED', paymentIntentId: null });
    try {
      const run1 = await sweepExpiredReservations(h.ctx, { batch: 2 });
      expect(run1).toMatchObject({ skipped: 2, released: 0 });
      const run2 = await sweepExpiredReservations(h.ctx, { batch: 2 });
      expect(run2).toMatchObject({ skipped: 1, released: 1 }); // third stuck row + the newer row
      expect((await reservation(newer.checkoutId))!.status).toBe('RELEASED');
      const backedOff = (await reservation(stuck[0]!.checkoutId))!;
      expect(backedOff.status).toBe('HELD');
      expect(new Date(backedOff.nextCheckAt!).getTime()).toBeGreaterThan(Date.now());
      const run3 = await sweepExpiredReservations(h.ctx, { batch: 2 });
      expect(run3.skipped + run3.released + run3.committed + run3.extended).toBe(0); // all stuck rows backing off
    } finally {
      for (const s of stuck) h.orders.failIds.delete(s.checkoutId);
    }
  });

  it('marks lapsed ACTIVE memberships EXPIRED', async () => {
    const id = await seedActiveMembership(h, oid(), { endsAt: new Date(Date.now() - 1000) });
    await sweepExpiredReservations(h.ctx);
    expect((await membership(id))!.status).toBe('EXPIRED');
  });
});
