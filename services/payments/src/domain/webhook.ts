/**
 * Webhook ingestion (Review Focus #3, LLD §4.3). Pipeline:
 *   verify signature over the exact raw bytes → parse → one transaction:
 *   insert payment_events{_id: eventId} (duplicate → IGNORED_DUPLICATE) → load intent/refund →
 *   amount/currency/reference checks (→ REJECTED_MISMATCH + alert) → state transition per LLD §4.3
 *   (implied earlier state → IGNORED_STALE) → outbox payment.captured / payment.failed / refund.*.
 * The provider gets 200 once the event is durably recorded; only signature failures are 400.
 */
import { createHash } from 'node:crypto';
import { DomainError, assertTransition, paymentTransitions, type PaymentStatus } from '@thali/contracts';
import { emitEvent, withTransaction } from '@thali/service-kit';
import { isValidObjectId, type ClientSession } from 'mongoose';
import type { PaymentsContext } from '../context.js';
import { PaymentEventResult } from '../models/payment-event.js';
import type { PaymentIntentDoc } from '../models/payment-intent.js';
import type { NormalizedEvent } from '../providers/payment-provider.js';
import { isDuplicateKey } from './intents.js';
import { markRefundFailed, markRefundSucceeded } from './refunds.js';

export interface WebhookInput {
  rawBody: Buffer;
  signature?: string;
  eventId?: string;
  /** `x-thali-mock` header present (accepted only when PAYMENT_PROVIDER=mock). */
  mockHeader: boolean;
}

export interface WebhookOutcome {
  eventId: string;
  type: string;
  result: PaymentEventResult;
}

export interface ApplyOutcome {
  result: PaymentEventResult;
  detail?: string;
}

/** What a provider fact says about a payment (from a webhook or from reconciliation). */
export interface PaymentSignal {
  kind: 'AUTHORIZED' | 'CAPTURED' | 'FAILED';
  providerPaymentId?: string;
  amountPaise: number;
  currency: string;
  notes?: Record<string, string>;
  /** Provider order receipt when known (order.paid). */
  receipt?: string | null;
  reason?: string;
}

const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export async function ingestWebhook(ctx: PaymentsContext, input: WebhookInput): Promise<WebhookOutcome> {
  if (input.mockHeader && ctx.provider.name !== 'mock') {
    ctx.logger.warn({ alert: 'WEBHOOK_MOCK_REJECTED' }, 'mock webhook header received while provider is not mock');
    throw new DomainError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature invalid', 400);
  }
  if (!input.signature || !ctx.provider.verifyWebhook(input.rawBody, input.signature)) {
    ctx.logger.warn({ alert: 'WEBHOOK_SIGNATURE_INVALID', bytes: input.rawBody.length }, 'webhook signature verification failed');
    throw new DomainError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature invalid', 400);
  }
  const bodyHash = `sha256:${createHash('sha256').update(input.rawBody).digest('hex')}`;
  let json: unknown;
  let malformed = false;
  try {
    json = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    // Correctly signed but unparseable: record it (keyed by the body hash) and acknowledge, so the
    // provider stops retrying; only signature failures are 400.
    malformed = true;
    ctx.logger.error({ alert: 'WEBHOOK_MALFORMED', bytes: input.rawBody.length, eventId: bodyHash }, 'signed webhook with malformed JSON stored');
  }
  const eventId = !malformed && input.eventId && EVENT_ID_RE.test(input.eventId) ? input.eventId : bodyHash;
  const rawType = malformed
    ? 'malformed'
    : typeof (json as { event?: unknown })?.event === 'string'
      ? String((json as { event: string }).event).slice(0, 100)
      : 'unknown';
  const ev = malformed ? null : ctx.provider.parseWebhook(json);
  const { PaymentEvent } = ctx.models;

  try {
    return await withTransaction(ctx.conn, async (session) => {
      const now = ctx.now();
      await PaymentEvent.create(
        [
          {
            _id: eventId,
            provider: ctx.provider.name,
            type: rawType,
            providerOrderId: ev?.providerOrderId ?? null,
            providerPaymentId: ev?.providerPaymentId ?? null,
            providerRefundId: ev?.providerRefundId ?? null,
            payload: ev ? redact(ev) : { event: rawType },
            receivedAt: now,
            result: 'IGNORED_UNKNOWN',
          },
        ],
        { session },
      );
      const outcome: ApplyOutcome = ev
        ? await applyEvent(ctx, session, eventId, ev)
        : { result: 'IGNORED_UNKNOWN', detail: malformed ? 'malformed JSON' : 'unsupported event type' };
      await PaymentEvent.updateOne(
        { _id: eventId },
        { $set: { result: outcome.result, resultDetail: outcome.detail ?? null, processedAt: now } },
        { session },
      );
      return { eventId, type: rawType, result: outcome.result };
    });
  } catch (err) {
    if (isDuplicateKey(err, 'payment_events')) {
      ctx.logger.info({ eventId, type: rawType }, 'duplicate webhook event ignored');
      return { eventId, type: rawType, result: 'IGNORED_DUPLICATE' };
    }
    throw err;
  }
}

function redact(ev: NormalizedEvent): Record<string, unknown> {
  return {
    type: ev.type,
    providerOrderId: ev.providerOrderId ?? null,
    providerPaymentId: ev.providerPaymentId ?? null,
    providerRefundId: ev.providerRefundId ?? null,
    amountPaise: Number.isFinite(ev.amountPaise) ? ev.amountPaise : null,
    currency: ev.currency,
    createdAt: ev.createdAt.toISOString(),
    notes: ev.notes,
    ...(ev.receipt !== undefined ? { receipt: ev.receipt } : {}),
    ...(ev.reason ? { reason: ev.reason.slice(0, 200) } : {}),
  };
}

async function applyEvent(ctx: PaymentsContext, session: ClientSession, eventId: string, ev: NormalizedEvent): Promise<ApplyOutcome> {
  const source = `webhook:${eventId}`;
  if (ev.type === 'refund.processed' || ev.type === 'refund.failed') return applyRefundEvent(ctx, session, ev, source);
  if (!ev.providerOrderId) return { result: 'IGNORED_UNKNOWN', detail: 'no provider order id' };
  const intent = await ctx.models.PaymentIntent.findOne({ providerOrderId: ev.providerOrderId }).session(session);
  if (!intent) {
    ctx.logger.warn({ alert: 'WEBHOOK_UNKNOWN_ORDER', providerOrderId: ev.providerOrderId, eventId }, 'webhook for unknown provider order');
    return { result: 'IGNORED_UNKNOWN', detail: 'unknown provider order' };
  }
  const kind = ev.type === 'payment.authorized' ? 'AUTHORIZED' : ev.type === 'payment.failed' ? 'FAILED' : 'CAPTURED';
  return applyPaymentSignal(ctx, session, intent, {
    kind,
    providerPaymentId: ev.providerPaymentId,
    amountPaise: ev.amountPaise,
    currency: ev.currency,
    notes: ev.notes,
    ...(ev.type === 'order.paid' ? { receipt: ev.receipt ?? null } : {}),
    ...(ev.reason ? { reason: ev.reason } : {}),
  }, source);
}

function mismatch(intent: PaymentIntentDoc, s: PaymentSignal): string | null {
  if (s.amountPaise !== intent.amountPaise) return `amount ${s.amountPaise} != ${intent.amountPaise}`;
  if (s.currency !== 'INR') return `currency ${s.currency} != INR`;
  const notes = s.notes ?? {};
  if (notes.paymentIntentId !== undefined && notes.paymentIntentId !== intent.id) return 'notes.paymentIntentId mismatch';
  if (notes.referenceId !== undefined && notes.referenceId !== intent.referenceId) return 'notes.referenceId mismatch';
  if (notes.purpose !== undefined && notes.purpose !== intent.purpose) return 'notes.purpose mismatch';
  if (s.receipt && !s.receipt.startsWith(`${intent.id as string}_`)) return 'receipt mismatch';
  return null;
}

const CAPTURABLE_FROM: PaymentStatus[] = ['CREATED', 'AUTHORIZED', 'FAILED'];
const FAILABLE_FROM: PaymentStatus[] = ['CREATED', 'AUTHORIZED'];

/**
 * Apply a provider payment fact to an intent inside `session`. Shared by webhooks and reconciliation so
 * both follow the same validation, out-of-order and event-emission rules.
 */
export async function applyPaymentSignal(
  ctx: PaymentsContext,
  session: ClientSession,
  intent: PaymentIntentDoc,
  s: PaymentSignal,
  source: string,
): Promise<ApplyOutcome> {
  const bad = mismatch(intent, s);
  if (bad) {
    ctx.logger.error(
      { alert: 'PAYMENT_MISMATCH', paymentIntentId: intent.id, providerPaymentId: s.providerPaymentId, detail: bad, source },
      'provider payment does not match the intent; not applied',
    );
    return { result: 'REJECTED_MISMATCH', detail: bad };
  }
  const from = intent.status;
  const to: PaymentStatus = s.kind;
  const stale =
    (to === 'AUTHORIZED' && from !== 'CREATED') ||
    (to === 'CAPTURED' && !CAPTURABLE_FROM.includes(from)) ||
    (to === 'FAILED' && !FAILABLE_FROM.includes(from));
  if (stale) {
    if (to === 'CAPTURED' && s.providerPaymentId && intent.providerPaymentId && s.providerPaymentId !== intent.providerPaymentId) {
      ctx.logger.error(
        { alert: 'DUPLICATE_CAPTURE', paymentIntentId: intent.id, providerPaymentId: s.providerPaymentId, existing: intent.providerPaymentId },
        'second captured payment on an already-captured intent: manual refund required',
      );
    } else if (to === 'FAILED' && from !== 'FAILED') {
      ctx.logger.warn({ alert: 'FAILED_AFTER_CAPTURE', paymentIntentId: intent.id, status: from, source }, 'payment.failed after capture ignored');
    }
    return { result: 'IGNORED_STALE', detail: `${to} implied while ${from}` };
  }
  assertTransition(paymentTransitions, from, to, 'SYSTEM');
  const now = ctx.now();
  const set: Record<string, unknown> = { status: to, statusChangedAt: now };
  if (s.providerPaymentId) set.providerPaymentId = s.providerPaymentId;
  if (to === 'CAPTURED') {
    set.capturedPaise = intent.amountPaise;
    set.failureReason = null;
  }
  if (to === 'FAILED') set.failureReason = (s.reason ?? 'Payment failed').slice(0, 200);
  const updated = await ctx.models.PaymentIntent.findOneAndUpdate(
    { _id: intent._id, status: from },
    { $set: set, $inc: { version: 1 }, $push: { statusHistory: { from, to, at: now, source } } },
    { session, new: true },
  );
  if (!updated) throw new DomainError('CONCURRENT_MODIFICATION', 'Payment intent changed concurrently');

  if (to === 'CAPTURED') {
    await emitEvent(
      ctx.conn,
      session,
      'payment.captured',
      {
        paymentIntentId: updated.id as string,
        purpose: updated.purpose,
        referenceId: updated.referenceId,
        userId: updated.userId,
        amountPaise: updated.capturedPaise,
        providerPaymentId: updated.providerPaymentId ?? '',
      },
      { producer: 'payments', aggregateId: updated.id as string },
    );
  } else if (to === 'FAILED') {
    await emitEvent(
      ctx.conn,
      session,
      'payment.failed',
      {
        paymentIntentId: updated.id as string,
        purpose: updated.purpose,
        referenceId: updated.referenceId,
        userId: updated.userId,
        reason: updated.failureReason ?? 'Payment failed',
      },
      { producer: 'payments', aggregateId: updated.id as string },
    );
  }
  return { result: 'APPLIED' };
}

async function applyRefundEvent(ctx: PaymentsContext, session: ClientSession, ev: NormalizedEvent, source: string): Promise<ApplyOutcome> {
  const { Refund } = ctx.models;
  let refund = ev.providerRefundId ? await Refund.findOne({ providerRefundId: ev.providerRefundId }).session(session) : null;
  if (!refund && ev.notes.refundId && isValidObjectId(ev.notes.refundId)) {
    refund = await Refund.findById(ev.notes.refundId).session(session);
  }
  if (!refund) {
    ctx.logger.warn({ alert: 'WEBHOOK_UNKNOWN_REFUND', providerRefundId: ev.providerRefundId }, 'refund webhook for unknown refund');
    return { result: 'IGNORED_UNKNOWN', detail: 'unknown refund' };
  }
  if (refund.providerRefundId && ev.providerRefundId && refund.providerRefundId !== ev.providerRefundId) {
    ctx.logger.error(
      { alert: 'REFUND_MISMATCH', refundId: refund.id, expected: refund.providerRefundId, got: ev.providerRefundId },
      'refund webhook carries a different provider refund id',
    );
    return { result: 'REJECTED_MISMATCH', detail: 'provider refund id mismatch' };
  }
  if (ev.amountPaise !== refund.amountPaise || ev.currency !== 'INR') {
    ctx.logger.error({ alert: 'REFUND_MISMATCH', refundId: refund.id, expected: refund.amountPaise, got: ev.amountPaise }, 'refund webhook amount mismatch');
    return { result: 'REJECTED_MISMATCH', detail: `amount ${ev.amountPaise} != ${refund.amountPaise}` };
  }
  if (ev.type === 'refund.processed') {
    if (refund.status === 'SUCCEEDED') return { result: 'IGNORED_STALE', detail: 'already SUCCEEDED' };
    await markRefundSucceeded(ctx, session, refund, { ...(ev.providerRefundId ? { providerRefundId: ev.providerRefundId } : {}), source });
    return { result: 'APPLIED' };
  }
  if (refund.status === 'SUCCEEDED' || refund.status === 'FAILED') {
    if (refund.status === 'SUCCEEDED') ctx.logger.error({ alert: 'REFUND_FAILED_AFTER_SUCCESS', refundId: refund.id }, 'refund.failed after success ignored');
    return { result: 'IGNORED_STALE', detail: `refund.failed while ${refund.status}` };
  }
  await markRefundFailed(ctx, session, refund, { error: ev.reason ?? 'provider reported refund failed', definitive: true, source });
  return { result: 'APPLIED' };
}
