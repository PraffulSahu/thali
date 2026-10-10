import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxModel } from '@thali/service-kit';
import { createIntent } from '../src/domain/intents.js';
import { reconcileIntent, reconcileStaleIntents } from '../src/domain/reconcile.js';
import { hmacHex, internalToken, KEY_SECRET, oid, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('reconcile');
});
afterAll(async () => {
  await h.cleanup();
});

async function newIntent(amountPaise = 25_000, userId = oid()) {
  const { intent } = await createIntent(h.ctx, { purpose: 'CHECKOUT', referenceId: oid(), userId, amountPaise });
  return intent;
}
const captured = (id: string) =>
  outboxModel(h.ctx.conn).countDocuments({ 'envelope.type': 'payment.captured', 'envelope.payload.paymentIntentId': id });

describe('reconciliation', () => {
  it('provider reports a captured payment for a CREATED intent → CAPTURED + payment.captured (missed webhook)', async () => {
    const intent = await newIntent();
    h.fake.addPayment(intent.providerOrderId!, { id: 'pay_r1', status: 'captured', amountPaise: 25_000 });
    const token = await internalToken('orders');
    const res = await request(h.app).post(`/internal/payment-intents/${intent.id}/reconcile`).set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paymentIntentId: intent.id, status: 'CAPTURED', capturedPaise: 25_000, refundedPaise: 0, refundReservedPaise: 0 });
    expect(await captured(intent.id)).toBe(1);
    // idempotent: reconciling again emits nothing new
    const again = await reconcileIntent(h.ctx, intent.id);
    expect(again.status).toBe('CAPTURED');
    expect(await captured(intent.id)).toBe(1);
    const doc = await h.ctx.models.PaymentIntent.findById(intent.id).lean();
    expect(doc!.lastReconciledAt).toBeTruthy();
    expect(doc!.providerPaymentId).toBe('pay_r1');
    // refund progress is reported so orders can refund only what is left on a late payment
    await h.ctx.models.PaymentIntent.updateOne({ _id: intent.id }, { $set: { refundedPaise: 4_000, refundReservedPaise: 9_000 } });
    const withRefunds = await request(h.app).post(`/internal/payment-intents/${intent.id}/reconcile`).set('authorization', `Bearer ${token}`);
    expect(withRefunds.body).toMatchObject({ capturedPaise: 25_000, refundedPaise: 4_000, refundReservedPaise: 9_000 });
  });

  it('provider reports nothing → stays CREATED and returns {status:"CREATED"}', async () => {
    const intent = await newIntent();
    const res = await reconcileIntent(h.ctx, intent.id);
    expect(res).toEqual({ paymentIntentId: intent.id, status: 'CREATED', capturedPaise: 0, refundedPaise: 0, refundReservedPaise: 0 });
    expect(await captured(intent.id)).toBe(0);
  });

  it('a captured payment with the wrong amount is not applied', async () => {
    const intent = await newIntent(25_000);
    h.fake.addPayment(intent.providerOrderId!, { status: 'captured', amountPaise: 100 });
    const res = await reconcileIntent(h.ctx, intent.id);
    expect(res.status).toBe('CREATED');
    expect(h.logs.some((l) => l.alert === 'PAYMENT_MISMATCH' && l.paymentIntentId === intent.id)).toBe(true);
  });

  it('authorized for more than 5 minutes → capture API called → CAPTURED', async () => {
    const intent = await newIntent();
    const p = h.fake.addPayment(intent.providerOrderId!, {
      status: 'authorized',
      amountPaise: 25_000,
      createdAt: new Date(h.clock.now.getTime() - 6 * 60_000),
    });
    h.fake.capture.mockClear();
    const res = await reconcileIntent(h.ctx, intent.id);
    expect(h.fake.capture).toHaveBeenCalledWith(p.id, 25_000);
    expect(res.status).toBe('CAPTURED');
    expect(await captured(intent.id)).toBe(1);
  });

  it('authorized less than 5 minutes ago → AUTHORIZED, no capture', async () => {
    const intent = await newIntent();
    h.fake.addPayment(intent.providerOrderId!, { status: 'authorized', amountPaise: 25_000, createdAt: new Date(h.clock.now.getTime() - 60_000) });
    h.fake.capture.mockClear();
    const res = await reconcileIntent(h.ctx, intent.id);
    expect(res.status).toBe('AUTHORIZED');
    expect(h.fake.capture).not.toHaveBeenCalled();
  });

  it('the stale-intent job reconciles AUTHORIZED intents older than 5 minutes', async () => {
    const intent = await newIntent();
    h.fake.addPayment(intent.providerOrderId!, { status: 'authorized', amountPaise: 25_000, createdAt: new Date(h.clock.now.getTime() - 60_000) });
    await reconcileIntent(h.ctx, intent.id); // → AUTHORIZED
    h.clock.advance(6 * 60_000);
    await reconcileStaleIntents(h.ctx);
    const doc = await h.ctx.models.PaymentIntent.findById(intent.id).lean();
    expect(doc!.status).toBe('CAPTURED');
  });

  it('provider failure during reconcile → 502 PAYMENT_PROVIDER_UNAVAILABLE', async () => {
    const intent = await newIntent();
    const { PaymentProviderError } = await import('../src/providers/payment-provider.js');
    h.fake.fetchOrderPayments.mockRejectedValueOnce(new PaymentProviderError('down', { retryable: true }));
    const token = await internalToken('orders');
    const res = await request(h.app).post(`/internal/payment-intents/${intent.id}/reconcile`).set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
  });
});

describe('POST /api/v1/payments/:intentId/verify', () => {
  it('valid client signature triggers reconcile but never marks captured without provider confirmation', async () => {
    const userId = oid();
    const intent = await newIntent(25_000, userId);
    const token = await h.keys.sign({ sub: userId, roles: ['CONSUMER'] });
    const body = {
      razorpay_order_id: intent.providerOrderId!,
      razorpay_payment_id: 'pay_v1',
      razorpay_signature: hmacHex(KEY_SECRET, `${intent.providerOrderId}|pay_v1`),
    };
    const pending = await request(h.app).post(`/api/v1/payments/${intent.id}/verify`).set('authorization', `Bearer ${token}`).send(body);
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe('CREATED');
    h.fake.addPayment(intent.providerOrderId!, { id: 'pay_v1', status: 'captured', amountPaise: 25_000 });
    const done = await request(h.app).post(`/api/v1/payments/${intent.id}/verify`).set('authorization', `Bearer ${token}`).send(body);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('CAPTURED');
  });

  it('invalid signature → 400; other user → 404', async () => {
    const userId = oid();
    const intent = await newIntent(25_000, userId);
    const token = await h.keys.sign({ sub: userId, roles: ['CONSUMER'] });
    const bad = await request(h.app)
      .post(`/api/v1/payments/${intent.id}/verify`)
      .set('authorization', `Bearer ${token}`)
      .send({ razorpay_order_id: intent.providerOrderId!, razorpay_payment_id: 'pay_x', razorpay_signature: 'deadbeef' });
    expect(bad.status).toBe(400);
    // signature valid for a different order id than the intent's
    const wrongOrder = await request(h.app)
      .post(`/api/v1/payments/${intent.id}/verify`)
      .set('authorization', `Bearer ${token}`)
      .send({ razorpay_order_id: 'order_other', razorpay_payment_id: 'pay_x', razorpay_signature: hmacHex(KEY_SECRET, 'order_other|pay_x') });
    expect(wrongOrder.status).toBe(400);
    const other = await h.keys.sign({ sub: oid(), roles: ['CONSUMER'] });
    const nf = await request(h.app)
      .post(`/api/v1/payments/${intent.id}/verify`)
      .set('authorization', `Bearer ${other}`)
      .send({ razorpay_order_id: intent.providerOrderId!, razorpay_payment_id: 'pay_x', razorpay_signature: 'x' });
    expect(nf.status).toBe(404);
  });
});
