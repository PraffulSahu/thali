import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internalToken, oid, setup, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('intents');
});
afterAll(async () => {
  await h.cleanup();
});

describe('POST /internal/payment-intents', () => {
  it('same purpose+referenceId twice → same intent; provider createOrder called once', async () => {
    const token = await internalToken('orders');
    const body = { purpose: 'CHECKOUT', referenceId: oid(), userId: oid(), amountPaise: 53_696 };
    h.fake.createOrder.mockClear();
    const a = await request(h.app).post('/internal/payment-intents').set('authorization', `Bearer ${token}`).send(body);
    const b = await request(h.app).post('/internal/payment-intents').set('authorization', `Bearer ${token}`).send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(a.body).toMatchObject({
      provider: 'razorpay',
      keyId: 'rzp_test_key',
      amountPaise: 53_696,
      currency: 'INR',
      status: 'CREATED',
      demoPayUrl: null,
    });
    expect(a.body.providerOrderId).toMatch(/^order_test_/);
    expect(h.fake.createOrder).toHaveBeenCalledTimes(1);
    const call = h.fake.createOrder.mock.calls[0]![0];
    expect(call).toMatchObject({ amountPaise: 53_696, currency: 'INR' });
    expect(call.receipt.length).toBeLessThanOrEqual(40);
    expect(call.notes).toMatchObject({ paymentIntentId: a.body.paymentIntentId, purpose: 'CHECKOUT', referenceId: body.referenceId });
  });

  it('concurrent creates for the same reference produce one intent and one provider order', async () => {
    const token = await internalToken('marketplace');
    const body = { purpose: 'MEMBERSHIP', referenceId: oid(), userId: oid(), amountPaise: 9_900 };
    h.fake.createOrder.mockClear();
    const results = await Promise.all(
      [1, 2, 3].map(() => request(h.app).post('/internal/payment-intents').set('authorization', `Bearer ${token}`).send(body)),
    );
    const ids = new Set(results.map((r) => r.body.paymentIntentId));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(h.fake.createOrder).toHaveBeenCalledTimes(1);
  });

  it('same reference with a different amount → 409 CONFLICT', async () => {
    const token = await internalToken('orders');
    const body = { purpose: 'CHECKOUT', referenceId: oid(), userId: oid(), amountPaise: 1000 };
    await request(h.app).post('/internal/payment-intents').set('authorization', `Bearer ${token}`).send(body);
    const res = await request(h.app)
      .post('/internal/payment-intents')
      .set('authorization', `Bearer ${token}`)
      .send({ ...body, amountPaise: 2000 });
    expect(res.status).toBe(409);
  });

  it('provider failure → 502 PAYMENT_PROVIDER_UNAVAILABLE; a retry with the same reference succeeds', async () => {
    const token = await internalToken('orders');
    const body = { purpose: 'CHECKOUT', referenceId: oid(), userId: oid(), amountPaise: 1500 };
    const { PaymentProviderError } = await import('../src/providers/payment-provider.js');
    h.fake.createOrder.mockRejectedValueOnce(new PaymentProviderError('timeout', { retryable: true }));
    const fail = await request(h.app).post('/internal/payment-intents').set('authorization', `Bearer ${token}`).send(body);
    expect(fail.status).toBe(502);
    expect(fail.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    const ok = await request(h.app).post('/internal/payment-intents').set('authorization', `Bearer ${token}`).send(body);
    expect([200, 201]).toContain(ok.status);
    expect(ok.body.providerOrderId).toMatch(/^order_test_/);
  });

  it('rejects disallowed callers and invalid bodies', async () => {
    const identity = await internalToken('identity');
    const forbidden = await request(h.app)
      .post('/internal/payment-intents')
      .set('authorization', `Bearer ${identity}`)
      .send({ purpose: 'CHECKOUT', referenceId: oid(), userId: oid(), amountPaise: 100 });
    expect(forbidden.status).toBe(403);
    const token = await internalToken('orders');
    const bad = await request(h.app)
      .post('/internal/payment-intents')
      .set('authorization', `Bearer ${token}`)
      .send({ purpose: 'CHECKOUT', referenceId: oid(), userId: oid(), amountPaise: 10.5 });
    expect(bad.status).toBe(400);
    const noAuth = await request(h.app).post('/internal/payment-intents').send({});
    expect(noAuth.status).toBe(401);
  });

  it('GET /internal/payment-intents/by-reference/:purpose/:refId → same shape or 404', async () => {
    const token = await internalToken('orders');
    const body = { purpose: 'CHECKOUT', referenceId: oid(), userId: oid(), amountPaise: 777 };
    const created = await request(h.app).post('/internal/payment-intents').set('authorization', `Bearer ${token}`).send(body);
    const got = await request(h.app)
      .get(`/internal/payment-intents/by-reference/CHECKOUT/${body.referenceId}`)
      .set('authorization', `Bearer ${token}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(created.body);
    const missing = await request(h.app).get(`/internal/payment-intents/by-reference/CHECKOUT/${oid()}`).set('authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });

  it('GET /api/v1/payments/checkout/:checkoutId returns status to the owner only', async () => {
    const token = await internalToken('orders');
    const userId = oid();
    const body = { purpose: 'CHECKOUT', referenceId: oid(), userId, amountPaise: 4242 };
    await request(h.app).post('/internal/payment-intents').set('authorization', `Bearer ${token}`).send(body);
    const owner = await h.keys.sign({ sub: userId, roles: ['CONSUMER'] });
    const other = await h.keys.sign({ sub: oid(), roles: ['CONSUMER'] });
    const ok = await request(h.app).get(`/api/v1/payments/checkout/${body.referenceId}`).set('authorization', `Bearer ${owner}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'CREATED', amountPaise: 4242, currency: 'INR' });
    const no = await request(h.app).get(`/api/v1/payments/checkout/${body.referenceId}`).set('authorization', `Bearer ${other}`);
    expect(no.status).toBe(404);
  });
});
