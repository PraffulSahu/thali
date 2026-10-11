/**
 * Payment intents: one per (purpose, referenceId), idempotent. The provider order is created outside any
 * transaction under a short claim lease so concurrent/duplicate requests create exactly one provider order.
 */
import { DomainError, type PaymentPurpose } from '@thali/contracts';
import type { PaymentsContext } from '../context.js';
import type { PaymentIntentDoc } from '../models/payment-intent.js';
import { PaymentProviderError } from '../providers/payment-provider.js';

export interface CreateIntentInput {
  purpose: PaymentPurpose;
  referenceId: string;
  userId: string;
  amountPaise: number;
}

export interface IntentView {
  paymentIntentId: string;
  provider: 'razorpay' | 'mock';
  providerOrderId: string;
  keyId: string | null;
  amountPaise: number;
  currency: 'INR';
  status: PaymentIntentDoc['status'];
  demoPayUrl: string | null;
}

export function isDuplicateKey(err: unknown, collection?: string): boolean {
  const e = err as { code?: number; message?: string } | null;
  return e?.code === 11000 && (!collection || String(e.message).includes(collection));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function demoPayUrl(ctx: PaymentsContext, intentId: string): string {
  const base = (ctx.config.PUBLIC_WEB_URL ?? '').replace(/\/+$/, '');
  return `${base}/demo-pay/${intentId}`;
}

/** Internal API response shape (binding: docs/03-LLD.md, payments POST /internal/payment-intents). */
export function intentView(ctx: PaymentsContext, intent: PaymentIntentDoc): IntentView {
  return {
    paymentIntentId: intent.id as string,
    provider: intent.provider,
    providerOrderId: intent.providerOrderId ?? '',
    keyId: intent.provider === ctx.provider.name ? ctx.provider.keyId : null,
    amountPaise: intent.amountPaise,
    currency: 'INR',
    status: intent.status,
    demoPayUrl: intent.provider === 'mock' ? demoPayUrl(ctx, intent.id as string) : null,
  };
}

export async function createIntent(ctx: PaymentsContext, input: CreateIntentInput): Promise<{ intent: PaymentIntentDoc; created: boolean }> {
  const { PaymentIntent } = ctx.models;
  let created = false;
  let intent = await PaymentIntent.findOne({ purpose: input.purpose, referenceId: input.referenceId });
  if (!intent) {
    const now = ctx.now();
    try {
      intent = await PaymentIntent.create({
        purpose: input.purpose,
        referenceId: input.referenceId,
        userId: input.userId,
        amountPaise: input.amountPaise,
        currency: 'INR',
        provider: ctx.provider.name,
        providerOrderId: null,
        status: 'CREATED',
        statusChangedAt: now,
        statusHistory: [{ from: null, to: 'CREATED', at: now, source: 'create' }],
        isDemo: ctx.provider.name === 'mock',
      });
      created = true;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      intent = await PaymentIntent.findOne({ purpose: input.purpose, referenceId: input.referenceId });
      if (!intent) throw err;
    }
  }
  if (intent.amountPaise !== input.amountPaise || intent.userId !== input.userId) {
    throw new DomainError('CONFLICT', 'A payment intent already exists for this reference with a different amount or user', 409, {
      paymentIntentId: intent.id,
    });
  }
  if (!intent.providerOrderId) intent = await ensureProviderOrder(ctx, intent);
  return { intent, created };
}

/**
 * Claim-lease protocol: only the request holding `orderCreateLockedUntil` calls the provider; others wait
 * for the order id. A crashed holder's lease expires and the next request retries (fresh receipt suffix).
 */
async function ensureProviderOrder(ctx: PaymentsContext, intent: PaymentIntentDoc): Promise<PaymentIntentDoc> {
  const { PaymentIntent } = ctx.models;
  const leaseMs = ctx.config.PAYMENT_PROVIDER_TIMEOUT_MS + 5_000;
  const started = Date.now();
  for (;;) {
    const now = new Date();
    const claimed = await PaymentIntent.findOneAndUpdate(
      { _id: intent._id, providerOrderId: null, $or: [{ orderCreateLockedUntil: null }, { orderCreateLockedUntil: { $lte: now } }] },
      { $set: { orderCreateLockedUntil: new Date(now.getTime() + leaseMs) }, $inc: { orderCreateAttempts: 1 } },
      { new: true },
    );
    if (claimed) {
      let providerOrderId: string;
      try {
        ({ providerOrderId } = await ctx.provider.createOrder({
          amountPaise: claimed.amountPaise,
          currency: 'INR',
          receipt: `${claimed.id as string}_${claimed.orderCreateAttempts}`,
          notes: { paymentIntentId: claimed.id as string, purpose: claimed.purpose, referenceId: claimed.referenceId },
        }));
      } catch (err) {
        await PaymentIntent.updateOne({ _id: claimed._id, providerOrderId: null }, { $set: { orderCreateLockedUntil: null } });
        ctx.logger.warn({ err, paymentIntentId: claimed.id }, 'payment provider createOrder failed');
        if (err instanceof PaymentProviderError) throw err;
        throw new PaymentProviderError('createOrder failed', { retryable: true, cause: err });
      }
      const updated = await PaymentIntent.findOneAndUpdate(
        { _id: claimed._id, providerOrderId: null },
        { $set: { providerOrderId, orderCreateLockedUntil: null } },
        { new: true },
      );
      return updated ?? (await PaymentIntent.findById(claimed._id))!;
    }
    const current = await PaymentIntent.findById(intent._id);
    if (current?.providerOrderId) return current;
    if (Date.now() - started > leaseMs) {
      throw new PaymentProviderError('provider order creation still in progress', { retryable: true });
    }
    await sleep(50);
  }
}

export async function findIntentByReference(ctx: PaymentsContext, purpose: PaymentPurpose, referenceId: string): Promise<PaymentIntentDoc | null> {
  return ctx.models.PaymentIntent.findOne({ purpose, referenceId });
}

/** Customer-facing status view. */
export function paymentStatusView(ctx: PaymentsContext, intent: PaymentIntentDoc) {
  return {
    ...intentView(ctx, intent),
    purpose: intent.purpose,
    referenceId: intent.referenceId,
    capturedPaise: intent.capturedPaise,
    refundedPaise: intent.refundedPaise,
    failureReason: intent.failureReason ?? null,
    isDemo: intent.isDemo,
  };
}
