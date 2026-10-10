import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobModules } from '../src/jobs/index.js';
import { runCheckoutExpiry } from '../src/jobs/checkout-expiry.js';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, idemKey, outboxEvents, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('expiry');
});
afterAll(async () => {
  await h.cleanup();
});

const oidOf = (id: string) => new Types.ObjectId(id) as never;
const group = (id: string) => h.db.conn.collection('checkout_groups').findOne({ _id: oidOf(id) });
const childrenOf = (id: string) => h.db.conn.collection('child_orders').find({ checkoutGroupId: oidOf(id) }).toArray();
const expireNow = (id: string, agoMs = 1000) =>
  h.db.conn.collection('checkout_groups').updateOne({ _id: oidOf(id) }, { $set: { expiresAt: new Date(Date.now() - agoMs) } });

async function newCheckout() {
  const u = await asUser(h);
  await fillTwoRestaurantCart(h, u);
  const r = await request(h.app)
    .post('/api/v1/checkouts')
    .set('authorization', `Bearer ${u.token}`)
    .set('Idempotency-Key', idemKey())
    .send({ address: DROP_ADDRESS });
  expect(r.status).toBe(201);
  return { u, checkout: r.body.checkout, payment: r.body.payment };
}

describe('checkout-expiry sweeper (LLD §8 sweeper a)', () => {
  it('is registered to run every 30 s', () => {
    const job = jobModules.find((j) => j.name === 'orders:checkout-expiry');
    expect(job).toBeDefined();
    expect(job!.intervalMs(h.config)).toBe(30_000);
  });

  it('expired checkout whose reconcile returns CAPTURED → placed (webhook missed / orders was down)', async () => {
    const c = await newCheckout();
    await expireNow(c.checkout.id);
    h.payments.reconcileStatus.set(c.payment.intentId, { status: 'CAPTURED', capturedPaise: c.checkout.pricing.totalPaise });
    await runCheckoutExpiry(h.ctx);
    expect(h.payments.reconcileCalls).toContain(c.payment.intentId);
    expect((await childrenOf(c.checkout.id)).map((k) => k.status)).toEqual(['PLACED', 'PLACED']);
    expect((await group(c.checkout.id))!.status).toBe('PAID_PLACED');
    expect((await outboxEvents(h, 'order.placed')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(2);
    expect((await outboxEvents(h, 'checkout.confirmed')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(1);
    expect((await c.u.get('/api/v1/cart')).body.itemCount).toBe(0);
  });

  it('reconcile returns CREATED → EXPIRED + checkout.released', async () => {
    const c = await newCheckout();
    await expireNow(c.checkout.id);
    await runCheckoutExpiry(h.ctx);
    expect((await childrenOf(c.checkout.id)).map((k) => k.status)).toEqual(['EXPIRED', 'EXPIRED']);
    const g = await group(c.checkout.id);
    expect(g!.status).toBe('EXPIRED');
    expect(g!.statusHistory.at(-1)).toMatchObject({ from: 'AWAITING_PAYMENT', to: 'EXPIRED' });
    const rel = (await outboxEvents(h, 'checkout.released')).filter((e) => e.payload.checkoutId === c.checkout.id);
    expect(rel).toHaveLength(1);
    expect(rel[0]!.payload.reason).toBe('EXPIRED');
    // running again is a no-op
    await runCheckoutExpiry(h.ctx);
    expect((await outboxEvents(h, 'checkout.released')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(1);
  });

  it('never expires without a reconcile: payments down → stays AWAITING_PAYMENT', async () => {
    const c = await newCheckout();
    await expireNow(c.checkout.id);
    h.payments.reconcileDown = true;
    try {
      await runCheckoutExpiry(h.ctx);
    } finally {
      h.payments.reconcileDown = false;
    }
    expect((await group(c.checkout.id))!.status).toBe('AWAITING_PAYMENT');
  });

  it('AUTHORIZED shortly after expiry is left for capture; long after expiry it is expired', async () => {
    const c = await newCheckout();
    await expireNow(c.checkout.id);
    h.payments.reconcileStatus.set(c.payment.intentId, { status: 'AUTHORIZED', capturedPaise: 0 });
    await runCheckoutExpiry(h.ctx);
    expect((await group(c.checkout.id))!.status).toBe('AWAITING_PAYMENT');
    await expireNow(c.checkout.id, 11 * 60_000);
    await runCheckoutExpiry(h.ctx);
    expect((await group(c.checkout.id))!.status).toBe('EXPIRED');
  });

  it('reconcile CAPTURED with a different amount → EXPIRED + released + late_payment (refund)', async () => {
    const c = await newCheckout();
    await expireNow(c.checkout.id);
    h.payments.reconcileStatus.set(c.payment.intentId, { status: 'CAPTURED', capturedPaise: 100 });
    await runCheckoutExpiry(h.ctx);
    expect((await group(c.checkout.id))!.status).toBe('EXPIRED');
    const late = (await outboxEvents(h, 'checkout.late_payment')).filter((e) => e.payload.checkoutId === c.checkout.id);
    expect(late).toHaveLength(1);
    expect(late[0]!.payload.amountPaise).toBe(100);
  });

  it('reconcile REFUNDED / PARTIALLY_REFUNDED (even of the full amount) is never placed → EXPIRED + late_payment', async () => {
    for (const status of ['REFUNDED', 'PARTIALLY_REFUNDED'] as const) {
      const c = await newCheckout();
      await expireNow(c.checkout.id);
      h.payments.reconcileStatus.set(c.payment.intentId, { status, capturedPaise: c.checkout.pricing.totalPaise });
      await runCheckoutExpiry(h.ctx);
      expect((await group(c.checkout.id))!.status).toBe('EXPIRED');
      expect((await outboxEvents(h, 'order.placed')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(0);
      expect((await outboxEvents(h, 'checkout.released')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(1);
      expect((await outboxEvents(h, 'checkout.late_payment')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(1);
    }
  });

  it('late-payment refund = captured − already refunded/reserved (not the full captured amount)', async () => {
    const lateFor = async (checkoutId: string) => (await outboxEvents(h, 'checkout.late_payment')).filter((e) => e.payload.checkoutId === checkoutId);
    const total = (c: Awaited<ReturnType<typeof newCheckout>>) => c.checkout.pricing.totalPaise;

    const partly = await newCheckout();
    await expireNow(partly.checkout.id);
    h.payments.reconcileStatus.set(partly.payment.intentId, { status: 'PARTIALLY_REFUNDED', capturedPaise: total(partly), refundedPaise: 3000, refundReservedPaise: 3000 });
    await runCheckoutExpiry(h.ctx);
    expect((await group(partly.checkout.id))!.status).toBe('EXPIRED');
    expect((await lateFor(partly.checkout.id)).map((e) => e.payload.amountPaise)).toEqual([total(partly) - 3000]);

    // an in-flight (reserved, not yet refunded) refund also counts
    const inflight = await newCheckout();
    await expireNow(inflight.checkout.id);
    h.payments.reconcileStatus.set(inflight.payment.intentId, { status: 'CAPTURED', capturedPaise: 5000, refundedPaise: 1000, refundReservedPaise: 2500 });
    await runCheckoutExpiry(h.ctx);
    expect((await lateFor(inflight.checkout.id)).map((e) => e.payload.amountPaise)).toEqual([2500]);

    // fully refunded → nothing left to refund (0; payments skips zero refunds)
    const full = await newCheckout();
    await expireNow(full.checkout.id);
    h.payments.reconcileStatus.set(full.payment.intentId, { status: 'REFUNDED', capturedPaise: total(full), refundedPaise: total(full), refundReservedPaise: total(full) });
    await runCheckoutExpiry(h.ctx);
    expect((await group(full.checkout.id))!.status).toBe('EXPIRED');
    expect((await lateFor(full.checkout.id)).map((e) => e.payload.amountPaise)).toEqual([0]);
  });

  it('checkout without a stored intent (crash before createIntent) → looks up by reference, then expires', async () => {
    const c = await newCheckout();
    await h.db.conn
      .collection('checkout_groups')
      .updateOne({ _id: oidOf(c.checkout.id) }, { $unset: { paymentIntentId: '' }, $set: { expiresAt: new Date(Date.now() - 1000) } });
    h.payments.intents.clear();
    await runCheckoutExpiry(h.ctx);
    expect((await group(c.checkout.id))!.status).toBe('EXPIRED');
  });

  it('unexpired checkouts are untouched', async () => {
    const c = await newCheckout();
    await runCheckoutExpiry(h.ctx);
    expect((await group(c.checkout.id))!.status).toBe('AWAITING_PAYMENT');
  });
});
