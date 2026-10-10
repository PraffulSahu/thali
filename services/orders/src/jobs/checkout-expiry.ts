/**
 * Sweeper (a) of LLD §8 — every 30 s, leader-locked: AWAITING_PAYMENT checkouts past `expiresAt`
 * are ALWAYS reconciled with payments before anything is released (HLD §4.1 "orders down when
 * captured" / "webhook missed"):
 *   - CAPTURED (amount == total)  → placed exactly like `payment.captured`
 *   - CAPTURED (amount differs)   → EXPIRED + `checkout.released` + `checkout.late_payment` (refund)
 *   - AUTHORIZED within AUTHORIZED_GRACE_SEC of expiry → left alone (payments auto-captures)
 *   - otherwise (CREATED / FAILED / no intent at all) → EXPIRED + `checkout.released`
 *   - payments unreachable → skipped; retried next tick (never expire without a reconcile)
 */
import { DomainError } from '@thali/contracts';
import { withTransaction } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { ReconcileResult } from '../clients/payments.js';
import type { CheckoutGroup } from '../models/checkout-group.js';
import { applyCapturedPayment } from '../domain/place.js';
import { releaseCheckout } from '../domain/release.js';
import type { JobModule } from './types.js';

const BATCH = 100;
const isNotFound = (e: unknown) => e instanceof DomainError && e.code === 'NOT_FOUND';
const CAPTURED_STATES = new Set(['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED']);

export type SweepOutcome = 'PLACED' | 'EXPIRED' | 'EXPIRED_LATE_PAYMENT' | 'WAITING_CAPTURE' | 'SKIPPED' | 'NOOP';

async function reconcileFor(ctx: OrdersContext, g: Pick<CheckoutGroup, '_id' | 'paymentIntentId'>): Promise<ReconcileResult | null> {
  if (g.paymentIntentId) {
    try {
      return await ctx.clients.payments.reconcile(g.paymentIntentId);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  const intent = await ctx.clients.payments.getByReference('CHECKOUT', String(g._id));
  if (!intent) return null;
  return ctx.clients.payments.reconcile(intent.paymentIntentId);
}

export async function sweepCheckout(ctx: OrdersContext, g: Pick<CheckoutGroup, '_id' | 'paymentIntentId' | 'expiresAt' | 'pricing'>): Promise<SweepOutcome> {
  let rec: ReconcileResult | null;
  try {
    rec = await reconcileFor(ctx, g);
  } catch (err) {
    ctx.logger.warn({ err, checkoutId: String(g._id) }, 'reconcile failed; checkout left AWAITING_PAYMENT for the next sweep');
    return 'SKIPPED';
  }

  if (rec && CAPTURED_STATES.has(rec.status)) {
    const capturedPaise = rec.capturedPaise;
    const intentId = rec.paymentIntentId;
    return withTransaction(ctx.conn, async (session) => {
      if (capturedPaise === g.pricing.totalPaise) {
        const outcome = await applyCapturedPayment(ctx, session, { checkoutId: String(g._id), paymentIntentId: intentId, amountPaise: capturedPaise, source: 'reconcile' });
        return outcome === 'PLACED' ? 'PLACED' : 'NOOP';
      }
      const group = await ctx.models.CheckoutGroup.findById(g._id).session(session);
      if (!group || group.status !== 'AWAITING_PAYMENT') return 'NOOP';
      await releaseCheckout(ctx, session, group, 'EXPIRED', { detail: 'captured amount mismatch', paymentStatus: rec!.status });
      await applyCapturedPayment(ctx, session, { checkoutId: String(g._id), paymentIntentId: intentId, amountPaise: capturedPaise, source: 'reconcile' });
      return 'EXPIRED_LATE_PAYMENT';
    });
  }

  if (rec?.status === 'AUTHORIZED' && Date.now() < g.expiresAt.getTime() + ctx.config.AUTHORIZED_GRACE_SEC * 1000) {
    return 'WAITING_CAPTURE';
  }

  return withTransaction(ctx.conn, async (session) => {
    const group = await ctx.models.CheckoutGroup.findById(g._id).session(session);
    if (!group) return 'NOOP';
    const released = await releaseCheckout(ctx, session, group, 'EXPIRED', {
      detail: rec ? `payment ${rec.status.toLowerCase()} at expiry` : 'no payment at expiry',
      paymentStatus: rec?.status ?? group.paymentStatus,
    });
    return released ? 'EXPIRED' : 'NOOP';
  });
}

/** One sweep pass (exported for tests and manual runs). */
export async function runCheckoutExpiry(ctx: OrdersContext, opts: { signal?: AbortSignal } = {}): Promise<Record<SweepOutcome, number>> {
  const counts: Record<SweepOutcome, number> = { PLACED: 0, EXPIRED: 0, EXPIRED_LATE_PAYMENT: 0, WAITING_CAPTURE: 0, SKIPPED: 0, NOOP: 0 };
  const due = await ctx.models.CheckoutGroup.find({ status: 'AWAITING_PAYMENT', expiresAt: { $lt: new Date() } })
    .sort({ expiresAt: 1 })
    .limit(BATCH)
    .select({ _id: 1, paymentIntentId: 1, expiresAt: 1, pricing: 1 })
    .lean<Pick<CheckoutGroup, '_id' | 'paymentIntentId' | 'expiresAt' | 'pricing'>[]>();
  for (const g of due) {
    if (opts.signal?.aborted) break;
    try {
      counts[await sweepCheckout(ctx, g)]++;
    } catch (err) {
      counts.SKIPPED++;
      ctx.logger.error({ err, checkoutId: String(g._id) }, 'checkout expiry sweep failed');
    }
  }
  if (due.length) ctx.logger.info({ counts }, 'checkout expiry sweep');
  return counts;
}

export const checkoutExpiryJob: JobModule = {
  name: 'orders:checkout-expiry',
  intervalMs: (config) => config.CHECKOUT_EXPIRY_INTERVAL_MS,
  run: async (ctx, { signal }) => {
    await runCheckoutExpiry(ctx, { signal });
  },
};
