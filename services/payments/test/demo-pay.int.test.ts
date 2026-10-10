import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxModel } from '@thali/service-kit';
import { reconcileIntent } from '../src/domain/reconcile.js';
import { hmacHex, internalToken, oid, paymentWebhook, setup, type Harness } from './helpers.js';

const MOCK_SECRET = 'mock-webhook-secret-for-tests-01';

let h: Harness;
let rzp: Harness;
beforeAll(async () => {
  h = await setup('demopay', {
    realProvider: true,
    env: { PAYMENT_PROVIDER: 'mock', MOCK_WEBHOOK_SECRET: MOCK_SECRET, PUBLIC_WEB_URL: 'http://localhost:5173' },
  });
  rzp = await setup('demopay_rzp');
});
afterAll(async () => {
  await h.cleanup();
  await rzp.cleanup();
});

async function createIntent(app: Harness['app'], amountPaise = 12_345) {
  const token = await internalToken('orders');
  const res = await request(app)
    .post('/internal/payment-intents')
    .set('authorization', `Bearer ${token}`)
    .send({ purpose: 'CHECKOUT', referenceId: oid(), userId: oid(), amountPaise });
  expect(res.status).toBe(201);
  return res.body as { paymentIntentId: string; providerOrderId: string; provider: string; keyId: string | null; demoPayUrl: string | null };
}

describe('demo pay (mock provider, ADR-011)', () => {
  it('mock intents expose provider mock, a mock order id and a demo pay URL', async () => {
    const intent = await createIntent(h.app);
    expect(intent.provider).toBe('mock');
    expect(intent.providerOrderId).toMatch(/^mock_order_/);
    expect(intent.keyId).toBeNull();
    expect(intent.demoPayUrl).toBe(`http://localhost:5173/demo-pay/${intent.paymentIntentId}`);
    const page = await request(h.app).get(`/api/v1/demo-pay/${intent.paymentIntentId}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ paymentIntentId: intent.paymentIntentId, amountPaise: 12_345, currency: 'INR', purpose: 'CHECKOUT', status: 'CREATED', isDemo: true });
    expect(page.body.referenceId).toBeTruthy();
  });

  it('complete success → intent CAPTURED via the signed webhook pipeline (events stored, one payment.captured)', async () => {
    const intent = await createIntent(h.app);
    const res = await request(h.app).post(`/api/v1/demo-pay/${intent.paymentIntentId}/complete`).send({ outcome: 'success' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CAPTURED');
    const events = await h.ctx.models.PaymentEvent.find({ providerOrderId: intent.providerOrderId }).lean();
    expect(events.map((e) => e.type).sort()).toEqual(['payment.authorized', 'payment.captured']);
    expect(events.every((e) => e.result === 'APPLIED' && e.provider === 'mock')).toBe(true);
    const n = await outboxModel(h.ctx.conn).countDocuments({ 'envelope.type': 'payment.captured', 'envelope.payload.paymentIntentId': intent.paymentIntentId });
    expect(n).toBe(1);
    // completing again cannot double-capture
    const again = await request(h.app).post(`/api/v1/demo-pay/${intent.paymentIntentId}/complete`).send({ outcome: 'success' });
    expect(again.status).toBe(200);
    expect(
      await outboxModel(h.ctx.conn).countDocuments({ 'envelope.type': 'payment.captured', 'envelope.payload.paymentIntentId': intent.paymentIntentId }),
    ).toBe(1);
    // the mock provider remembers the payment, so reconciliation agrees
    expect((await reconcileIntent(h.ctx, intent.paymentIntentId)).status).toBe('CAPTURED');
  });

  it('complete failure → FAILED + payment.failed', async () => {
    const intent = await createIntent(h.app);
    const res = await request(h.app).post(`/api/v1/demo-pay/${intent.paymentIntentId}/complete`).send({ outcome: 'failure' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FAILED');
    expect(await outboxModel(h.ctx.conn).countDocuments({ 'envelope.type': 'payment.failed', 'envelope.payload.paymentIntentId': intent.paymentIntentId })).toBe(1);
  });

  it('external mock webhooks are still signature-checked with MOCK_WEBHOOK_SECRET', async () => {
    const intent = await createIntent(h.app);
    const raw = JSON.stringify(paymentWebhook('payment.captured', { orderId: intent.providerOrderId, paymentId: 'pay_forged', amount: 12_345 }));
    const forged = await request(h.app)
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-thali-mock', '1')
      .set('x-razorpay-signature', hmacHex('wrong-secret', raw))
      .send(raw);
    expect(forged.status).toBe(400);
    const signed = await request(h.app)
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-thali-mock', '1')
      .set('x-razorpay-signature', hmacHex(MOCK_SECRET, raw))
      .send(raw);
    expect(signed.status).toBe(200);
    expect(signed.body.result).toBe('APPLIED');
  });

  it('unknown intent → 404; invalid outcome → 400', async () => {
    expect((await request(h.app).get(`/api/v1/demo-pay/${oid()}`)).status).toBe(404);
    const intent = await createIntent(h.app);
    expect((await request(h.app).post(`/api/v1/demo-pay/${intent.paymentIntentId}/complete`).send({ outcome: 'maybe' })).status).toBe(400);
  });

  it('demo pay routes are 404 when PAYMENT_PROVIDER=razorpay', async () => {
    const intent = await createIntent(rzp.app);
    expect(intent.demoPayUrl).toBeNull();
    expect((await request(rzp.app).get(`/api/v1/demo-pay/${intent.paymentIntentId}`)).status).toBe(404);
    const res = await request(rzp.app).post(`/api/v1/demo-pay/${intent.paymentIntentId}/complete`).send({ outcome: 'success' });
    expect(res.status).toBe(404);
    const doc = await rzp.ctx.models.PaymentIntent.findById(intent.paymentIntentId).lean();
    expect(doc!.status).toBe('CREATED');
  });
});
