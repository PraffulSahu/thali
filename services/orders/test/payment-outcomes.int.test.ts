import request from 'supertest';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subscribeRealtime, type ConsumerHandle } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { startOrdersConsumers } from '../src/events/index.js';
import { runCheckoutExpiry } from '../src/jobs/checkout-expiry.js';
import { asUser, DROP_ADDRESS, fillTwoRestaurantCart, idemKey, outboxEvents, publishEvent, setup, type Harness } from './helpers.js';

let h: Harness;
let consumers: ConsumerHandle[];
beforeAll(async () => {
  h = await setup('payment_outcomes');
  consumers = startOrdersConsumers(h.ctx, { backoffBaseMs: 20, maxBackoffMs: 200, claimIdleMs: 300, blockMs: 100 });
  await Promise.all(consumers.map((c) => c.ready));
});
afterAll(async () => {
  await Promise.all(consumers.map((c) => c.stop()));
  await h.cleanup();
});

async function newCheckout() {
  const u = await asUser(h);
  h.identity.addUser(u.userId);
  const s = await fillTwoRestaurantCart(h, u);
  const r = await request(h.app)
    .post('/api/v1/checkouts')
    .set('authorization', `Bearer ${u.token}`)
    .set('Idempotency-Key', idemKey())
    .send({ address: DROP_ADDRESS });
  expect(r.status).toBe(201);
  return { u, s, checkout: r.body.checkout, payment: r.body.payment };
}

const captured = (c: Awaited<ReturnType<typeof newCheckout>>, amountPaise = c.checkout.pricing.totalPaise) =>
  publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'payment.captured', {
    paymentIntentId: c.payment.intentId,
    purpose: 'CHECKOUT',
    referenceId: c.checkout.id,
    userId: c.u.userId,
    amountPaise,
    providerPaymentId: 'pay_123',
  });

const processed = (eventId: string) => waitFor(async () => (await h.db.conn.collection('inbox').findOne({ _id: eventId as never })) !== null);
const oidOf = (id: string) => new Types.ObjectId(id) as never;
const group = (id: string) => h.db.conn.collection('checkout_groups').findOne({ _id: oidOf(id) });
const childrenOf = (id: string) =>
  h.db.conn.collection('child_orders').find({ checkoutGroupId: oidOf(id) }).sort({ restaurantId: 1 }).toArray();

describe('payment.captured', () => {
  it('places both children with acceptBy, emits order.placed ×2 and checkout.confirmed once, clears the cart, publishes realtime', async () => {
    const c = await newCheckout();
    const messages: { event: string; data: { status: string; checkoutId: string } }[] = [];
    const sub = await subscribeRealtime(h.tr.redis, [`user:${c.u.userId}`], (_ch, m) => messages.push(m as never));
    try {
      expect((await c.u.get('/api/v1/cart')).body.itemCount).toBe(3); // not cleared before capture
      const t0 = Date.now();
      const env = await captured(c);
      await processed(env.id);

      const kids = await childrenOf(c.checkout.id);
      expect(kids.map((k) => k.status)).toEqual(['PLACED', 'PLACED']);
      for (const k of kids) {
        const acceptBy = new Date(k.acceptBy).getTime();
        expect(acceptBy - t0).toBeGreaterThanOrEqual(299_000);
        expect(acceptBy - t0).toBeLessThan(310_000);
        expect(k.placedAt).toBeInstanceOf(Date);
        expect(k.statusHistory.at(-1)).toMatchObject({ from: 'AWAITING_PAYMENT', to: 'PLACED', actor: 'SYSTEM' });
      }
      const g = await group(c.checkout.id);
      expect(g!.status).toBe('PAID_PLACED');
      expect(g!.paymentStatus).toBe('CAPTURED');

      const placed = (await outboxEvents(h, 'order.placed')).filter((e) => e.payload.checkoutId === c.checkout.id);
      expect(placed).toHaveLength(2);
      const pa = placed.find((e) => e.payload.restaurantId === c.s.a.id)!;
      const childA = kids.find((k) => k.restaurantId === c.s.a.id)!;
      expect(pa.payload).toEqual({
        childOrderId: String(childA._id),
        checkoutId: c.checkout.id,
        userId: c.u.userId,
        restaurantId: c.s.a.id,
        restaurantOwnerId: c.s.a.ownerUserId,
        code: childA.code,
        totalPaise: childA.breakdown.totalPaise,
        acceptBy: new Date(childA.acceptBy).toISOString(),
      });
      const confirmed = (await outboxEvents(h, 'checkout.confirmed')).filter((e) => e.payload.checkoutId === c.checkout.id);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]!.payload.childOrderIds.sort()).toEqual(kids.map((k) => String(k._id)).sort());

      // cart cleared only after placement
      expect((await c.u.get('/api/v1/cart')).body.itemCount).toBe(0);

      await waitFor(() => messages.some((m) => m.event === 'order.updated' && m.data.status === 'PLACED'));
      expect(messages.every((m) => m.data.checkoutId === c.checkout.id)).toBe(true);

      // checkout view reflects the placement
      const view = await c.u.get(`/api/v1/checkouts/${c.checkout.id}`);
      expect(view.body.checkout.status).toBe('PAID_PLACED');
    } finally {
      await sub.close();
    }
  });

  it('delivered twice (same envelope, and a second envelope for the same payment) → no duplicates', async () => {
    const c = await newCheckout();
    const env = await captured(c);
    await h.tr.redis.xadd(`${h.tr.prefix}events.payments`, '*', 'data', JSON.stringify(env)); // exact redelivery
    const env2 = await captured(c); // different envelope id, same payment
    await processed(env.id);
    await processed(env2.id);
    expect((await outboxEvents(h, 'order.placed')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(2);
    expect((await outboxEvents(h, 'checkout.confirmed')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(1);
    expect((await outboxEvents(h, 'checkout.late_payment')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(0);
  });

  it('amount mismatch → not placed, alert recorded', async () => {
    const c = await newCheckout();
    const env = await captured(c, c.checkout.pricing.totalPaise - 100);
    await processed(env.id);
    const kids = await childrenOf(c.checkout.id);
    expect(kids.map((k) => k.status)).toEqual(['AWAITING_PAYMENT', 'AWAITING_PAYMENT']);
    expect((await group(c.checkout.id))!.status).toBe('AWAITING_PAYMENT');
    expect((await outboxEvents(h, 'order.placed')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(0);
    const alert = await h.db.conn.collection('order_events').findOne({ checkoutGroupId: oidOf(c.checkout.id), type: 'payment.amount_mismatch' });
    expect(alert).not.toBeNull();
    expect(alert!.data).toMatchObject({ expectedPaise: c.checkout.pricing.totalPaise, receivedPaise: c.checkout.pricing.totalPaise - 100 });
    // the cart is untouched
    expect((await c.u.get('/api/v1/cart')).body.itemCount).toBe(3);
  });

  it('only purchased lines are removed when the cart changed during payment', async () => {
    const c = await newCheckout();
    await c.u.post('/api/v1/cart/items', { restaurantId: c.s.a.id, itemId: c.s.dal.id, quantity: 1 });
    const env = await captured(c);
    await processed(env.id);
    const cart = await c.u.get('/api/v1/cart');
    expect(cart.body.itemCount).toBe(1);
    expect(cart.body.groups[0].lines[0].itemId).toBe(c.s.dal.id);
  });

  it('MEMBERSHIP-purpose captures are ignored by orders', async () => {
    const c = await newCheckout();
    const env = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'payment.captured', {
      paymentIntentId: c.payment.intentId,
      purpose: 'MEMBERSHIP',
      referenceId: c.checkout.id,
      userId: c.u.userId,
      amountPaise: c.checkout.pricing.totalPaise,
      providerPaymentId: 'pay_m',
    });
    await processed(env.id);
    expect((await group(c.checkout.id))!.status).toBe('AWAITING_PAYMENT');
  });
});

describe('payment.failed and late payment', () => {
  it('payment.failed → children PAYMENT_FAILED + checkout.released', async () => {
    const c = await newCheckout();
    const env = await publishEvent(h.tr.redis, h.tr.prefix, 'payments', 'payment.failed', {
      paymentIntentId: c.payment.intentId,
      purpose: 'CHECKOUT',
      referenceId: c.checkout.id,
      userId: c.u.userId,
      reason: 'card declined',
    });
    await processed(env.id);
    expect((await childrenOf(c.checkout.id)).map((k) => k.status)).toEqual(['PAYMENT_FAILED', 'PAYMENT_FAILED']);
    expect((await group(c.checkout.id))!.status).toBe('PAYMENT_FAILED');
    const rel = (await outboxEvents(h, 'checkout.released')).filter((e) => e.payload.checkoutId === c.checkout.id);
    expect(rel).toHaveLength(1);
    expect(rel[0]!.payload.reason).toBe('PAYMENT_FAILED');
    // cart kept so the customer can retry
    expect((await c.u.get('/api/v1/cart')).body.itemCount).toBe(3);
  });

  it('captured after EXPIRED → checkout.late_payment emitted, children stay EXPIRED', async () => {
    const c = await newCheckout();
    await h.db.conn.collection('checkout_groups').updateOne({ _id: oidOf(c.checkout.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await runCheckoutExpiry(h.ctx); // reconcile says CREATED → EXPIRED
    expect((await group(c.checkout.id))!.status).toBe('EXPIRED');

    const env = await captured(c);
    await processed(env.id);
    expect((await childrenOf(c.checkout.id)).map((k) => k.status)).toEqual(['EXPIRED', 'EXPIRED']);
    const late = (await outboxEvents(h, 'checkout.late_payment')).filter((e) => e.payload.checkoutId === c.checkout.id);
    expect(late).toHaveLength(1);
    expect(late[0]!.payload).toEqual({
      checkoutId: c.checkout.id,
      paymentIntentId: c.payment.intentId,
      amountPaise: c.checkout.pricing.totalPaise,
    });
    expect((await outboxEvents(h, 'order.placed')).filter((e) => e.payload.checkoutId === c.checkout.id)).toHaveLength(0);
  });
});
