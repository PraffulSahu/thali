/** 👤 customer payment routes: status polling and client-side signature verification (reconcile only). */
import express, { type Router } from 'express';
import { DomainError } from '@thali/contracts';
import { rateLimit, requireAuth, validate } from '@thali/service-kit';
import type { PaymentsContext } from '../context.js';
import { paymentStatusView } from '../domain/intents.js';
import { reconcileIntent } from '../domain/reconcile.js';
import { PaymentProviderError } from '../providers/payment-provider.js';
import { CheckoutParams, VerifyBody, VerifyParams } from '../schemas.js';

export function paymentsRouter(ctx: PaymentsContext): Router {
  const r = express.Router();

  const vStatus = validate({ params: CheckoutParams });
  r.get('/api/v1/payments/checkout/:checkoutId', requireAuth(), vStatus, async (req, res) => {
    const { params } = vStatus.get(req);
    const intent = await ctx.models.PaymentIntent.findOne({ purpose: 'CHECKOUT', referenceId: params.checkoutId, userId: req.auth!.userId });
    if (!intent) throw new DomainError('NOT_FOUND', 'Payment not found');
    res.json(paymentStatusView(ctx, intent));
  });

  const vVerify = validate({ params: VerifyParams, body: VerifyBody });
  r.post(
    '/api/v1/payments/:intentId/verify',
    requireAuth(),
    rateLimit({ redis: ctx.redis, name: 'payment-verify', keyFn: (req) => req.auth?.userId ?? req.ip ?? null, points: 20, durationSec: 60 }),
    vVerify,
    async (req, res) => {
      const { params, body } = vVerify.get(req);
      const intent = await ctx.models.PaymentIntent.findOne({ _id: params.intentId, userId: req.auth!.userId });
      if (!intent) throw new DomainError('NOT_FOUND', 'Payment not found');
      const orderId = intent.providerOrderId;
      if (
        !orderId ||
        body.razorpay_order_id !== orderId ||
        !ctx.provider.verifyPaymentSignature(orderId, body.razorpay_payment_id, body.razorpay_signature)
      ) {
        req.log?.warn({ paymentIntentId: intent.id }, 'payment signature verification failed');
        throw new DomainError('VALIDATION_FAILED', 'Payment signature invalid', 400, { reason: 'SIGNATURE_INVALID' });
      }
      // Never marks paid by itself: only provider-confirmed payments move the intent.
      let reconciled = true;
      try {
        await reconcileIntent(ctx, intent.id as string);
      } catch (err) {
        if (!(err instanceof PaymentProviderError)) throw err;
        reconciled = false;
        req.log?.warn({ err, paymentIntentId: intent.id }, 'reconcile after verify failed; returning current status');
      }
      const fresh = (await ctx.models.PaymentIntent.findById(intent._id))!;
      res.json({ ...paymentStatusView(ctx, fresh), reconciled });
    },
  );
  return r;
}
