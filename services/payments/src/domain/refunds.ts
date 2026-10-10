/**
 * Refunds (LLD §4.4). Money rules:
 *  - Creation reserves `amountPaise` on the intent (`refundReservedPaise ≤ capturedPaise`) in the same
 *    transaction as the refund insert; the natural `idempotencyKey` is unique.
 *  - Provider calls happen outside transactions, under a claim (status PROCESSING + lease), with a
 *    provider idempotency key (`X-Refund-Idempotency`) that stays the same across uncertain failures
 *    (timeout/5xx) and changes only after a definitive rejection.
 *  - "Refunded" (SUCCEEDED, intent.refundedPaise) only on provider confirmation: `processed` in the
 *    create response, `refund.processed` webhook, or a fetchRefund poll.
 * FAILED refunds keep their reservation (they are retried automatically or by an admin), so the
 * reserved total never under-counts money that may still leave.
 */
import {
  DomainError,
  assertTransition,
  formatINR,
  paymentTransitions,
  refundTransitions,
  type PaymentStatus,
  type RefundReason,
  type RefundStatus,
} from '@thali/contracts';
import { emitEvent, withTransaction } from '@thali/service-kit';
import { isValidObjectId, type ClientSession } from 'mongoose';
import type { PaymentsContext } from '../context.js';
import type { StatusHistoryEntry } from '../models/payment-intent.js';
import type { RefundDoc } from '../models/refund.js';
import { PaymentProviderError } from '../providers/payment-provider.js';
import { postEntry } from './ledger.js';

export interface RequestRefundInput {
  paymentIntentId?: string;
  checkoutGroupId: string;
  childOrderId?: string | null;
  restaurantId?: string | null;
  amountPaise: number;
  reason: RefundReason;
  idempotencyKey: string;
  requestedBy: string;
  note?: string | null;
  chargeRestaurantPaise?: number;
  /** true (admin): over-cap → 422; false (events): record a FAILED refund for admin follow-up. */
  strict: boolean;
  correlationId?: string;
}

function history(from: RefundStatus | null, to: RefundStatus, at: Date, source: string): StatusHistoryEntry<RefundStatus> {
  return { from, to, at, source };
}

function refundPayload(r: RefundDoc, status: RefundStatus) {
  return {
    refundId: r.id as string,
    ...(r.childOrderId ? { childOrderId: r.childOrderId } : {}),
    checkoutGroupId: r.checkoutGroupId,
    amountPaise: r.amountPaise,
    reason: r.reason,
    status,
  };
}

async function emitRefund(
  ctx: PaymentsContext,
  session: ClientSession,
  type: 'refund.requested' | 'refund.processing' | 'refund.succeeded' | 'refund.failed',
  r: RefundDoc,
  status: RefundStatus,
  correlationId?: string,
) {
  await emitEvent(ctx.conn, session, type, refundPayload(r, status), {
    producer: 'payments',
    aggregateId: r.id as string,
    ...(correlationId ? { correlationId } : {}),
  });
}

export function providerRefundKey(r: Pick<RefundDoc, 'id' | 'providerKeySeq'>): string {
  return `thali_${r.id as string}_${r.providerKeySeq}`;
}

export async function requestRefund(ctx: PaymentsContext, session: ClientSession, input: RequestRefundInput): Promise<{ refund: RefundDoc; created: boolean }> {
  const { Refund, PaymentIntent } = ctx.models;
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new DomainError('VALIDATION_FAILED', 'Refund amount must be a positive integer (paise)');
  }
  const existing = await Refund.findOne({ idempotencyKey: input.idempotencyKey }).session(session);
  if (existing) return { refund: existing, created: false };

  const intent = input.paymentIntentId
    ? isValidObjectId(input.paymentIntentId)
      ? await PaymentIntent.findById(input.paymentIntentId).session(session)
      : null
    : await PaymentIntent.findOne({ purpose: 'CHECKOUT', referenceId: input.checkoutGroupId }).session(session);
  if (!intent) throw new DomainError('NOT_FOUND', 'Payment intent not found for refund');

  const reserve = await PaymentIntent.updateOne(
    {
      _id: intent._id,
      status: { $in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
      $expr: { $lte: [{ $add: ['$refundReservedPaise', input.amountPaise] }, '$capturedPaise'] },
    },
    { $inc: { refundReservedPaise: input.amountPaise } },
    { session },
  );
  const reserved = reserve.modifiedCount === 1;
  const remaining = Math.max(0, intent.capturedPaise - intent.refundReservedPaise);
  const now = ctx.now();
  if (!reserved && input.strict) {
    throw new DomainError('REFUND_EXCEEDS_CAPTURED', 'Refund exceeds the remaining captured amount', 422, {
      paymentStatus: intent.status,
      capturedPaise: intent.capturedPaise,
      reservedPaise: intent.refundReservedPaise,
      remainingPaise: ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(intent.status) ? remaining : 0,
    });
  }
  const base = {
    paymentIntentId: intent.id as string,
    checkoutGroupId: input.checkoutGroupId,
    childOrderId: input.childOrderId ?? null,
    restaurantId: input.restaurantId ?? null,
    amountPaise: input.amountPaise,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    requestedBy: input.requestedBy,
    note: input.note ?? null,
    chargeRestaurantPaise: input.chargeRestaurantPaise ?? 0,
    maxAttempts: ctx.config.REFUND_MAX_ATTEMPTS,
  };
  if (!reserved) {
    const lastError = `REFUND_EXCEEDS_CAPTURED: requested ${input.amountPaise}, remaining ${remaining} (payment ${intent.status})`;
    const [refund] = await Refund.create(
      [
        {
          ...base,
          status: 'FAILED',
          reserved: false,
          nextAttemptAt: null,
          lastError,
          statusHistory: [history(null, 'REQUESTED', now, input.requestedBy), history('REQUESTED', 'FAILED', now, 'reservation')],
        },
      ],
      { session },
    );
    ctx.logger.error({ alert: 'REFUND_NOT_RESERVABLE', refundId: refund!.id, paymentIntentId: intent.id, lastError }, 'refund could not be reserved');
    await emitRefund(ctx, session, 'refund.failed', refund!, 'FAILED', input.correlationId);
    return { refund: refund!, created: true };
  }
  const [refund] = await Refund.create(
    [{ ...base, status: 'REQUESTED', reserved: true, nextAttemptAt: now, statusHistory: [history(null, 'REQUESTED', now, input.requestedBy)] }],
    { session },
  );
  await emitRefund(ctx, session, 'refund.requested', refund!, 'REQUESTED', input.correlationId);
  return { refund: refund!, created: true };
}

/** Provider confirmed the refund. Moves through PROCESSING when needed (two history entries). */
export async function markRefundSucceeded(
  ctx: PaymentsContext,
  session: ClientSession,
  refund: RefundDoc,
  opts: { providerRefundId?: string; source: string },
): Promise<void> {
  const { Refund, PaymentIntent } = ctx.models;
  const from = refund.status;
  const now = ctx.now();
  const entries: StatusHistoryEntry<RefundStatus>[] = [];
  let cur: RefundStatus = from;
  if (cur !== 'PROCESSING') {
    assertTransition(refundTransitions, cur, 'PROCESSING', 'SYSTEM');
    entries.push(history(cur, 'PROCESSING', now, opts.source));
    cur = 'PROCESSING';
  }
  assertTransition(refundTransitions, cur, 'SUCCEEDED', 'SYSTEM');
  entries.push(history(cur, 'SUCCEEDED', now, opts.source));
  const updated = await Refund.findOneAndUpdate(
    { _id: refund._id, status: from },
    {
      $set: {
        status: 'SUCCEEDED',
        lockedUntil: null,
        nextAttemptAt: null,
        lastError: null,
        ...(opts.providerRefundId && !refund.providerRefundId ? { providerRefundId: opts.providerRefundId } : {}),
      },
      $push: { statusHistory: { $each: entries } },
      $inc: { version: 1 },
    },
    { session, new: true },
  );
  if (!updated) throw new DomainError('CONCURRENT_MODIFICATION', 'Refund changed concurrently');

  const intent = await PaymentIntent.findById(refund.paymentIntentId).session(session);
  if (!intent) throw new DomainError('NOT_FOUND', 'Payment intent missing for refund');
  const refunded = intent.refundedPaise + refund.amountPaise;
  if (refunded > intent.capturedPaise) {
    ctx.logger.error({ alert: 'REFUND_OVER_CAPTURE', paymentIntentId: intent.id, refundId: refund.id, refunded, captured: intent.capturedPaise }, 'refunds exceed captured');
  }
  const to: PaymentStatus = refunded >= intent.capturedPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  if (intent.status === 'CAPTURED' || intent.status === 'PARTIALLY_REFUNDED') {
    assertTransition(paymentTransitions, intent.status, to, 'SYSTEM');
    await PaymentIntent.updateOne(
      { _id: intent._id, status: intent.status },
      {
        $set: { status: to, statusChangedAt: now },
        $inc: { refundedPaise: refund.amountPaise, version: 1 },
        $push: { statusHistory: { from: intent.status, to, at: now, source: `refund:${refund.id as string}` } },
      },
      { session },
    );
  } else {
    ctx.logger.error({ alert: 'REFUND_ON_UNCAPTURED_INTENT', paymentIntentId: intent.id, status: intent.status }, 'refund succeeded on non-captured intent');
    await PaymentIntent.updateOne({ _id: intent._id }, { $inc: { refundedPaise: refund.amountPaise } }, { session });
  }
  await emitRefund(ctx, session, 'refund.succeeded', updated, 'SUCCEEDED');
  if (updated.chargeRestaurantPaise > 0 && updated.restaurantId) {
    await postEntry(ctx, session, {
      accountType: 'RESTAURANT',
      accountId: updated.restaurantId,
      entryType: 'REFUND_ADJUSTMENT',
      amountPaise: -updated.chargeRestaurantPaise,
      dedupeKey: `refund-adjustment:${updated.id as string}`,
      memo: `Refund ${formatINR(updated.amountPaise)} charged to restaurant ${formatINR(updated.chargeRestaurantPaise)}`,
      createdBy: updated.requestedBy,
      childOrderId: updated.childOrderId ?? null,
      refundId: updated.id as string,
    });
  }
}

/**
 * Attempt failed. `definitive` (provider rejected / reported failed) → next attempt uses a fresh
 * provider key; otherwise (timeout/5xx) the same key is reused so the provider dedupes.
 */
export async function markRefundFailed(
  ctx: PaymentsContext,
  session: ClientSession,
  refund: RefundDoc,
  opts: { error: string; definitive: boolean; source: string },
): Promise<{ final: boolean }> {
  const from = refund.status;
  assertTransition(refundTransitions, from, 'FAILED', 'SYSTEM');
  const now = ctx.now();
  const final = refund.attempts >= refund.maxAttempts;
  const nextAttemptAt = final ? null : new Date(now.getTime() + ctx.config.REFUND_BACKOFF_BASE_MS * 2 ** Math.max(0, refund.attempts - 1));
  const updated = await ctx.models.Refund.findOneAndUpdate(
    { _id: refund._id, status: from },
    {
      $set: {
        status: 'FAILED',
        lastError: opts.error.slice(0, 500),
        nextAttemptAt,
        lockedUntil: null,
        processingSince: null,
        ...(opts.definitive ? { providerRefundId: null } : {}),
      },
      $inc: { version: 1, ...(opts.definitive ? { providerKeySeq: 1 } : {}) },
      $push: { statusHistory: history(from, 'FAILED', now, opts.source) },
    },
    { session, new: true },
  );
  if (!updated) throw new DomainError('CONCURRENT_MODIFICATION', 'Refund changed concurrently');
  if (final) {
    ctx.logger.error({ alert: 'REFUND_FAILED_FINAL', refundId: refund.id, attempts: refund.attempts, error: opts.error }, 'refund failed after max attempts');
    await emitRefund(ctx, session, 'refund.failed', updated, 'FAILED');
  } else {
    ctx.logger.warn({ refundId: refund.id, attempts: refund.attempts, nextAttemptAt, error: opts.error }, 'refund attempt failed; will retry');
  }
  return { final };
}

/** One worker attempt for a refund (claim → provider call → record). Returns the refund after the attempt. */
export async function processRefund(ctx: PaymentsContext, refundId: string): Promise<RefundDoc | null> {
  const { Refund, PaymentIntent } = ctx.models;
  const leaseMs = ctx.config.PAYMENT_PROVIDER_TIMEOUT_MS + 30_000;
  const claimed = await withTransaction(ctx.conn, async (session) => {
    const r = await Refund.findById(refundId).session(session);
    const now = ctx.now();
    if (!r || r.providerRefundId || !r.reserved || r.attempts >= r.maxAttempts) return null;
    const due = r.status === 'REQUESTED' || (r.status === 'FAILED' && r.nextAttemptAt !== null && r.nextAttemptAt <= now);
    if (!due) return null;
    assertTransition(refundTransitions, r.status, 'PROCESSING', 'SYSTEM');
    const updated = await Refund.findOneAndUpdate(
      { _id: r._id, status: r.status, attempts: r.attempts },
      {
        $set: { status: 'PROCESSING', lockedUntil: new Date(now.getTime() + leaseMs), processingSince: now, nextAttemptAt: null },
        $inc: { attempts: 1, version: 1 },
        $push: { statusHistory: history(r.status, 'PROCESSING', now, 'worker') },
      },
      { session, new: true },
    );
    if (!updated) return null;
    await emitRefund(ctx, session, 'refund.processing', updated, 'PROCESSING');
    return updated;
  });
  if (!claimed) return null;

  const intent = await PaymentIntent.findById(claimed.paymentIntentId);
  const recordFailure = (error: string, definitive: boolean) =>
    withTransaction(ctx.conn, async (session) => {
      const r = await Refund.findById(claimed._id).session(session);
      if (!r || r.status !== 'PROCESSING' || r.providerRefundId) return;
      await markRefundFailed(ctx, session, r, { error, definitive, source: 'worker' });
    });

  if (!intent?.providerPaymentId) {
    await recordFailure('PAYMENT_NOT_CAPTURED: no provider payment id on intent', true);
    return Refund.findById(claimed._id);
  }
  let res: Awaited<ReturnType<PaymentsContext['provider']['refund']>>;
  try {
    res = await ctx.provider.refund({
      paymentId: intent.providerPaymentId,
      amountPaise: claimed.amountPaise,
      idempotencyKey: providerRefundKey(claimed),
      notes: {
        refundId: claimed.id as string,
        checkoutGroupId: claimed.checkoutGroupId,
        ...(claimed.childOrderId ? { childOrderId: claimed.childOrderId } : {}),
      },
    });
  } catch (err) {
    const definitive = err instanceof PaymentProviderError ? !err.retryable : false;
    if (!(err instanceof PaymentProviderError)) ctx.logger.error({ err, refundId: claimed.id }, 'unexpected refund provider error');
    await recordFailure(err instanceof Error ? err.message : String(err), definitive);
    return Refund.findById(claimed._id);
  }
  await withTransaction(ctx.conn, async (session) => {
    const r = await Refund.findById(claimed._id).session(session);
    if (!r || r.status !== 'PROCESSING') return; // settled meanwhile (e.g. webhook)
    if (res.status === 'processed') {
      await markRefundSucceeded(ctx, session, r, { providerRefundId: res.providerRefundId, source: 'provider:create' });
    } else if (res.status === 'failed') {
      await markRefundFailed(ctx, session, r, { error: `provider refund ${res.providerRefundId} failed`, definitive: true, source: 'provider:create' });
    } else {
      await Refund.updateOne({ _id: r._id, status: 'PROCESSING' }, { $set: { providerRefundId: res.providerRefundId, lockedUntil: null } }, { session });
    }
  });
  return Refund.findById(claimed._id);
}

/** Worker tick: REQUESTED refunds and FAILED refunds whose backoff elapsed. */
export async function processDueRefunds(ctx: PaymentsContext, signal?: AbortSignal): Promise<number> {
  const now = ctx.now();
  const due = await ctx.models.Refund.find(
    { reserved: true, $or: [{ status: 'REQUESTED' }, { status: 'FAILED', nextAttemptAt: { $lte: now } }] },
    { _id: 1 },
  )
    .sort({ nextAttemptAt: 1 })
    .limit(50)
    .lean();
  let n = 0;
  for (const d of due) {
    if (signal?.aborted) break;
    try {
      if (await processRefund(ctx, String(d._id))) n += 1;
    } catch (err) {
      ctx.logger.error({ err, refundId: String(d._id) }, 'refund processing error');
    }
  }
  return n;
}

/** PROCESSING refunds: expired worker leases (crash mid-call) and provider polling after REFUND_POLL_AFTER_SEC. */
export async function reconcileProcessingRefunds(ctx: PaymentsContext, signal?: AbortSignal): Promise<void> {
  const { Refund } = ctx.models;
  const now = ctx.now();
  const stuck = await Refund.find({ status: 'PROCESSING', providerRefundId: null, lockedUntil: { $lt: now } }).limit(50);
  for (const r of stuck) {
    if (signal?.aborted) return;
    await withTransaction(ctx.conn, async (session) => {
      const cur = await Refund.findById(r._id).session(session);
      if (!cur || cur.status !== 'PROCESSING' || cur.providerRefundId || !cur.lockedUntil || cur.lockedUntil >= now) return;
      await markRefundFailed(ctx, session, cur, { error: 'worker lease expired during provider call (outcome unknown)', definitive: false, source: 'reconcile' });
    }).catch((err: unknown) => ctx.logger.error({ err, refundId: r.id }, 'refund lease recovery failed'));
  }
  const cutoff = new Date(now.getTime() - ctx.config.REFUND_POLL_AFTER_SEC * 1000);
  const due = await Refund.find({
    status: 'PROCESSING',
    providerRefundId: { $type: 'string' },
    processingSince: { $lte: cutoff },
    $or: [{ lastPolledAt: null }, { lastPolledAt: { $lte: cutoff } }],
  }).limit(50);
  for (const r of due) {
    if (signal?.aborted) return;
    try {
      const pr = await ctx.provider.fetchRefund(r.providerRefundId!);
      if (pr.amountPaise !== r.amountPaise) {
        ctx.logger.error({ alert: 'REFUND_MISMATCH', refundId: r.id, expected: r.amountPaise, got: pr.amountPaise }, 'provider refund amount mismatch');
        await Refund.updateOne({ _id: r._id }, { $set: { lastPolledAt: now } });
        continue;
      }
      await withTransaction(ctx.conn, async (session) => {
        const cur = await Refund.findById(r._id).session(session);
        if (!cur || cur.status !== 'PROCESSING') return;
        if (pr.status === 'processed') await markRefundSucceeded(ctx, session, cur, { source: 'reconcile:fetchRefund' });
        else if (pr.status === 'failed') await markRefundFailed(ctx, session, cur, { error: `provider refund ${pr.id} failed`, definitive: true, source: 'reconcile:fetchRefund' });
        else await Refund.updateOne({ _id: cur._id }, { $set: { lastPolledAt: now } }, { session });
      });
    } catch (err) {
      ctx.logger.warn({ err, refundId: r.id }, 'refund poll failed');
    }
  }
}

/** Admin manual retry of a FAILED refund (re-reserves if the original could not be reserved). */
export async function adminRetryRefund(ctx: PaymentsContext, refundId: string, actor: { userId: string; ip?: string }, audit: (session: ClientSession, r: RefundDoc) => Promise<void>) {
  const { Refund, PaymentIntent } = ctx.models;
  if (!isValidObjectId(refundId)) throw new DomainError('NOT_FOUND', 'Refund not found');
  await withTransaction(ctx.conn, async (session) => {
    const r = await Refund.findById(refundId).session(session);
    if (!r) throw new DomainError('NOT_FOUND', 'Refund not found');
    if (r.status !== 'FAILED') {
      throw new DomainError('REFUND_INVALID_TRANSITION', `Only FAILED refunds can be retried (current ${r.status})`, 409, { from: r.status, to: 'PROCESSING' });
    }
    assertTransition(refundTransitions, 'FAILED', 'PROCESSING', 'ADMIN');
    if (!r.reserved) {
      const ok = await PaymentIntent.updateOne(
        {
          _id: r.paymentIntentId,
          status: { $in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
          $expr: { $lte: [{ $add: ['$refundReservedPaise', r.amountPaise] }, '$capturedPaise'] },
        },
        { $inc: { refundReservedPaise: r.amountPaise } },
        { session },
      );
      if (ok.modifiedCount !== 1) throw new DomainError('REFUND_EXCEEDS_CAPTURED', 'Refund exceeds the remaining captured amount', 422);
    }
    await Refund.updateOne(
      { _id: r._id, status: 'FAILED' },
      { $set: { reserved: true, nextAttemptAt: ctx.now(), maxAttempts: Math.max(r.maxAttempts, r.attempts + 1) }, $inc: { version: 1 } },
      { session },
    );
    await audit(session, r);
  });
  ctx.logger.info({ refundId, actor: actor.userId }, 'admin refund retry');
  await processRefund(ctx, refundId);
  return (await Refund.findById(refundId))!;
}

export function refundView(r: RefundDoc | (Record<string, unknown> & { _id: unknown })) {
  const d = r as RefundDoc;
  return {
    id: String(d._id),
    paymentIntentId: d.paymentIntentId,
    checkoutGroupId: d.checkoutGroupId,
    childOrderId: d.childOrderId ?? null,
    restaurantId: d.restaurantId ?? null,
    amountPaise: d.amountPaise,
    reason: d.reason,
    status: d.status,
    providerRefundId: d.providerRefundId ?? null,
    attempts: d.attempts,
    maxAttempts: d.maxAttempts,
    nextAttemptAt: d.nextAttemptAt ? new Date(d.nextAttemptAt).toISOString() : null,
    lastError: d.lastError ?? null,
    requestedBy: d.requestedBy,
    note: d.note ?? null,
    chargeRestaurantPaise: d.chargeRestaurantPaise ?? 0,
    statusHistory: (d.statusHistory ?? []).map((h) => ({ from: h.from, to: h.to, at: new Date(h.at).toISOString(), source: h.source })),
    createdAt: new Date(d.createdAt).toISOString(),
    updatedAt: new Date(d.updatedAt).toISOString(),
  };
}
