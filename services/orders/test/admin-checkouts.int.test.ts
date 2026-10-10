/**
 * ORD-1: `GET /admin/orders/checkouts` (checkout-level rows for the admin "Recent orders" table) +
 * group `customerContact` (written at checkout, backfilled by `orders:contact-backfill`).
 */
import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runContactBackfill } from '../src/jobs/contact-backfill.js';
import { checkoutAttention } from '../src/domain/admin-checkouts.js';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, idemKey, setup, type Harness } from './helpers.js';
import { asAdmin, group, placedCheckout, type Agent } from './lifecycle-helpers.js';

let h: Harness;
let admin: Agent;
beforeAll(async () => {
  h = await setup('admin_checkouts');
  admin = await asAdmin(h, { adm: ['OPS'] });
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

type Row = {
  id: string;
  code: string;
  status: string;
  attention: string | null;
  restaurants: { id: string; childOrderId: string; childStatus: string; refundStatus: string; deliveryStatus: string | null }[];
  [k: string]: unknown;
};
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('GET /admin/orders/checkouts', () => {
  it('one row per checkout with restaurants, customer, totals and attention', async () => {
    const p = await placedCheckout(h);
    const r = await admin.get(`/api/v1/admin/orders/checkouts?q=${p.u.userId}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    const row = r.body.items[0] as Row;
    expect(row).toMatchObject({
      id: p.checkout.id,
      code: p.checkout.code,
      status: 'PAID_PLACED',
      userId: p.u.userId,
      customer: { name: 'Asha Rao', phoneMasked: '+91******3210' },
      totalPaise: p.checkout.pricing.totalPaise,
      paidPaise: p.checkout.pricing.totalPaise,
      refundedPaise: 0,
      refundPendingPaise: 0,
      attention: 'AWAITING_ACCEPTANCE',
    });
    expect(typeof row.placedAt).toBe('string');
    expect(row.restaurants.map((x) => x.id).sort()).toEqual([p.s.a.id, p.s.b.id].sort());
    expect(row.restaurants.find((x) => x.id === p.s.a.id)).toMatchObject({ childOrderId: p.a.id, name: 'Spice Route', childStatus: 'PLACED', refundStatus: 'NONE' });
    const g = await group(h, p.checkout.id);
    expect(g!.customerContact).toEqual({ name: 'Asha Rao', phoneMasked: '+91******3210', phoneLast4: '3210' });

    // accepted, no partner yet → FINDING_PARTNER; rejected sibling → refund pending
    await p.ownerA.post(`/api/v1/owner/orders/${p.a.id}/accept`, { prepMinutes: 20 });
    await p.ownerB.post(`/api/v1/owner/orders/${p.b.id}/reject`, { reason: 'Out of stock' });
    const after = (await admin.get(`/api/v1/admin/orders/checkouts?q=${p.checkout.code}`)).body.items[0] as Row;
    expect(after.status).toBe('IN_PROGRESS');
    expect(after.attention).toBe('FINDING_PARTNER');
    expect(after.refundPendingPaise).toBe(p.b.total);
    expect(after.restaurants.find((x) => x.id === p.s.b.id)).toMatchObject({ childStatus: 'REJECTED', refundStatus: 'REQUESTED' });
  });

  it('filters: child code, restaurant, phone (param and digit q), status', async () => {
    const p = await placedCheckout(h);
    expect(ids((await admin.get(`/api/v1/admin/orders/checkouts?q=${p.b.code}`)).body.items)).toEqual([p.checkout.id]);
    expect(ids((await admin.get(`/api/v1/admin/orders/checkouts?q=${p.s.a.id}`)).body.items)).toEqual([p.checkout.id]);
    expect(ids((await admin.get(`/api/v1/admin/orders/checkouts?restaurantId=${p.s.b.id}`)).body.items)).toEqual([p.checkout.id]);
    expect(ids((await admin.get(`/api/v1/admin/orders/checkouts?q=Dosa&restaurantId=${p.s.b.id}`)).body.items)).toEqual([p.checkout.id]);
    expect(ids((await admin.get(`/api/v1/admin/orders/checkouts?phone=9876543210&restaurantId=${p.s.a.id}`)).body.items)).toEqual([p.checkout.id]);
    expect(ids((await admin.get(`/api/v1/admin/orders/checkouts?q=3210&restaurantId=${p.s.a.id}`)).body.items)).toEqual([p.checkout.id]);
    expect((await admin.get(`/api/v1/admin/orders/checkouts?q=1111&restaurantId=${p.s.a.id}`)).body.items).toEqual([]);
    expect(ids((await admin.get(`/api/v1/admin/orders/checkouts?status=PAID_PLACED,IN_PROGRESS&restaurantId=${p.s.a.id}`)).body.items)).toEqual([p.checkout.id]);
    expect((await admin.get(`/api/v1/admin/orders/checkouts?status=COMPLETED&restaurantId=${p.s.a.id}`)).body.items).toEqual([]);
    expect((await admin.get('/api/v1/admin/orders/checkouts?status=NOPE')).status).toBe(400);
    expect((await admin.get('/api/v1/admin/orders/checkouts?limit=51')).status).toBe(400);
  });

  it('never-placed checkouts are hidden unless asked for by status', async () => {
    const u = await asUser(h);
    h.identity.addUser(u.userId);
    await fillTwoRestaurantCart(h, u);
    const c = await request(h.app).post('/api/v1/checkouts').set('authorization', `Bearer ${u.token}`).set('Idempotency-Key', idemKey()).send({ address: DROP_ADDRESS });
    expect(c.status).toBe(201);
    expect((await admin.get(`/api/v1/admin/orders/checkouts?q=${u.userId}`)).body.items).toEqual([]);
    const awaiting = await admin.get(`/api/v1/admin/orders/checkouts?q=${u.userId}&status=AWAITING_PAYMENT`);
    expect(ids(awaiting.body.items)).toEqual([c.body.checkout.id]);
    expect(awaiting.body.items[0]).toMatchObject({ placedAt: null, paidPaise: 0, attention: null });
  });

  it('pages newest placed first with an opaque cursor; bad cursor → 400', async () => {
    const p1 = await placedCheckout(h);
    const p2 = await placedCheckout(h);
    const restaurant = `restaurantId=${p1.s.a.id}`;
    await h.ctx.models.CheckoutGroup.updateOne({ _id: p1.checkout.id }, { $set: { placedAt: new Date(Date.now() - 60_000) } });
    const first = await admin.get(`/api/v1/admin/orders/checkouts?limit=1&status=PAID_PLACED&from=${encodeURIComponent(new Date(Date.now() - 120_000).toISOString())}`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const seen = [first.body.items[0].id as string];
    let cursor = first.body.nextCursor as string | null;
    while (cursor) {
      const page = await admin.get(
        `/api/v1/admin/orders/checkouts?limit=1&status=PAID_PLACED&from=${encodeURIComponent(new Date(Date.now() - 120_000).toISOString())}&cursor=${cursor}`,
      );
      expect(page.status).toBe(200);
      seen.push(...ids(page.body.items));
      cursor = page.body.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(p1.checkout.id);
    expect(seen).toContain(p2.checkout.id);
    expect(seen.indexOf(p2.checkout.id)).toBeLessThan(seen.indexOf(p1.checkout.id)); // p1 placed earlier → later page
    expect((await admin.get(`/api/v1/admin/orders/checkouts?${restaurant}&cursor=!!`)).status).toBe(400);
    expect((await admin.get(`/api/v1/admin/orders/checkouts?${restaurant}&cursor=eyJ4IjoxfQ`)).status).toBe(400);
  });

  it('needs ADMIN + MFA', async () => {
    expect((await (await asAdmin(h, { mfa: false })).get('/api/v1/admin/orders/checkouts')).status).toBe(403);
    expect((await (await asUser(h)).get('/api/v1/admin/orders/checkouts')).status).toBe(403);
  });
});

describe('checkoutAttention', () => {
  const c = (status: string, deliveryStatus: string | null = null, refundStatus = 'NONE') => ({ status, deliveryStatus, refundStatus }) as never;
  it('ranks the most urgent issue first', () => {
    expect(checkoutAttention([c('DELIVERED')])).toBeNull();
    expect(checkoutAttention([c('PLACED')])).toBe('AWAITING_ACCEPTANCE');
    expect(checkoutAttention([c('PLACED'), c('READY_FOR_PICKUP', 'PENDING_ASSIGNMENT')])).toBe('FINDING_PARTNER');
    expect(checkoutAttention([c('PREPARING', 'ASSIGNED')])).toBeNull();
    expect(checkoutAttention([c('ACCEPTED'), c('REJECTED', null, 'FAILED')])).toBe('REFUND_FAILED');
    expect(checkoutAttention([c('DELIVERY_FAILED', 'FAILED'), c('REJECTED', null, 'FAILED')])).toBe('DELIVERY_FAILED');
  });
});

describe('group customerContact backfill', () => {
  it('copies the first child snapshot into groups that lack it and sets restaurantSetKey "*" on settled legacy groups', async () => {
    const p = await placedCheckout(h);
    await h.ctx.models.CheckoutGroup.collection.updateOne({ _id: new Types.ObjectId(p.checkout.id) }, { $unset: { customerContact: '', restaurantSetKey: '' } });
    const before = await group(h, p.checkout.id);
    const counts = await runContactBackfill(h.ctx);
    expect(counts.groups).toBeGreaterThanOrEqual(1);
    expect(counts.setKeys).toBeGreaterThanOrEqual(1);
    const g = await h.ctx.models.CheckoutGroup.collection.findOne({ _id: new Types.ObjectId(p.checkout.id) });
    expect(g!.customerContact).toEqual({ name: 'Asha Rao', phoneMasked: '+91******3210', phoneLast4: '3210' });
    expect(g!.restaurantSetKey).toBe('*');
    expect(g!.updatedAt).toEqual(before!.updatedAt);
    const again = await runContactBackfill(h.ctx);
    expect(again).toEqual({ children: 0, groups: 0, setKeys: 0 });
  });
});
