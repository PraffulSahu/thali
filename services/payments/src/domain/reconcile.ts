/**
 * Reconciliation with the provider (missed/late webhooks, Razorpay auto-capture fallback). Never trusts
 * the client: only provider-reported payments move an intent, through the same `applyPaymentSignal`.
 */
import { DomainError } from '@thali/contracts';
import { withTransaction } from '@thali/service-kit';
import { isValidObjectId } from 'mongoose';
import type { PaymentsContext } from '../context.js';
import type { PaymentIntentDoc } from '../models/payment-intent.js';
import type { ProviderPayment } from '../providers/payment-provider.js';
import { applyPaymentSignal, type PaymentSignal } from './webhook.js';

export interface ReconcileResult {
  paymentIntentId: string;
  status: PaymentIntentDoc['status'];
  capturedPaise: number;
}

async function apply(ctx: PaymentsContext, intentId: string, signal: PaymentSignal) {
  await withTransaction(ctx.conn, async (session) => {
    const intent = await ctx.models.PaymentIntent.findById(intentId).session(session);
    if (!intent) return;
    await applyPaymentSignal(ctx, session, intent, signal, 'reconcile');
  });
}

const isCaptured = (p: ProviderPayment) => p.captured || p.status === 'captured' || p.status === 'refunded';

export async function reconcileIntent(ctx: PaymentsContext, intentId: string): Promise<ReconcileResult> {
  const { PaymentIntent } = ctx.models;
  if (!isValidObjectId(intentId)) throw new DomainError('NOT_FOUND', 'Payment intent not found');
  const intent = await PaymentIntent.findById(intentId);
  if (!intent) throw new DomainError('NOT_FOUND', 'Payment intent not found');
  if (intent.providerOrderId) {
    const payments = await ctx.provider.fetchOrderPayments(intent.providerOrderId);
    const captured = payments.filter(isCaptured);
    const pick = captured.find((p) => p.amountPaise === intent.amountPaise) ?? captured[0];
    const toSignal = (p: ProviderPayment, kind: PaymentSignal['kind']): PaymentSignal => ({
      kind,
      providerPaymentId: p.id,
      amountPaise: p.amountPaise,
      currency: p.currency,
    });
    if (pick) {
      await apply(ctx, intentId, toSignal(pick, 'CAPTURED'));
    } else {
      const authorized = payments.find((p) => p.status === 'authorized');
      if (authorized && ['CREATED', 'AUTHORIZED', 'FAILED'].includes(intent.status)) {
        const ageMs = ctx.now().getTime() - authorized.createdAt.getTime();
        if (authorized.amountPaise !== intent.amountPaise || authorized.currency !== 'INR') {
          await apply(ctx, intentId, toSignal(authorized, 'AUTHORIZED')); // logs PAYMENT_MISMATCH, no capture
        } else if (ageMs >= ctx.config.AUTHORIZED_CAPTURE_AFTER_SEC * 1000) {
          ctx.logger.info({ paymentIntentId: intentId, providerPaymentId: authorized.id }, 'capturing payment authorized beyond threshold');
          const res = await ctx.provider.capture(authorized.id, intent.amountPaise);
          if (isCaptured(res)) await apply(ctx, intentId, { ...toSignal(authorized, 'CAPTURED'), amountPaise: res.amountPaise || authorized.amountPaise });
        } else if (intent.status === 'CREATED') {
          await apply(ctx, intentId, toSignal(authorized, 'AUTHORIZED'));
        }
      }
    }
  }
  const updated = await PaymentIntent.findOneAndUpdate({ _id: intent._id }, { $set: { lastReconciledAt: ctx.now() } }, { new: true });
  return { paymentIntentId: intentId, status: updated!.status, capturedPaise: updated!.capturedPaise };
}

/** Job: AUTHORIZED beyond the capture threshold, and CREATED intents with no recent reconciliation (missed webhooks). */
export async function reconcileStaleIntents(ctx: PaymentsContext, signal?: AbortSignal): Promise<number> {
  const now = ctx.now().getTime();
  const authorizedCutoff = new Date(now - ctx.config.AUTHORIZED_CAPTURE_AFTER_SEC * 1000);
  const createdCutoff = new Date(now - 2 * 60_000);
  const createdFloor = new Date(now - 24 * 3_600_000);
  const recheck = new Date(now - 5 * 60_000);
  const candidates = await ctx.models.PaymentIntent.find(
    {
      $or: [
        { status: 'AUTHORIZED', statusChangedAt: { $lte: authorizedCutoff } },
        {
          status: 'CREATED',
          providerOrderId: { $type: 'string' },
          statusChangedAt: { $lte: createdCutoff, $gte: createdFloor },
          $and: [{ $or: [{ lastReconciledAt: null }, { lastReconciledAt: { $lte: recheck } }] }],
        },
      ],
    },
    { _id: 1 },
  )
    .limit(50)
    .lean();
  let n = 0;
  for (const c of candidates) {
    if (signal?.aborted) break;
    try {
      await reconcileIntent(ctx, String(c._id));
      n += 1;
    } catch (err) {
      ctx.logger.warn({ err, paymentIntentId: String(c._id) }, 'reconcile failed');
    }
  }
  return n;
}
