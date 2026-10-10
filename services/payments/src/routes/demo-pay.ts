/**
 * 🔓 demo pay (only mounted when PAYMENT_PROVIDER=mock; production refuses mock at startup, ADR-011).
 * Completing builds Razorpay-shaped webhook bodies, signs them with MOCK_WEBHOOK_SECRET and feeds them to
 * the same `ingestWebhook` handler the webhook route uses (verification, dedupe, out-of-order rules).
 */
import { randomBytes } from 'node:crypto';
import express, { type Router } from 'express';
import { DomainError } from '@thali/contracts';
import { validate } from '@thali/service-kit';
import type { PaymentsContext } from '../context.js';
import { ingestWebhook } from '../domain/webhook.js';
import type { MockProvider } from '../providers/mock-provider.js';
import { DemoPayCompleteBody, VerifyParams } from '../schemas.js';

function paymentEvent(event: 'payment.authorized' | 'payment.captured' | 'payment.failed', p: { id: string; orderId: string; amountPaise: number; reason?: string }) {
  const status = event.split('.')[1];
  const now = Math.floor(Date.now() / 1000);
  return {
    entity: 'event',
    account_id: 'acc_thali_demo',
    event,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: p.id,
          entity: 'payment',
          amount: p.amountPaise,
          currency: 'INR',
          status,
          order_id: p.orderId,
          method: 'upi',
          captured: status === 'captured',
          notes: [],
          error_description: p.reason ?? null,
          created_at: now,
        },
      },
    },
    created_at: now,
  };
}

export function demoPayRouter(ctx: PaymentsContext): Router {
  const r = express.Router();
  const isMock = () => ctx.provider.name === 'mock';
  const vId = validate({ params: VerifyParams });

  const load = async (id: string) => {
    if (!isMock()) throw new DomainError('NOT_FOUND', 'Not found');
    const intent = await ctx.models.PaymentIntent.findById(id);
    if (!intent || intent.provider !== 'mock' || !intent.providerOrderId) throw new DomainError('NOT_FOUND', 'Payment intent not found');
    return intent;
  };

  r.get('/api/v1/demo-pay/:intentId', vId, async (req, res) => {
    const intent = await load(vId.get(req).params.intentId);
    res.json({
      paymentIntentId: intent.id,
      purpose: intent.purpose,
      referenceId: intent.referenceId,
      amountPaise: intent.amountPaise,
      currency: 'INR',
      status: intent.status,
      providerOrderId: intent.providerOrderId,
      isDemo: true,
    });
  });

  const vComplete = validate({ params: VerifyParams, body: DemoPayCompleteBody });
  r.post('/api/v1/demo-pay/:intentId/complete', vComplete, async (req, res) => {
    const { params, body } = vComplete.get(req);
    const intent = await load(params.intentId);
    if (!['CREATED', 'AUTHORIZED', 'FAILED'].includes(intent.status)) {
      throw new DomainError('PAYMENT_INVALID_TRANSITION', `Payment is already ${intent.status}`, 409, { status: intent.status });
    }
    const mock = ctx.provider as MockProvider;
    const orderId = intent.providerOrderId!;
    const bodies =
      body.outcome === 'success'
        ? await (async () => {
            const p = await mock.recordPayment({ orderId, amountPaise: intent.amountPaise, status: 'captured' });
            return [paymentEvent('payment.authorized', { id: p.id, orderId, amountPaise: p.amountPaise }), paymentEvent('payment.captured', { id: p.id, orderId, amountPaise: p.amountPaise })];
          })()
        : await (async () => {
            const reason = 'Demo payment declined';
            const p = await mock.recordPayment({ orderId, amountPaise: intent.amountPaise, status: 'failed', errorDescription: reason });
            return [paymentEvent('payment.failed', { id: p.id, orderId, amountPaise: p.amountPaise, reason })];
          })();
    const webhooks = [];
    for (const b of bodies) {
      const raw = Buffer.from(JSON.stringify(b));
      const out = await ingestWebhook(ctx, {
        rawBody: raw,
        signature: mock.signWebhook(raw),
        eventId: `evt_mock_${randomBytes(8).toString('hex')}`,
        mockHeader: true,
      });
      webhooks.push(out);
    }
    const fresh = (await ctx.models.PaymentIntent.findById(intent._id))!;
    res.json({ paymentIntentId: fresh.id, status: fresh.status, simulated: true, webhooks });
  });
  return r;
}
