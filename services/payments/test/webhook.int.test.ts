/**
 * Review Focus #3: webhook signature over the exact raw bytes, dedupe, amount checks, out-of-order handling.
 */
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxModel } from '@thali/service-kit';
import { createIntent } from '../src/domain/intents.js';
import { hmacHex, oid, paymentWebhook, setup, WEBHOOK_SECRET, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await setup('webhook');
});
afterAll(async () => {
  await h.cleanup();
});

const evtId = () => `evt_${randomBytes(6).toString('hex')}`;

function postRaw(raw: string, opts: { sig?: string; eventId?: string; headers?: Record<string, string> } = {}) {
  let req = request(h.app)
    .post('/api/v1/webhooks/razorpay')
    .set('content-type', 'application/json')
    .set('x-razorpay-signature', opts.sig ?? hmacHex(WEBHOOK_SECRET, raw))
    .set('x-razorpay-event-id', opts.eventId ?? evtId());
  for (const [k, v] of Object.entries(opts.headers ?? {})) req = req.set(k, v);
  return req.send(raw);
}

async function newIntent(amountPaise = 50_000) {
  const { intent } = await createIntent(h.ctx, { purpose: 'CHECKOUT', referenceId: oid(), userId: oid(), amountPaise });
  return intent;
}

async function outboxFor(type: string, intentId: string) {
  return outboxModel(h.ctx.conn)
    .find({ 'envelope.type': type, 'envelope.payload.paymentIntentId': intentId })
    .lean();
}

async function intentStatus(id: string) {
  const doc = await h.ctx.models.PaymentIntent.findById(id).lean();
  return doc!;
}

describe('POST /api/v1/webhooks/razorpay', () => {
  it('accepts a valid signature computed over a raw body with extra whitespace', async () => {
    const intent = await newIntent();
    const body = paymentWebhook('payment.captured', { orderId: intent.providerOrderId!, paymentId: 'pay_ws1', amount: 50_000 });
    const raw = `{\n   "entity" :  "event",   ${JSON.stringify(body, null, 4).slice(1)}`;
    const res = await postRaw(raw);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('APPLIED');
    const doc = await intentStatus(intent.id);
    expect(doc.status).toBe('CAPTURED');
    expect(doc.capturedPaise).toBe(50_000);
    expect(doc.providerPaymentId).toBe('pay_ws1');
  });

  it('rejects the same JSON re-serialized without whitespace but carrying the original signature (400)', async () => {
    const intent = await newIntent();
    const body = paymentWebhook('payment.captured', { orderId: intent.providerOrderId!, paymentId: 'pay_ws2', amount: 50_000 });
    const pretty = JSON.stringify(body, null, 2);
    const compact = JSON.stringify(JSON.parse(pretty));
    const res = await postRaw(compact, { sig: hmacHex(WEBHOOK_SECRET, pretty) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect((await intentStatus(intent.id)).status).toBe('CREATED');
  });

  it('rejects a missing signature and the mock header when provider is not mock', async () => {
    const intent = await newIntent();
    const raw = JSON.stringify(paymentWebhook('payment.captured', { orderId: intent.providerOrderId!, paymentId: 'pay_x', amount: 50_000 }));
    const noSig = await request(h.app).post('/api/v1/webhooks/razorpay').set('content-type', 'application/json').send(raw);
    expect(noSig.status).toBe(400);
    const mockHdr = await postRaw(raw, { headers: { 'x-thali-mock': '1' } });
    expect(mockHdr.status).toBe(400);
    expect((await intentStatus(intent.id)).status).toBe('CREATED');
  });

  it('duplicate event id → IGNORED_DUPLICATE and exactly one payment.captured outbox event', async () => {
    const intent = await newIntent();
    const raw = JSON.stringify(paymentWebhook('payment.captured', { orderId: intent.providerOrderId!, paymentId: 'pay_dup', amount: 50_000 }));
    const id = evtId();
    const first = await postRaw(raw, { eventId: id });
    const second = await postRaw(raw, { eventId: id });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.result).toBe('IGNORED_DUPLICATE');
    const events = await outboxFor('payment.captured', intent.id);
    expect(events).toHaveLength(1);
    const env = events[0]!.envelope as { payload: Record<string, unknown> };
    expect(env.payload).toMatchObject({
      paymentIntentId: intent.id,
      purpose: 'CHECKOUT',
      referenceId: intent.referenceId,
      userId: intent.userId,
      amountPaise: 50_000,
      providerPaymentId: 'pay_dup',
    });
    const stored = await h.ctx.models.PaymentEvent.findById(id).lean();
    expect(stored!.result).toBe('APPLIED');
  });

  it('a second delivery of a captured event with a different event id does not emit twice', async () => {
    const intent = await newIntent();
    const raw = JSON.stringify(paymentWebhook('payment.captured', { orderId: intent.providerOrderId!, paymentId: 'pay_dup2', amount: 50_000 }));
    await postRaw(raw);
    const again = await postRaw(raw);
    expect(again.body.result).toBe('IGNORED_STALE');
    expect(await outboxFor('payment.captured', intent.id)).toHaveLength(1);
  });

  it('payment.captured then late payment.authorized → IGNORED_STALE, status stays CAPTURED', async () => {
    const intent = await newIntent();
    const order = intent.providerOrderId!;
    await postRaw(JSON.stringify(paymentWebhook('payment.captured', { orderId: order, paymentId: 'pay_oo1', amount: 50_000 })));
    const late = await postRaw(JSON.stringify(paymentWebhook('payment.authorized', { orderId: order, paymentId: 'pay_oo1', amount: 50_000 })));
    expect(late.status).toBe(200);
    expect(late.body.result).toBe('IGNORED_STALE');
    expect((await intentStatus(intent.id)).status).toBe('CAPTURED');
  });

  it('payment.failed (attempt 1) then payment.captured (attempt 2) → final CAPTURED', async () => {
    const intent = await newIntent();
    const order = intent.providerOrderId!;
    const f = await postRaw(JSON.stringify(paymentWebhook('payment.failed', { orderId: order, paymentId: 'pay_a1', amount: 50_000 })));
    expect(f.body.result).toBe('APPLIED');
    expect((await intentStatus(intent.id)).status).toBe('FAILED');
    expect(await outboxFor('payment.failed', intent.id)).toHaveLength(1);
    const c = await postRaw(JSON.stringify(paymentWebhook('payment.captured', { orderId: order, paymentId: 'pay_a2', amount: 50_000 })));
    expect(c.body.result).toBe('APPLIED');
    const doc = await intentStatus(intent.id);
    expect(doc.status).toBe('CAPTURED');
    expect(doc.statusHistory.map((s) => s.to)).toEqual(['CREATED', 'FAILED', 'CAPTURED']);
    expect(await outboxFor('payment.captured', intent.id)).toHaveLength(1);
  });

  it('payment.failed arriving after CAPTURED is ignored (stale) and alerted', async () => {
    const intent = await newIntent();
    const order = intent.providerOrderId!;
    await postRaw(JSON.stringify(paymentWebhook('payment.captured', { orderId: order, paymentId: 'pay_b2', amount: 50_000 })));
    const f = await postRaw(JSON.stringify(paymentWebhook('payment.failed', { orderId: order, paymentId: 'pay_b1', amount: 50_000 })));
    expect(f.body.result).toBe('IGNORED_STALE');
    expect((await intentStatus(intent.id)).status).toBe('CAPTURED');
    expect(await outboxFor('payment.failed', intent.id)).toHaveLength(0);
  });

  it('amount mismatch → REJECTED_MISMATCH, no transition, no event, alert logged', async () => {
    const intent = await newIntent(50_000);
    const id = evtId();
    const res = await postRaw(
      JSON.stringify(paymentWebhook('payment.captured', { orderId: intent.providerOrderId!, paymentId: 'pay_mm', amount: 100 })),
      { eventId: id },
    );
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('REJECTED_MISMATCH');
    expect((await intentStatus(intent.id)).status).toBe('CREATED');
    expect(await outboxFor('payment.captured', intent.id)).toHaveLength(0);
    expect((await h.ctx.models.PaymentEvent.findById(id).lean())!.result).toBe('REJECTED_MISMATCH');
    expect(h.logs.some((l) => l.alert === 'PAYMENT_MISMATCH' && l.paymentIntentId === intent.id)).toBe(true);
  });

  it('currency mismatch and notes reference mismatch → REJECTED_MISMATCH', async () => {
    const intent = await newIntent(50_000);
    const usd = await postRaw(
      JSON.stringify(paymentWebhook('payment.captured', { orderId: intent.providerOrderId!, paymentId: 'pay_c', amount: 50_000, currency: 'USD' })),
    );
    expect(usd.body.result).toBe('REJECTED_MISMATCH');
    const notes = await postRaw(
      JSON.stringify(
        paymentWebhook('payment.captured', {
          orderId: intent.providerOrderId!,
          paymentId: 'pay_n',
          amount: 50_000,
          notes: { paymentIntentId: oid() },
        }),
      ),
    );
    expect(notes.body.result).toBe('REJECTED_MISMATCH');
    expect((await intentStatus(intent.id)).status).toBe('CREATED');
  });

  it('unknown provider order id → stored + 200 (no crash)', async () => {
    const id = evtId();
    const res = await postRaw(JSON.stringify(paymentWebhook('payment.captured', { orderId: 'order_unknown', paymentId: 'pay_u', amount: 1 })), {
      eventId: id,
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('IGNORED_UNKNOWN');
    const stored = await h.ctx.models.PaymentEvent.findById(id).lean();
    expect(stored).toBeTruthy();
    expect(stored!.providerOrderId).toBe('order_unknown');
  });

  it('correctly signed but malformed JSON → stored as IGNORED_UNKNOWN (id = sha256 of body) and 200', async () => {
    const raw = '{"event": "payment.captured", "payload": {';
    const res = await postRaw(raw);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('IGNORED_UNKNOWN');
    const id = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    expect(res.body.eventId).toBe(id);
    const stored = await h.ctx.models.PaymentEvent.findById(id).lean();
    expect(stored).toMatchObject({ result: 'IGNORED_UNKNOWN', type: 'malformed', resultDetail: 'malformed JSON' });
    // malformed + bad signature is still a 400
    expect((await postRaw(raw, { sig: hmacHex('nope', raw) })).status).toBe(400);
  });

  it('unsupported event types are stored and acknowledged', async () => {
    const raw = JSON.stringify({ entity: 'event', event: 'payment.dispute.created', payload: {}, created_at: 1 });
    const res = await postRaw(raw);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('IGNORED_UNKNOWN');
  });

  it('without an event id header, the sha256 of the body dedupes', async () => {
    const intent = await newIntent();
    const raw = JSON.stringify(paymentWebhook('payment.authorized', { orderId: intent.providerOrderId!, paymentId: 'pay_h', amount: 50_000 }));
    const send = () =>
      request(h.app)
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', hmacHex(WEBHOOK_SECRET, raw))
        .send(raw);
    expect((await send()).body.result).toBe('APPLIED');
    expect((await send()).body.result).toBe('IGNORED_DUPLICATE');
    expect((await intentStatus(intent.id)).status).toBe('AUTHORIZED');
  });
});
