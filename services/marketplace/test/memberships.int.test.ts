/** Memberships: plans, purchase via payments (Idempotency-Key), activation on payment.captured, benefits (LLD §6, §8 step 4). */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from '@thali/service-kit/testing';
import { bearer, createHarness, type Harness } from './helpers.js';
import { oid, processed, publishEvent, seedActiveMembership, seedPlan, startCommerceConsumer } from './commerce-helpers.js';

let h: Harness;
let consumer: ReturnType<typeof startCommerceConsumer>;
beforeAll(async () => {
  h = await createHarness('memberships');
  consumer = startCommerceConsumer(h);
  await consumer.ready;
});
afterAll(async () => {
  await consumer?.stop();
  await h?.close();
});

const day = 86400000;
const purchase = async (userId: string, planId: string, key?: string) => {
  const r = request(h.app).post('/api/v1/memberships/purchase').set(bearer(await h.consumerToken(userId)));
  if (key) r.set('idempotency-key', key);
  return r.send({ planId });
};

describe('plans + purchase', () => {
  it('GET /memberships/plans lists active plans with transparent terms (public)', async () => {
    const id = await seedPlan(h, { name: 'Gold', terms: '## Terms' });
    await seedPlan(h, { name: 'Retired', active: false });
    const res = await request(h.app).get('/api/v1/memberships/plans');
    expect(res.status).toBe(200);
    const gold = res.body.items.find((p: { id: string }) => p.id === id);
    expect(gold).toMatchObject({ name: 'Gold', pricePaise: 9900, durationDays: 30, terms: '## Terms', benefits: { freeDeliveriesPerPeriod: 2 } });
    expect(res.body.items.map((p: { name: string }) => p.name)).not.toContain('Retired');
  });

  it('purchase requires auth and an Idempotency-Key', async () => {
    const planId = await seedPlan(h);
    expect((await request(h.app).post('/api/v1/memberships/purchase').send({ planId })).status).toBe(401);
    const res = await purchase(oid(), planId);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('creates PENDING_PAYMENT + a MEMBERSHIP payment intent; replay returns the same response; nothing emitted yet', async () => {
    const planId = await seedPlan(h, { pricePaise: 14900 });
    const userId = oid();
    const before = h.payments.calls.length;
    const res = await purchase(userId, planId, 'purchase-key-0001');
    expect(res.status).toBe(201);
    expect(res.body.membership).toMatchObject({ status: 'PENDING_PAYMENT', planId, plan: { pricePaise: 14900 } });
    expect(res.body.payment).toMatchObject({ provider: 'mock', amountPaise: 14900, currency: 'INR' });
    expect(h.payments.calls.slice(before)).toEqual([{ purpose: 'MEMBERSHIP', referenceId: res.body.membership.id, userId, amountPaise: 14900 }]);
    const again = await purchase(userId, planId, 'purchase-key-0001');
    expect(again.status).toBe(201);
    expect(again.body).toEqual(res.body);
    expect(h.payments.calls.length).toBe(before + 1);
    const m = (await h.models.Membership.findById(res.body.membership.id).lean())!;
    expect(m.paymentIntentId).toBe(res.body.payment.paymentIntentId);
    expect(await h.events('membership.activated')).toHaveLength(0);
  });

  it('payments down → 502 PAYMENT_PROVIDER_UNAVAILABLE', async () => {
    const planId = await seedPlan(h);
    h.payments.fail = true;
    try {
      const res = await purchase(oid(), planId, 'purchase-key-0002');
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    } finally {
      h.payments.fail = false;
    }
  });

  it('inactive / unknown plan → 404; already active member → 409', async () => {
    const off = await seedPlan(h, { active: false });
    expect((await purchase(oid(), off, 'purchase-key-0003')).status).toBe(404);
    expect((await purchase(oid(), oid(), 'purchase-key-0004')).status).toBe(404);
    const userId = oid();
    await seedActiveMembership(h, userId);
    expect((await purchase(userId, await seedPlan(h), 'purchase-key-0005')).status).toBe(409);
  });
});

describe('activation via payment events', () => {
  it('payment.captured (MEMBERSHIP) → ACTIVE, endsAt = now + durationDays, membership.activated; duplicates do not re-activate', async () => {
    const planId = await seedPlan(h, { durationDays: 30 });
    const userId = oid();
    const res = await purchase(userId, planId, 'purchase-key-0101');
    const membershipId = res.body.membership.id as string;
    const payload = { paymentIntentId: res.body.payment.paymentIntentId, purpose: 'MEMBERSHIP' as const, referenceId: membershipId, userId, amountPaise: 9900, providerPaymentId: 'pay_1' };
    const t0 = Date.now();
    const e1 = await publishEvent(h, 'payments', 'payment.captured', payload);
    await processed(h, e1.id);
    const m = (await h.models.Membership.findById(membershipId).lean())!;
    expect(m.status).toBe('ACTIVE');
    const ends = new Date(m.endsAt!).getTime();
    expect(ends).toBeGreaterThanOrEqual(t0 + 30 * day - 1000);
    expect(ends).toBeLessThanOrEqual(Date.now() + 30 * day + 1000);
    const evs = await h.events('membership.activated');
    expect(evs.filter((e) => e.payload.membershipId === membershipId)).toHaveLength(1);
    expect(evs.find((e) => e.payload.membershipId === membershipId)!.payload).toMatchObject({ userId, planId, endsAt: new Date(ends).toISOString() });

    const e2 = await publishEvent(h, 'payments', 'payment.captured', payload); // redelivered with a new id
    const e3 = await publishEvent(h, 'payments', 'payment.captured', payload, { id: e1.id }); // same id
    await processed(h, e2.id);
    await new Promise((r) => setTimeout(r, 200));
    const after = (await h.models.Membership.findById(membershipId).lean())!;
    expect(new Date(after.endsAt!).getTime()).toBe(ends);
    expect((await h.events('membership.activated')).filter((e) => e.payload.membershipId === membershipId)).toHaveLength(1);
    expect(e3.id).toBe(e1.id);

    const me = await request(h.app).get('/api/v1/memberships/me').set(bearer(await h.consumerToken(userId)));
    expect(me.status).toBe(200);
    expect(me.body.current).toMatchObject({ id: membershipId, status: 'ACTIVE', freeDeliveriesRemaining: 2 });
    expect(me.body.history.map((x: { id: string }) => x.id)).toContain(membershipId);
  });

  it('payment.failed is mirror-only: stays PENDING_PAYMENT; retry reuses membership + intent; captured-after-failed activates once', async () => {
    const planId = await seedPlan(h);
    const userId = oid();
    const res = await purchase(userId, planId, 'purchase-key-0102');
    const membershipId = res.body.membership.id as string;
    const intentId = res.body.payment.paymentIntentId as string;
    const ignored = await publishEvent(h, 'payments', 'payment.captured', { paymentIntentId: oid(), purpose: 'CHECKOUT', referenceId: membershipId, userId, amountPaise: 9900, providerPaymentId: 'p' });
    const failed = await publishEvent(h, 'payments', 'payment.failed', { paymentIntentId: intentId, purpose: 'MEMBERSHIP', referenceId: membershipId, userId, reason: 'card declined' });
    await processed(h, ignored.id, failed.id);
    const m = (await h.models.Membership.findById(membershipId).lean())!;
    expect(m.status).toBe('PENDING_PAYMENT');
    expect(m.lastPaymentFailure).toMatchObject({ reason: 'card declined', paymentIntentId: intentId });

    const callsBefore = h.payments.calls.length;
    const retry = await purchase(userId, planId, 'purchase-key-0102-retry');
    expect(retry.status).toBe(201);
    expect(retry.body.membership.id).toBe(membershipId);
    expect(retry.body.payment.paymentIntentId).toBe(intentId);
    expect(h.payments.calls.slice(callsBefore)).toEqual([{ purpose: 'MEMBERSHIP', referenceId: membershipId, userId, amountPaise: 9900 }]);
    expect(await h.models.Membership.countDocuments({ userId })).toBe(1);

    const cap = { paymentIntentId: intentId, purpose: 'MEMBERSHIP' as const, referenceId: membershipId, userId, amountPaise: 9900, providerPaymentId: 'pay_retry' };
    const c1 = await publishEvent(h, 'payments', 'payment.captured', cap);
    const c2 = await publishEvent(h, 'payments', 'payment.captured', cap);
    await processed(h, c1.id, c2.id);
    expect((await h.models.Membership.findById(membershipId).lean())!.status).toBe('ACTIVE');
    expect((await h.events('membership.activated')).filter((e) => e.payload.membershipId === membershipId)).toHaveLength(1);
    expect(await h.models.Membership.countDocuments({ userId })).toBe(1);
  });

  it('pending sweeper: idle PENDING_PAYMENT reconciled via payments — captured → ACTIVE, otherwise CANCELLED; payments down → untouched', async () => {
    const { sweepPendingMemberships } = await import('../src/domain/memberships.js');
    const stale = new Date(Date.now() - 20 * 60_000);
    const mk = async (key: string) => {
      const userId = oid();
      const r = await purchase(userId, await seedPlan(h), key);
      await h.models.Membership.updateOne({ _id: r.body.membership.id }, { $set: { lastAttemptAt: stale } });
      return { userId, id: r.body.membership.id as string, intentId: r.body.payment.paymentIntentId as string };
    };
    const unpaid = await mk('purchase-key-0201');
    const paid = await mk('purchase-key-0202');
    const fresh = await purchase(oid(), await seedPlan(h), 'purchase-key-0203'); // within TTL
    const noIntent = await h.models.Membership.create({
      userId: oid(), planId: await seedPlan(h), planSnapshot: { name: 'x', pricePaise: 9900, durationDays: 30, benefits: { freeDeliveryMinOrderPaise: 0, freeDeliveriesPerPeriod: 1, extraDiscountBps: 0, extraDiscountCapPaise: 0 }, terms: '' },
      status: 'PENDING_PAYMENT', lastAttemptAt: stale,
    });
    h.payments.reconciled.set(paid.intentId, { status: 'CAPTURED', capturedPaise: 9900 });

    h.payments.fail = true;
    try {
      const down = await sweepPendingMemberships(h.ctx);
      expect(down.skipped).toBeGreaterThanOrEqual(3);
    } finally {
      h.payments.fail = false;
    }
    expect((await h.models.Membership.findById(unpaid.id).lean())!.status).toBe('PENDING_PAYMENT');
    await h.models.Membership.updateMany({}, { $unset: { nextCheckAt: 1 } }); // skip the back-off

    const out = await sweepPendingMemberships(h.ctx);
    expect(out).toMatchObject({ activated: 1, cancelled: 2 });
    expect((await h.models.Membership.findById(unpaid.id).lean())!.status).toBe('CANCELLED');
    expect((await h.models.Membership.findById(String(noIntent._id)).lean())!.status).toBe('CANCELLED');
    expect((await h.models.Membership.findById(paid.id).lean())!.status).toBe('ACTIVE');
    expect((await h.events('membership.activated')).filter((e) => e.payload.membershipId === paid.id)).toHaveLength(1);
    expect((await h.models.Membership.findById(fresh.body.membership.id).lean())!.status).toBe('PENDING_PAYMENT');

    // a capture that lands after the sweeper cancelled still activates
    const late = await publishEvent(h, 'payments', 'payment.captured', { paymentIntentId: unpaid.intentId, purpose: 'MEMBERSHIP', referenceId: unpaid.id, userId: unpaid.userId, amountPaise: 9900, providerPaymentId: 'late' });
    await processed(h, late.id);
    expect((await h.models.Membership.findById(unpaid.id).lean())!.status).toBe('ACTIVE');
  });

  it('captured amount different from the plan price does not activate', async () => {
    const planId = await seedPlan(h, { pricePaise: 9900 });
    const userId = oid();
    const res = await purchase(userId, planId, 'purchase-key-0103');
    const e = await publishEvent(h, 'payments', 'payment.captured', { paymentIntentId: oid(), purpose: 'MEMBERSHIP', referenceId: res.body.membership.id, userId, amountPaise: 100, providerPaymentId: 'p' });
    await processed(h, e.id);
    expect((await h.models.Membership.findById(res.body.membership.id).lean())!.status).toBe('PENDING_PAYMENT');
  });
});

describe('POST /internal/memberships/benefits', () => {
  const benefits = async (userId: string, children: { restaurantId: string; itemsSubtotalPaise: number; deliveryFeePaise: number }[]) =>
    request(h.app).post('/internal/memberships/benefits').set(bearer(await h.internalToken('orders'))).send({ userId, children });
  const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(24));
  const kids = [
    { restaurantId: A!, itemsSubtotalPaise: 30000, deliveryFeePaise: 3000 },
    { restaurantId: B!, itemsSubtotalPaise: 30000, deliveryFeePaise: 5000 },
    { restaurantId: C!, itemsSubtotalPaise: 30000, deliveryFeePaise: 4000 },
    { restaurantId: D!, itemsSubtotalPaise: 10000, deliveryFeePaise: 9000 }, // below freeDeliveryMinOrderPaise
  ];

  it('free deliveries: eligible children, highest fee first, limited to the remaining quota', async () => {
    const userId = oid();
    const membershipId = await seedActiveMembership(h, userId);
    const res = await benefits(userId, kids);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ membershipId, freeDeliveryRestaurantIds: [B, C], extraDiscountBps: 500, extraDiscountCapPaise: 5000 });

    await h.models.Membership.updateOne({ _id: membershipId }, { $set: { freeDeliveriesUsed: 1 } });
    expect((await benefits(userId, kids)).body.freeDeliveryRestaurantIds).toEqual([B]);
    await h.models.Membership.updateOne({ _id: membershipId }, { $set: { freeDeliveriesHeld: 1 } });
    const none = await benefits(userId, kids);
    expect(none.body.freeDeliveryRestaurantIds).toEqual([]);
    expect(none.body.membershipId).toBe(membershipId); // extra discount still applies
  });

  it('ties broken by restaurantId', async () => {
    const userId = oid();
    await seedActiveMembership(h, userId, {}, { freeDeliveryMinOrderPaise: 0, freeDeliveriesPerPeriod: 1, extraDiscountBps: 0, extraDiscountCapPaise: 0 });
    const res = await benefits(userId, [
      { restaurantId: C!, itemsSubtotalPaise: 100, deliveryFeePaise: 4000 },
      { restaurantId: A!, itemsSubtotalPaise: 100, deliveryFeePaise: 4000 },
    ]);
    expect(res.body.freeDeliveryRestaurantIds).toEqual([A]);
  });

  it('expired or absent membership → no benefits', async () => {
    const userId = oid();
    await seedActiveMembership(h, userId, { endsAt: new Date(Date.now() - 1000) });
    const res = await benefits(userId, kids);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ membershipId: null, freeDeliveryRestaurantIds: [], extraDiscountBps: 0, extraDiscountCapPaise: 0 });
    expect((await benefits(oid(), kids)).body.membershipId).toBeNull();
  });
});

describe('admin plans CRUD', () => {
  it('create / patch / list / delete (audited, MFA)', async () => {
    const admin = await h.adminToken();
    const body = { name: 'Thali One', pricePaise: 19900, durationDays: 90, benefits: { freeDeliveryMinOrderPaise: 19900, freeDeliveriesPerPeriod: 10, extraDiscountBps: 300, extraDiscountCapPaise: 4000 }, terms: 'Prepaid, no auto-renewal.' };
    const c = await request(h.app).post('/api/v1/admin/marketplace/plans').set(bearer(admin)).send(body);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ ...body, active: true });
    const p = await request(h.app).patch(`/api/v1/admin/marketplace/plans/${c.body.id}`).set(bearer(admin)).send({ active: false });
    expect(p.body.active).toBe(false);
    const list = await request(h.app).get('/api/v1/admin/marketplace/plans').set(bearer(admin));
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(c.body.id);
    expect((await request(h.app).post('/api/v1/admin/marketplace/plans').set(bearer(admin)).send({ ...body, pricePaise: -1 })).status).toBe(400);
    await waitFor(async () => (await h.events('audit.recorded')).some((e) => e.payload.action === 'plan.update'));
    expect((await request(h.app).delete(`/api/v1/admin/marketplace/plans/${c.body.id}`).set(bearer(admin))).status).toBe(204);
  });

  it('PATCH of one plan field leaves the others (incl. active:false) unchanged', async () => {
    const admin = await h.adminToken();
    const body = { name: 'Quiet', pricePaise: 4900, durationDays: 7, benefits: { freeDeliveryMinOrderPaise: 0, freeDeliveriesPerPeriod: 1, extraDiscountBps: 0, extraDiscountCapPaise: 0 }, terms: 'Weekly.', active: false };
    const c = await request(h.app).post('/api/v1/admin/marketplace/plans').set(bearer(admin)).send(body);
    expect(c.status).toBe(201);
    const p = await request(h.app).patch(`/api/v1/admin/marketplace/plans/${c.body.id}`).set(bearer(admin)).send({ name: 'Quiet Week' });
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ ...c.body, name: 'Quiet Week' });
  });

  it('a plan with memberships cannot be deleted', async () => {
    const userId = oid();
    const membershipId = await seedActiveMembership(h, userId);
    const m = (await h.models.Membership.findById(membershipId).lean())!;
    const res = await request(h.app).delete(`/api/v1/admin/marketplace/plans/${String(m.planId)}`).set(bearer(await h.adminToken()));
    expect(res.status).toBe(409);
  });
});
