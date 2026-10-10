/**
 * Child refund bookkeeping (LLD §3.3 `refundStatus` / `refundedPaise`, §4.4, §8 consumer `refund.*`).
 *
 * Orders never moves money: a rejection / cancellation records `refundRequestedPaise` and emits the
 * order event; payments creates the refund and reports progress with `refund.*`. Each refund is
 * mirrored on the child by `refundId`, so re-published copies (new envelope ids) never double count:
 *   refundedPaise = Σ SUCCEEDED entries; refundStatus = aggregate of entries (+ a not-yet-seen request).
 * Refund statuses only move forward (SUCCEEDED is final, FAILED → PROCESSING is a retry), and an event
 * older (`occurredAt`) than the last one applied to that refund is ignored.
 */
import { Types, type ClientSession } from 'mongoose';
import type { EventEnvelope, RefundEventPayload } from '@thali/contracts';
import type { OrdersContext } from '../context.js';
import type { ChildOrder, ChildOrderDoc, ChildRefundEntry } from '../models/child-order.js';
import { appendOrderEvents } from '../models/order-event.js';
import { publishChildUpdate } from './place.js';

type RefundState = ChildRefundEntry['status'];

/** Paise already committed to refunds for this child (requested by orders, or seen from payments). */
export function committedRefundPaise(child: Pick<ChildOrder, 'refundRequestedPaise' | 'refunds'>): number {
  const seen = (child.refunds ?? []).filter((r) => r.status !== 'FAILED').reduce((s, r) => s + r.amountPaise, 0);
  return Math.max(child.refundRequestedPaise ?? 0, seen);
}

/** What can still be refunded for this child (LLD §4.1 admin cancel: refundPaise ≤ remaining). */
export function remainingRefundable(child: Pick<ChildOrder, 'breakdown' | 'refundRequestedPaise' | 'refunds'>): number {
  return Math.max(0, child.breakdown.totalPaise - committedRefundPaise(child));
}

/** Record that orders requested `amountPaise` back for this child (inside the transition). */
export function requestChildRefund(child: ChildOrderDoc, amountPaise: number): void {
  if (amountPaise <= 0) return;
  child.refundRequestedPaise = (child.refundRequestedPaise ?? 0) + amountPaise;
  child.refundStatus = aggregateRefundStatus(child);
}

/** Whether a refund entry may move `from → to` (stale / duplicate events return false). */
export function canAdvanceRefund(from: RefundState, to: RefundState): boolean {
  if (from === to || from === 'SUCCEEDED' || to === 'REQUESTED') return false;
  return true; // REQUESTED → any; PROCESSING → SUCCEEDED|FAILED; FAILED → PROCESSING (retry) | SUCCEEDED
}

export function aggregateRefundStatus(child: Pick<ChildOrder, 'refunds' | 'refundRequestedPaise' | 'refundStatus'>): ChildOrder['refundStatus'] {
  const entries = child.refunds ?? [];
  const states = new Set(entries.map((r) => r.status));
  const seenTotal = entries.reduce((s, r) => s + r.amountPaise, 0);
  const unseenRequest = (child.refundRequestedPaise ?? 0) > seenTotal;
  if (states.has('PROCESSING')) return 'PROCESSING';
  if (states.has('REQUESTED') || unseenRequest) return 'REQUESTED';
  if (states.has('FAILED')) return 'FAILED';
  if (states.has('SUCCEEDED')) return 'SUCCEEDED';
  return child.refundStatus ?? 'NONE';
}

export type RefundEventOutcome = 'APPLIED' | 'STALE' | 'CHECKOUT_LEVEL' | 'UNKNOWN_CHILD' | 'CHECKOUT_MISMATCH';

/** Consumer for `refund.requested|processing|succeeded|failed` (runs in the consumer's transaction). */
export async function applyRefundEvent(
  ctx: OrdersContext,
  session: ClientSession,
  e: EventEnvelope<'refund.requested' | 'refund.processing' | 'refund.succeeded' | 'refund.failed'>,
): Promise<RefundEventOutcome> {
  const p = e.payload as RefundEventPayload;
  const at = new Date(e.occurredAt);
  if (!p.childOrderId) {
    // checkout-level refund (e.g. LATE_PAYMENT): timeline only — no child carries it
    if (Types.ObjectId.isValid(p.checkoutGroupId) && (await ctx.models.CheckoutGroup.exists({ _id: p.checkoutGroupId }).session(session))) {
      await appendOrderEvents(ctx.conn, session, [
        {
          checkoutGroupId: new Types.ObjectId(p.checkoutGroupId),
          type: e.type,
          actor: 'SYSTEM',
          data: { refundId: p.refundId, amountPaise: p.amountPaise, reason: p.reason, status: p.status },
          at,
        },
      ]);
    } else {
      ctx.logger.warn({ refundId: p.refundId, checkoutGroupId: p.checkoutGroupId }, 'checkout-level refund event for unknown checkout');
    }
    return 'CHECKOUT_LEVEL';
  }

  const child = Types.ObjectId.isValid(p.childOrderId) ? await ctx.models.ChildOrder.findById(p.childOrderId).session(session) : null;
  if (!child) {
    ctx.logger.warn({ refundId: p.refundId, childOrderId: p.childOrderId, type: e.type }, 'refund event for unknown child order; ignored');
    return 'UNKNOWN_CHILD';
  }
  if (String(child.checkoutGroupId) !== p.checkoutGroupId) {
    // A refund booked against another payment/checkout must never move this child's money mirror.
    ctx.logger.error(
      {
        alert: 'REFUND_CHECKOUT_MISMATCH',
        refundId: p.refundId,
        childOrderId: p.childOrderId,
        eventCheckoutGroupId: p.checkoutGroupId,
        childCheckoutGroupId: String(child.checkoutGroupId),
        type: e.type,
      },
      "refund event's checkoutGroupId does not match the child's checkout; ignored",
    );
    return 'CHECKOUT_MISMATCH';
  }

  const status = p.status as RefundState;
  const entry = child.refunds.find((r) => r.refundId === p.refundId);
  if (!entry) {
    child.refunds.push({ refundId: p.refundId, amountPaise: p.amountPaise, reason: p.reason, status, updatedAt: at });
  } else if (entry.updatedAt && at.getTime() < new Date(entry.updatedAt).getTime()) {
    return 'STALE'; // older than what we applied (e.g. a late PROCESSING must not flip FAILED back)
  } else if (canAdvanceRefund(entry.status, status)) {
    entry.status = status;
    entry.updatedAt = at;
  } else {
    return 'STALE';
  }
  const seenTotal = child.refunds.reduce((s, r) => s + r.amountPaise, 0);
  child.refundRequestedPaise = Math.max(child.refundRequestedPaise ?? 0, seenTotal);
  child.refundedPaise = child.refunds.filter((r) => r.status === 'SUCCEEDED').reduce((s, r) => s + r.amountPaise, 0);
  child.refundStatus = aggregateRefundStatus(child);
  await child.save({ session });

  await appendOrderEvents(ctx.conn, session, [
    {
      checkoutGroupId: child.checkoutGroupId,
      childOrderId: child._id,
      type: e.type,
      actor: 'SYSTEM',
      data: { refundId: p.refundId, amountPaise: p.amountPaise, reason: p.reason, status: p.status, refundStatus: child.refundStatus },
      at,
    },
  ]);
  const group = await ctx.models.CheckoutGroup.findById(child.checkoutGroupId).session(session);
  if (group) publishChildUpdate(ctx, session, group, child);
  return 'APPLIED';
}
