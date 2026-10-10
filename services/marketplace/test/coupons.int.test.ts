/** Coupons: internal validate (LLD §8 step 4), customer listing, admin CRUD (audited). */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createHarness, type Harness } from './helpers.js';
import { oid, seedCoupon } from './commerce-helpers.js';

let h: Harness;
let tok: string;
beforeAll(async () => {
  h = await createHarness('coupons');
  tok = await h.internalToken('orders');
});
afterAll(async () => h?.close());

const validate = (code: string, itemsSubtotalPaise: number, userId = oid()) =>
  request(h.app).post('/internal/coupons/validate').set(bearer(tok)).send({ code, userId, itemsSubtotalPaise });

const day = 86400000;

describe('POST /internal/coupons/validate', () => {
  it('FLAT discount, ≤ subtotal; code is case-insensitive', async () => {
    const { code } = await seedCoupon(h, { type: 'FLAT', valuePaise: 5000 });
    const ok = await validate(code.toLowerCase(), 30000);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ code, discountPaise: 5000 });
    const big = await seedCoupon(h, { type: 'FLAT', valuePaise: 50000 });
    expect((await validate(big.code, 30000)).body.discountPaise).toBe(30000);
  });

  it('PERCENT discount uses half-up integer rounding and the cap', async () => {
    const p = await seedCoupon(h, { type: 'PERCENT', valuePaise: undefined, valueBps: 2000 });
    expect((await validate(p.code, 30000)).body.discountPaise).toBe(6000);
    const r = await seedCoupon(h, { type: 'PERCENT', valuePaise: undefined, valueBps: 1500 });
    expect((await validate(r.code, 33333)).body.discountPaise).toBe(5000); // floor((33333*1500 + 5000)/10000)
    const capped = await seedCoupon(h, { type: 'PERCENT', valuePaise: undefined, valueBps: 2000, maxDiscountPaise: 5000 });
    expect((await validate(capped.code, 30000)).body.discountPaise).toBe(5000);
  });

  it.each([
    ['expired', { validTo: new Date(Date.now() - day) }, 'EXPIRED'],
    ['not started', { validFrom: new Date(Date.now() + day) }, 'NOT_STARTED'],
    ['inactive', { active: false }, 'INACTIVE'],
    ['below min order', { minOrderPaise: 50000 }, 'MIN_ORDER'],
  ])('%s → 422 COUPON_INVALID', async (_l, fields, reason) => {
    const { code } = await seedCoupon(h, fields);
    const res = await validate(code, 30000);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('COUPON_INVALID');
    expect(res.body.error.details.reason).toBe(reason);
  });

  it('unknown code → 422 COUPON_INVALID NOT_FOUND', async () => {
    const res = await validate('DOESNOTEXIST', 30000);
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('NOT_FOUND');
  });

  it('min order details include the threshold', async () => {
    const { code } = await seedCoupon(h, { minOrderPaise: 50000 });
    expect((await validate(code, 49999)).body.error.details.minOrderPaise).toBe(50000);
    expect((await validate(code, 50000)).status).toBe(200);
  });

  it('firstOrderOnly: allowed until the user has a placed (committed) checkout', async () => {
    const { code } = await seedCoupon(h, { firstOrderOnly: true });
    const userId = oid();
    expect((await validate(code, 30000, userId)).status).toBe(200);
    await h.models.StockReservation.create({ checkoutId: oid(), userId, lines: [], status: 'COMMITTED', expiresAt: new Date() });
    const res = await validate(code, 30000, userId);
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('FIRST_ORDER_ONLY');
  });

  it('exhausted totalLimit / perUserLimit → 422 COUPON_LIMIT_REACHED', async () => {
    const full = await seedCoupon(h, { totalLimit: 2, usedCount: 1, heldCount: 1 });
    expect((await validate(full.code, 30000)).body.error.code).toBe('COUPON_LIMIT_REACHED');
    const per = await seedCoupon(h, { perUserLimit: 1 });
    const userId = oid();
    await h.models.CouponRedemption.create({ couponId: per.id, code: per.code, userId, checkoutId: oid(), status: 'REDEEMED', discountPaise: 5000, expiresAt: new Date() });
    expect((await validate(per.code, 30000, userId)).body.error.code).toBe('COUPON_LIMIT_REACHED');
    expect((await validate(per.code, 30000)).status).toBe(200);
  });

  it('only orders may call', async () => {
    const res = await request(h.app).post('/internal/coupons/validate').set(bearer(await h.internalToken('payments'))).send({ code: 'X', userId: oid(), itemsSubtotalPaise: 1 });
    expect(res.status).toBe(403);
  });
});

describe('GET /coupons/available', () => {
  it('lists active, in-window, non-exhausted coupons with per-user remaining uses', async () => {
    const userId = oid();
    const live = await seedCoupon(h, { perUserLimit: 2, description: 'Live one' });
    const gone = await seedCoupon(h, { totalLimit: 1, usedCount: 1 });
    const off = await seedCoupon(h, { active: false });
    const first = await seedCoupon(h, { firstOrderOnly: true });
    await h.models.CouponRedemption.create({ couponId: live.id, code: live.code, userId, checkoutId: oid(), status: 'REDEEMED', discountPaise: 1, expiresAt: new Date() });
    await h.models.StockReservation.create({ checkoutId: oid(), userId, lines: [], status: 'COMMITTED', expiresAt: new Date() });
    const res = await request(h.app).get('/api/v1/coupons/available').set(bearer(await h.consumerToken(userId)));
    expect(res.status).toBe(200);
    const codes = res.body.items.map((c: { code: string }) => c.code);
    expect(codes).toContain(live.code);
    expect(codes).not.toContain(gone.code);
    expect(codes).not.toContain(off.code);
    expect(codes).not.toContain(first.code); // returning customer
    expect(res.body.items.find((c: { code: string }) => c.code === live.code)).toMatchObject({ description: 'Live one', remainingUses: 1, type: 'FLAT', valuePaise: 5000 });
    expect((await request(h.app).get('/api/v1/coupons/available')).status).toBe(401);
  });
});

describe('admin coupons CRUD', () => {
  const base = { description: 'Festive', type: 'PERCENT', valueBps: 1000, maxDiscountPaise: 10000, minOrderPaise: 20000, validFrom: new Date(Date.now() - day).toISOString(), validTo: new Date(Date.now() + 10 * day).toISOString(), totalLimit: 500, perUserLimit: 1, firstOrderOnly: false };

  it('create (code upper-cased), list, patch, delete — audited; MFA required', async () => {
    const admin = await h.adminToken();
    const c = await request(h.app).post('/api/v1/admin/marketplace/coupons').set(bearer(admin)).send({ ...base, code: 'diwali25' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: 'DIWALI25', type: 'PERCENT', valueBps: 1000, usedCount: 0, heldCount: 0, active: true });
    expect((await request(h.app).post('/api/v1/admin/marketplace/coupons').set(bearer(admin)).send({ ...base, code: 'DIWALI25' })).status).toBe(409);
    const list = await request(h.app).get('/api/v1/admin/marketplace/coupons').set(bearer(admin));
    expect(list.body.items.map((x: { code: string }) => x.code)).toContain('DIWALI25');
    const p = await request(h.app).patch(`/api/v1/admin/marketplace/coupons/${c.body.id}`).set(bearer(admin)).send({ active: false, totalLimit: 10 });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ active: false, totalLimit: 10 });
    const audits = await h.events('audit.recorded');
    expect(audits.map((e) => e.payload.action)).toEqual(expect.arrayContaining(['coupon.create', 'coupon.update']));
    expect((await request(h.app).delete(`/api/v1/admin/marketplace/coupons/${c.body.id}`).set(bearer(admin))).status).toBe(204);
    expect((await request(h.app).get('/api/v1/admin/marketplace/coupons').set(bearer(await h.adminToken({ mfa: false })))).status).toBe(403);
  });

  it('PATCH of one field leaves every other field unchanged (no defaults re-applied)', async () => {
    const admin = await h.adminToken();
    const c = await request(h.app)
      .post('/api/v1/admin/marketplace/coupons')
      .set(bearer(admin))
      .send({ ...base, code: 'KEEPME1', active: false, totalLimit: 7, perUserLimit: 3, firstOrderOnly: true, minOrderPaise: 12345 });
    expect(c.status).toBe(201);
    const p = await request(h.app).patch(`/api/v1/admin/marketplace/coupons/${c.body.id}`).set(bearer(admin)).send({ description: 'Just the text' });
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ ...c.body, description: 'Just the text' });
    const unlimited = await request(h.app).patch(`/api/v1/admin/marketplace/coupons/${c.body.id}`).set(bearer(admin)).send({ totalLimit: null });
    expect(unlimited.body).toEqual({ ...c.body, description: 'Just the text', totalLimit: null });
  });

  it('validation: PERCENT needs valueBps, FLAT needs valuePaise, validTo after validFrom', async () => {
    const admin = await h.adminToken();
    const post = (b: Record<string, unknown>) => request(h.app).post('/api/v1/admin/marketplace/coupons').set(bearer(admin)).send(b);
    expect((await post({ ...base, code: 'NOBPS1', valueBps: undefined })).status).toBe(400);
    expect((await post({ ...base, code: 'NOPAISE1', type: 'FLAT', valueBps: undefined })).status).toBe(400);
    expect((await post({ ...base, code: 'BACKWARDS', validTo: new Date(Date.now() - 2 * day).toISOString() })).status).toBe(400);
  });

  it('a coupon with redemptions cannot be deleted (deactivate instead)', async () => {
    const admin = await h.adminToken();
    const c = await seedCoupon(h);
    await h.models.CouponRedemption.create({ couponId: c.id, code: c.code, userId: oid(), checkoutId: oid(), status: 'REDEEMED', discountPaise: 1, expiresAt: new Date() });
    const res = await request(h.app).delete(`/api/v1/admin/marketplace/coupons/${c.id}`).set(bearer(admin));
    expect(res.status).toBe(409);
  });
});
