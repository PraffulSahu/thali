/**
 * ORD-7: `customerContact.phoneLast4` on child orders (written at checkout, backfilled by the
 * leader-locked `orders:contact-backfill` startup migration) + indexed admin phone search.
 */
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobModules } from '../src/jobs/index.js';
import { CONTACT_BACKFILL_INTERVAL_MS, runContactBackfill } from '../src/jobs/contact-backfill.js';
import { phoneTermLast4 } from '../src/routes/admin-orders.js';
import { setup, type Harness } from './helpers.js';
import { asAdmin, child, placedCheckout, type Agent } from './lifecycle-helpers.js';

const oidOf = (id: string) => new Types.ObjectId(id);

let h: Harness;
let admin: Agent;
beforeAll(async () => {
  h = await setup('contact_search');
  admin = await asAdmin(h);
}, 120_000);
afterAll(async () => {
  await h.cleanup();
});

describe('ORD-7 phone search', () => {
  it('phoneTermLast4 detects 4–13 digit phone terms only', () => {
    expect(phoneTermLast4('3210')).toBe('3210');
    expect(phoneTermLast4('+91 98765 43210')).toBe('3210');
    expect(phoneTermLast4('98765-43210')).toBe('3210');
    expect(phoneTermLast4('321')).toBeNull();
    expect(phoneTermLast4('12345678901234')).toBeNull();
    expect(phoneTermLast4('TH-ABCD1234')).toBeNull();
    expect(phoneTermLast4('Spice')).toBeNull();
  });

  it('stores phoneLast4 at checkout; ?phone= and a digit q match it through the index', async () => {
    const p = await placedCheckout(h);
    expect((await child(h, p.a.id))!.customerContact).toEqual({ name: 'Asha Rao', phoneMasked: '+91******3210', phoneLast4: '3210' });
    const byPhone = await admin.get(`/api/v1/admin/orders?phone=9876543210&restaurantId=${p.s.a.id}`);
    expect(byPhone.status).toBe(200);
    expect(byPhone.body.items.map((i: { id: string }) => i.id)).toEqual([p.a.id]);
    const byLast4 = await admin.get(`/api/v1/admin/orders?phone=3210&restaurantId=${p.s.b.id}`);
    expect(byLast4.body.items.map((i: { id: string }) => i.id)).toEqual([p.b.id]);
    const byQ = await admin.get(`/api/v1/admin/orders?q=${encodeURIComponent('+91 98765 43210')}&restaurantId=${p.s.a.id}`);
    expect(byQ.body.items.map((i: { id: string }) => i.id)).toEqual([p.a.id]);
    expect((await admin.get(`/api/v1/admin/orders?q=0000&restaurantId=${p.s.a.id}`)).body.items).toEqual([]);
    expect((await admin.get('/api/v1/admin/orders?phone=ab-cd')).status).toBe(400);
    const idx = await h.ctx.models.ChildOrder.collection.indexes();
    expect(idx.some((i) => i.key['customerContact.phoneLast4'] === 1)).toBe(true);
  });
});

describe('orders:contact-backfill migration', () => {
  it('is a registered leader-locked job', () => {
    const job = jobModules.find((j) => j.name === 'orders:contact-backfill');
    expect(job).toBeDefined();
    expect(job!.intervalMs(h.config)).toBe(CONTACT_BACKFILL_INTERVAL_MS);
  });

  it('fills missing child phoneLast4 from the masked snapshot (null when unknown) and is idempotent', async () => {
    const p = await placedCheckout(h);
    const C = h.ctx.models.ChildOrder.collection;
    await C.updateMany({ checkoutGroupId: oidOf(p.checkout.id) }, { $unset: { 'customerContact.phoneLast4': '' } });
    await C.updateOne({ _id: oidOf(p.b.id) }, { $set: { 'customerContact.phoneMasked': '' } });
    const before = await child(h, p.a.id);
    expect(before!.customerContact.phoneLast4).toBeUndefined();

    const first = await runContactBackfill(h.ctx, { batch: 1 });
    expect(first.children).toBeGreaterThanOrEqual(2);
    const a = await child(h, p.a.id);
    expect(a!.customerContact.phoneLast4).toBe('3210');
    expect(a!.updatedAt).toEqual(before!.updatedAt); // data fix only
    expect((await child(h, p.b.id))!.customerContact.phoneLast4).toBeNull();

    expect((await runContactBackfill(h.ctx)).children).toBe(0);
  });
});
