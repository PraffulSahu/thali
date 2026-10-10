import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { outboxModel, startConsumer, streamKey, withTransaction } from '@thali/service-kit';
import { waitFor } from '@thali/service-kit/testing';
import { createIntent } from '../src/domain/intents.js';
import { reconcileIntent } from '../src/domain/reconcile.js';
import { processDueRefunds, reconcileProcessingRefunds } from '../src/domain/refunds.js';
import { createEventHandlers } from '../src/events/handlers.js';
import { PaymentProviderError } from '../src/providers/payment-provider.js';
import { adminToken, envelope, hmacHex, oid, refundWebhook, setup, WEBHOOK_SECRET, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('refunds');
});
afterAll(async () => {
  await h.cleanup();
});
// Drain refunds left by earlier tests so per-test provider stubs only see this test's refund.
beforeEach(async () => {
  await processDueRefunds(h.ctx);
});

async function capturedIntent(amountPaise = 20_000) {
  const checkoutId = oid();
  const { intent } = await createIntent(h.ctx, { purpose: 'CHECKOUT', referenceId: checkoutId, userId: oid(), amountPaise });
  const pay = h.fake.addPayment(intent.providerOrderId!, { status: 'captured', amountPaise });
  const r = await reconcileIntent(h.ctx, intent.id);
  expect(r.status).toBe('CAPTURED');
  return { intent, checkoutId, paymentId: pay.id };
}

async function runHandler<T extends Parameters<typeof envelope>[0]>(env: ReturnType<typeof envelope<T>>) {
  const handlers = createEventHandlers(h.ctx) as Record<string, (e: unknown, s: unknown) => Promise<void>>;
  await withTransaction(h.ctx.conn, (s) => handlers[env.type]!(env, s));
}

const refundsFor = (childOrderId: string) => h.ctx.models.Refund.find({ childOrderId }).lean();
const intentDoc = async (id: string) => (await h.ctx.models.PaymentIntent.findById(id).lean())!;
const outboxCount = (type: string, refundId: string) =>
  outboxModel(h.ctx.conn).countDocuments({ 'envelope.type': type, 'envelope.payload.refundId': refundId });

function postWebhook(body: unknown) {
  const raw = JSON.stringify(body);
  return request(h.app)
    .post('/api/v1/webhooks/razorpay')
    .set('content-type', 'application/json')
    .set('x-razorpay-signature', hmacHex(WEBHOOK_SECRET, raw))
    .set('x-razorpay-event-id', `evt_${randomBytes(6).toString('hex')}`)
    .send(raw);
}

describe('refunds from order events', () => {
  it('order.rejected refundPaise 5000 → REQUESTED → PROCESSING; provider called once even if the event is delivered twice', async () => {
    const { intent, checkoutId, paymentId } = await capturedIntent();
    const childOrderId = oid();
    const env = envelope('order.rejected', {
      childOrderId,
      checkoutId,
      userId: intent.userId,
      restaurantId: oid(),
      reason: 'Out of ingredients',
      refundPaise: 5000,
    });
    // real consumer: same envelope delivered twice on the stream
    const stream = streamKey(h.config.EVENT_STREAM_PREFIX, 'events.orders');
    await h.ctx.redis.xadd(stream, '*', 'data', JSON.stringify(env));
    await h.ctx.redis.xadd(stream, '*', 'data', JSON.stringify(env));
    const consumer = startConsumer({
      conn: h.ctx.conn,
      redis: h.ctx.redis,
      logger: h.ctx.logger,
      service: 'payments',
      streams: ['events.orders'],
      streamPrefix: h.config.EVENT_STREAM_PREFIX,
      handlers: createEventHandlers(h.ctx),
      backoffBaseMs: 20,
    });
    await waitFor(async () => (await refundsFor(childOrderId)).length === 1);
    await consumer.stop();
    // a re-published copy with a NEW event id (same child + reason) is also absorbed
    await runHandler(envelope('order.rejected', { ...env.payload }));
    const [refund] = await refundsFor(childOrderId);
    expect(await refundsFor(childOrderId)).toHaveLength(1);
    expect(refund).toMatchObject({
      status: 'REQUESTED',
      amountPaise: 5000,
      reason: 'RESTAURANT_REJECTED',
      idempotencyKey: `refund:${childOrderId}:RESTAURANT_REJECTED`,
      checkoutGroupId: checkoutId,
    });
    expect(await outboxCount('refund.requested', String(refund!._id))).toBe(1);

    h.fake.refund.mockClear();
    await processDueRefunds(h.ctx);
    await processDueRefunds(h.ctx);
    expect(h.fake.refund).toHaveBeenCalledTimes(1);
    const call = h.fake.refund.mock.calls[0]![0];
    expect(call).toMatchObject({ paymentId, amountPaise: 5000 });
    expect(call.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{10,}$/);
    expect(call.notes).toMatchObject({ refundId: String(refund!._id) });
    const after = (await refundsFor(childOrderId))[0]!;
    expect(after.status).toBe('PROCESSING');
    expect(after.providerRefundId).toMatch(/^rfnd_/);
    expect(await outboxCount('refund.processing', String(refund!._id))).toBe(1);
    expect((await intentDoc(intent.id)).status).toBe('CAPTURED'); // not refunded until provider confirms
  });

  it('a refund inherits isDemo from its payment intent', async () => {
    const { intent, checkoutId } = await capturedIntent();
    await h.ctx.models.PaymentIntent.updateOne({ _id: intent._id }, { $set: { isDemo: true } });
    const childOrderId = oid();
    await runHandler(envelope('order.rejected', { childOrderId, checkoutId, userId: intent.userId, restaurantId: oid(), reason: 'x', refundPaise: 100 }));
    const [refund] = await refundsFor(childOrderId);
    expect(refund).toMatchObject({ isDemo: true, amountPaise: 100 });
  });

  it('RESTAURANT_TIMEOUT rejection and customer cancellation map to their refund reasons; zero refunds are skipped', async () => {
    const { intent, checkoutId } = await capturedIntent();
    const c1 = oid();
    const c2 = oid();
    const c3 = oid();
    await runHandler(
      envelope('order.rejected', { childOrderId: c1, checkoutId, userId: intent.userId, restaurantId: oid(), reason: 'RESTAURANT_TIMEOUT', refundPaise: 1000 }),
    );
    await runHandler(
      envelope('order.cancelled', {
        childOrderId: c2,
        checkoutId,
        userId: intent.userId,
        restaurantId: oid(),
        actor: 'CUSTOMER',
        reason: 'changed mind',
        refundPaise: 2000,
      }),
    );
    await runHandler(
      envelope('order.cancelled', { childOrderId: c3, checkoutId, userId: intent.userId, restaurantId: oid(), actor: 'ADMIN', reason: 'x', refundPaise: 0 }),
    );
    expect((await refundsFor(c1))[0]!.reason).toBe('RESTAURANT_TIMEOUT');
    expect((await refundsFor(c2))[0]!.reason).toBe('CUSTOMER_CANCELLED');
    expect(await refundsFor(c3)).toHaveLength(0);
  });

  it('checkout.late_payment → full LATE_PAYMENT refund of the captured amount', async () => {
    const { intent, checkoutId } = await capturedIntent(31_000);
    await runHandler(envelope('checkout.late_payment', { checkoutId, paymentIntentId: intent.id, amountPaise: 31_000 }));
    const refunds = await h.ctx.models.Refund.find({ paymentIntentId: intent.id }).lean();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ reason: 'LATE_PAYMENT', amountPaise: 31_000, idempotencyKey: `refund:${checkoutId}:LATE_PAYMENT` });
  });

  it('event-driven refund beyond the captured amount is recorded FAILED (not sent to the provider)', async () => {
    const { intent, checkoutId } = await capturedIntent(3000);
    const childOrderId = oid();
    await runHandler(
      envelope('order.rejected', { childOrderId, checkoutId, userId: intent.userId, restaurantId: oid(), reason: 'x', refundPaise: 5000 }),
    );
    const [r] = await refundsFor(childOrderId);
    expect(r!.status).toBe('FAILED');
    expect(r!.lastError).toMatch(/REFUND_EXCEEDS_CAPTURED/);
    h.fake.refund.mockClear();
    await processDueRefunds(h.ctx);
    expect(h.fake.refund).not.toHaveBeenCalled();
  });
});

describe('refund lifecycle', () => {
  it('provider 503 → FAILED with backoff (same provider key) → retried after backoff → SUCCEEDED', async () => {
    const { intent, checkoutId } = await capturedIntent(10_000);
    const childOrderId = oid();
    await runHandler(
      envelope('order.cancelled', { childOrderId, checkoutId, userId: intent.userId, restaurantId: oid(), actor: 'CUSTOMER', reason: 'x', refundPaise: 4000 }),
    );
    h.fake.refund.mockClear();
    h.fake.refund.mockImplementationOnce(async () => {
      throw new PaymentProviderError('HTTP 503', { retryable: true, status: 503 });
    });
    await processDueRefunds(h.ctx);
    let r = (await refundsFor(childOrderId))[0]!;
    expect(r.status).toBe('FAILED');
    expect(r.attempts).toBe(1);
    expect(r.nextAttemptAt!.getTime()).toBe(h.clock.now.getTime() + 60_000);
    expect(r.lastError).toMatch(/503/);
    expect(r.reserved).toBe(true); // uncertain failure keeps the reservation
    expect((await intentDoc(intent.id)).refundReservedPaise).toBe(4000);
    // not yet due
    await processDueRefunds(h.ctx);
    expect(h.fake.refund).toHaveBeenCalledTimes(1);
    h.clock.advance(61_000);
    h.fake.refund.mockImplementationOnce(async () => ({ providerRefundId: 'rfnd_ok1', status: 'processed' as const }));
    await processDueRefunds(h.ctx);
    expect(h.fake.refund).toHaveBeenCalledTimes(2);
    // uncertain failure (503) → retry reuses the same provider idempotency key
    expect(h.fake.refund.mock.calls[1]![0].idempotencyKey).toBe(h.fake.refund.mock.calls[0]![0].idempotencyKey);
    r = (await refundsFor(childOrderId))[0]!;
    expect(r.status).toBe('SUCCEEDED');
    expect(r.statusHistory.map((s) => s.to)).toEqual(['REQUESTED', 'PROCESSING', 'FAILED', 'PROCESSING', 'SUCCEEDED']);
    const doc = await intentDoc(intent.id);
    expect(doc.refundedPaise).toBe(4000);
    expect(doc.status).toBe('PARTIALLY_REFUNDED');
    expect(await outboxCount('refund.succeeded', String(r._id))).toBe(1);
  });

  it('a definitive provider rejection (4xx) ends FAILED, releases the reservation, is not auto-retried; a replacement refund is then possible and an admin retry of the original → 422', async () => {
    const { intent, checkoutId } = await capturedIntent(10_000);
    const childOrderId = oid();
    await runHandler(
      envelope('order.cancelled', { childOrderId, checkoutId, userId: intent.userId, restaurantId: oid(), actor: 'CUSTOMER', reason: 'x', refundPaise: 10_000 }),
    );
    expect((await intentDoc(intent.id)).refundReservedPaise).toBe(10_000);
    h.fake.refund.mockClear();
    h.fake.refund.mockImplementationOnce(async () => {
      throw new PaymentProviderError('HTTP 400 BAD_REQUEST_ERROR', { retryable: false, status: 400 });
    });
    await processDueRefunds(h.ctx);
    const r = (await refundsFor(childOrderId))[0]!;
    expect(r).toMatchObject({ status: 'FAILED', reserved: false, nextAttemptAt: null, providerKeySeq: 1 });
    expect((await intentDoc(intent.id)).refundReservedPaise).toBe(0);
    expect(await outboxCount('refund.failed', String(r._id))).toBe(1);
    h.clock.advance(24 * 3_600_000);
    await processDueRefunds(h.ctx);
    expect(h.fake.refund).toHaveBeenCalledTimes(1); // never auto-retried

    const token = await adminToken(h.keys);
    const replacement = await request(h.app)
      .post('/api/v1/admin/finance/refunds')
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', `idem-${randomBytes(6).toString('hex')}`)
      .send({ paymentIntentId: intent.id, childOrderId, amountPaise: 10_000, note: 'replacement' });
    expect(replacement.status).toBe(201);
    const retry = await request(h.app).post(`/api/v1/admin/finance/refunds/${String(r._id)}/retry`).set('authorization', `Bearer ${token}`);
    expect(retry.status).toBe(422);
    expect(retry.body.error.code).toBe('REFUND_EXCEEDS_CAPTURED');
    expect((await refundsFor(childOrderId)).find((x) => String(x._id) === String(r._id))!.status).toBe('FAILED');
    expect((await intentDoc(intent.id)).refundReservedPaise).toBe(10_000);
  });

  it('admin retry after a definitive rejection re-reserves atomically and uses a fresh provider key', async () => {
    const { intent, checkoutId } = await capturedIntent(10_000);
    const childOrderId = oid();
    await runHandler(
      envelope('order.cancelled', { childOrderId, checkoutId, userId: intent.userId, restaurantId: oid(), actor: 'CUSTOMER', reason: 'x', refundPaise: 3_000 }),
    );
    h.fake.refund.mockClear();
    h.fake.refund.mockImplementationOnce(async () => {
      throw new PaymentProviderError('HTTP 400 BAD_REQUEST_ERROR', { retryable: false, status: 400 });
    });
    await processDueRefunds(h.ctx);
    const r = (await refundsFor(childOrderId))[0]!;
    expect((await intentDoc(intent.id)).refundReservedPaise).toBe(0);
    const token = await adminToken(h.keys);
    const retry = await request(h.app).post(`/api/v1/admin/finance/refunds/${String(r._id)}/retry`).set('authorization', `Bearer ${token}`);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('PROCESSING');
    expect(h.fake.refund).toHaveBeenCalledTimes(2);
    expect(h.fake.refund.mock.calls[1]![0].idempotencyKey).not.toBe(h.fake.refund.mock.calls[0]![0].idempotencyKey);
    expect((await intentDoc(intent.id)).refundReservedPaise).toBe(3_000);
  });

  it('refund.failed webhook (provider-reported) is definitive: reservation released', async () => {
    const { intent, checkoutId, paymentId } = await capturedIntent(6_000);
    const c = oid();
    await runHandler(envelope('order.rejected', { childOrderId: c, checkoutId, userId: intent.userId, restaurantId: oid(), reason: 'x', refundPaise: 6_000 }));
    await processDueRefunds(h.ctx);
    const r = (await refundsFor(c))[0]!;
    const res = await postWebhook(refundWebhook('refund.failed', { refundId: r.providerRefundId!, paymentId, amount: 6_000 }));
    expect(res.body.result).toBe('APPLIED');
    expect((await refundsFor(c))[0]).toMatchObject({ status: 'FAILED', reserved: false });
    expect((await intentDoc(intent.id)).refundReservedPaise).toBe(0);
  });

  it('refund.processed webhook → SUCCEEDED + refund.succeeded; partial then full → PARTIALLY_REFUNDED then REFUNDED', async () => {
    const { intent, checkoutId, paymentId } = await capturedIntent(9000);
    const a = oid();
    const b = oid();
    await runHandler(envelope('order.rejected', { childOrderId: a, checkoutId, userId: intent.userId, restaurantId: oid(), reason: 'x', refundPaise: 4000 }));
    await runHandler(envelope('order.rejected', { childOrderId: b, checkoutId, userId: intent.userId, restaurantId: oid(), reason: 'x', refundPaise: 5000 }));
    await processDueRefunds(h.ctx);
    const ra = (await refundsFor(a))[0]!;
    const rb = (await refundsFor(b))[0]!;
    expect(ra.status).toBe('PROCESSING');

    const w1 = await postWebhook(refundWebhook('refund.processed', { refundId: ra.providerRefundId!, paymentId, amount: 4000 }));
    expect(w1.status).toBe(200);
    expect(w1.body.result).toBe('APPLIED');
    expect((await refundsFor(a))[0]!.status).toBe('SUCCEEDED');
    expect(await outboxCount('refund.succeeded', String(ra._id))).toBe(1);
    expect((await intentDoc(intent.id)).status).toBe('PARTIALLY_REFUNDED');

    // duplicate delivery of the same provider fact (new event id) is stale
    const dup = await postWebhook(refundWebhook('refund.processed', { refundId: ra.providerRefundId!, paymentId, amount: 4000 }));
    expect(dup.body.result).toBe('IGNORED_STALE');
    expect((await intentDoc(intent.id)).refundedPaise).toBe(4000);

    // amount mismatch on refund webhook is rejected
    const mm = await postWebhook(refundWebhook('refund.processed', { refundId: rb.providerRefundId!, paymentId, amount: 1 }));
    expect(mm.body.result).toBe('REJECTED_MISMATCH');

    await postWebhook(refundWebhook('refund.processed', { refundId: rb.providerRefundId!, paymentId, amount: 5000 }));
    const doc = await intentDoc(intent.id);
    expect(doc.status).toBe('REFUNDED');
    expect(doc.refundedPaise).toBe(9000);
  });

  it('refund.processed arriving before the provider refund id is stored is matched via notes.refundId', async () => {
    const { intent, checkoutId, paymentId } = await capturedIntent(5000);
    const c = oid();
    await runHandler(envelope('order.rejected', { childOrderId: c, checkoutId, userId: intent.userId, restaurantId: oid(), reason: 'x', refundPaise: 5000 }));
    const r = (await refundsFor(c))[0]!;
    const res = await postWebhook(refundWebhook('refund.processed', { refundId: 'rfnd_early', paymentId, amount: 5000, notes: { refundId: String(r._id) } }));
    expect(res.body.result).toBe('APPLIED');
    const after = (await refundsFor(c))[0]!;
    expect(after.status).toBe('SUCCEEDED');
    expect(after.providerRefundId).toBe('rfnd_early');
    // the worker must not call the provider for an already-succeeded refund
    h.fake.refund.mockClear();
    await processDueRefunds(h.ctx);
    expect(h.fake.refund).not.toHaveBeenCalled();
  });

  it('PROCESSING > 10 min is polled via fetchRefund (processed → SUCCEEDED)', async () => {
    const { intent, checkoutId } = await capturedIntent(5000);
    const c = oid();
    await runHandler(envelope('order.rejected', { childOrderId: c, checkoutId, userId: intent.userId, restaurantId: oid(), reason: 'x', refundPaise: 2500 }));
    await processDueRefunds(h.ctx);
    const r = (await refundsFor(c))[0]!;
    h.fake.fetchRefund.mockClear();
    await reconcileProcessingRefunds(h.ctx);
    expect(h.fake.fetchRefund).not.toHaveBeenCalledWith(r.providerRefundId);
    h.fake.refunds.get(r.providerRefundId!)!.status = 'processed';
    h.clock.advance(11 * 60_000);
    await reconcileProcessingRefunds(h.ctx);
    expect(h.fake.fetchRefund).toHaveBeenCalledWith(r.providerRefundId);
    expect((await refundsFor(c))[0]!.status).toBe('SUCCEEDED');
  });

  it('after 5 failed attempts the refund stays FAILED (refund.failed emitted) until an admin retries it', async () => {
    const { intent, checkoutId } = await capturedIntent(5000);
    const c = oid();
    await runHandler(envelope('order.rejected', { childOrderId: c, checkoutId, userId: intent.userId, restaurantId: oid(), reason: 'x', refundPaise: 1000 }));
    h.fake.refund.mockClear();
    h.fake.refund.mockImplementation(async () => {
      throw new PaymentProviderError('timeout', { retryable: true });
    });
    for (let i = 0; i < 7; i++) {
      await processDueRefunds(h.ctx);
      h.clock.advance(60 * 60_000);
    }
    expect(h.fake.refund).toHaveBeenCalledTimes(5);
    const r = (await refundsFor(c))[0]!;
    expect(r.status).toBe('FAILED');
    expect(r.attempts).toBe(5);
    expect(r.nextAttemptAt).toBeNull();
    expect(await outboxCount('refund.failed', String(r._id))).toBe(1);

    h.fake.refund.mockReset();
    h.fake.refund.mockImplementation(async () => ({ providerRefundId: 'rfnd_manual', status: 'pending' as const }));
    const token = await adminToken(h.keys);
    const list = await request(h.app).get('/api/v1/admin/finance/refunds?status=FAILED').set('authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((x: { id: string }) => x.id === String(r._id))).toBe(true);
    const retry = await request(h.app).post(`/api/v1/admin/finance/refunds/${String(r._id)}/retry`).set('authorization', `Bearer ${token}`);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('PROCESSING');
    expect(h.fake.refund).toHaveBeenCalledTimes(1);
    const audit = await outboxModel(h.ctx.conn).countDocuments({ 'envelope.type': 'audit.recorded', 'envelope.payload.targetId': String(r._id) });
    expect(audit).toBe(1);
    h.fake.refund.mockImplementation((i) => h.fake.refundImpl(i));
  });
});

describe('manual admin refunds', () => {
  it('total refunds cannot exceed captured: second manual refund beyond remaining → 422 REFUND_EXCEEDS_CAPTURED', async () => {
    const { intent } = await capturedIntent(10_000);
    const token = await adminToken(h.keys);
    const first = await request(h.app)
      .post('/api/v1/admin/finance/refunds')
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', `idem-${randomBytes(6).toString('hex')}`)
      .send({ paymentIntentId: intent.id, amountPaise: 7000, note: 'goodwill' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'REQUESTED', amountPaise: 7000, reason: 'ADMIN' });
    const second = await request(h.app)
      .post('/api/v1/admin/finance/refunds')
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', `idem-${randomBytes(6).toString('hex')}`)
      .send({ paymentIntentId: intent.id, amountPaise: 3001, note: 'more' });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('REFUND_EXCEEDS_CAPTURED');
    const exact = await request(h.app)
      .post('/api/v1/admin/finance/refunds')
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', `idem-${randomBytes(6).toString('hex')}`)
      .send({ paymentIntentId: intent.id, amountPaise: 3000, note: 'rest' });
    expect(exact.status).toBe(201);
    expect((await intentDoc(intent.id)).refundReservedPaise).toBe(10_000);
  });

  it('concurrent manual refunds never over-reserve', async () => {
    const { intent } = await capturedIntent(10_000);
    const token = await adminToken(h.keys);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        request(h.app)
          .post('/api/v1/admin/finance/refunds')
          .set('authorization', `Bearer ${token}`)
          .set('idempotency-key', `idem-${randomBytes(6).toString('hex')}`)
          .send({ paymentIntentId: intent.id, amountPaise: 4000, note: 'race' }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 422)).toHaveLength(2);
    expect((await intentDoc(intent.id)).refundReservedPaise).toBe(8000);
  });

  it('requires Idempotency-Key, replays the same response, and requires FINANCE/SUPER_ADMIN + MFA', async () => {
    const { intent } = await capturedIntent(10_000);
    const token = await adminToken(h.keys);
    const body = { paymentIntentId: intent.id, amountPaise: 100, note: 'n' };
    const noKey = await request(h.app).post('/api/v1/admin/finance/refunds').set('authorization', `Bearer ${token}`).send(body);
    expect(noKey.status).toBe(400);
    const key = `idem-${randomBytes(6).toString('hex')}`;
    const a = await request(h.app).post('/api/v1/admin/finance/refunds').set('authorization', `Bearer ${token}`).set('idempotency-key', key).send(body);
    const b = await request(h.app).post('/api/v1/admin/finance/refunds').set('authorization', `Bearer ${token}`).set('idempotency-key', key).send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await h.ctx.models.Refund.countDocuments({ paymentIntentId: intent.id })).toBe(1);
    const ops = await adminToken(h.keys, { adm: ['OPS'] });
    expect((await request(h.app).post('/api/v1/admin/finance/refunds').set('authorization', `Bearer ${ops}`).set('idempotency-key', `k-${randomBytes(6).toString('hex')}`).send(body)).status).toBe(403);
    const noMfa = await adminToken(h.keys, { mfa: false });
    expect((await request(h.app).post('/api/v1/admin/finance/refunds').set('authorization', `Bearer ${noMfa}`).set('idempotency-key', `k-${randomBytes(6).toString('hex')}`).send(body)).status).toBe(403);
    const audit = await outboxModel(h.ctx.conn).countDocuments({ 'envelope.type': 'audit.recorded', 'envelope.payload.targetId': a.body.id });
    expect(audit).toBe(1);
  });
});
