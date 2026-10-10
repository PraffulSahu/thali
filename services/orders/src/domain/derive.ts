/**
 * Derived, customer-facing facts about a checkout group:
 *  - `recomputeCheckout`: parent status from its children (LLD §4.2 `deriveCheckoutStatus`) after a
 *    child transition, inside the same transaction. The parent document is ALWAYS written (status
 *    change or a touch) so two concurrent sibling transitions conflict and one retries — otherwise
 *    snapshot isolation could leave a stale derived status (write skew).
 *  - `explanations`: why part of the purchase will not arrive and what happens to the money
 *    (context.md §7 "accurate explanation"), e.g. "Spice Route declined your order (Out of stock).
 *    ₹536.96 refund initiated."
 *  - `adjustedTotals`: paid / refunded / refund pending / net, from the children's refund mirror.
 */
import type { ClientSession } from 'mongoose';
import { formatINR, type ChildOrderStatus } from '@thali/contracts';
import type { OrdersContext } from '../context.js';
import type { CheckoutGroup, CheckoutGroupDoc } from '../models/checkout-group.js';
import type { ChildOrder, ChildOrderDoc } from '../models/child-order.js';
import { applyDerivedCheckoutStatus } from './child-state.js';

export async function recomputeCheckout(
  ctx: OrdersContext,
  session: ClientSession,
  child: ChildOrderDoc,
  meta: { reason?: string | null; at?: Date } = {},
): Promise<{ group: CheckoutGroupDoc; changed: boolean; from: string; to: string }> {
  const group = await ctx.models.CheckoutGroup.findById(child.checkoutGroupId).session(session);
  if (!group) throw new Error(`checkout ${String(child.checkoutGroupId)} missing for child ${String(child._id)}`);
  const siblings = await ctx.models.ChildOrder.find({ checkoutGroupId: group._id }, { status: 1 }).session(session).lean();
  const statuses = siblings.map((s) => (String(s._id) === String(child._id) ? child.status : s.status)) as ChildOrderStatus[];
  const r = applyDerivedCheckoutStatus(group, statuses, { reason: meta.reason ?? null, ...(meta.at ? { at: meta.at } : {}) });
  if (r.changed) await group.save({ session });
  else await ctx.models.CheckoutGroup.updateOne({ _id: group._id }, { $set: { updatedAt: new Date() } }, { session, timestamps: false });
  return { group, ...r };
}

// ---------------------------------------------------------------------------------------------
// explanations + adjusted totals

export type ExplanationKind = 'REJECTED' | 'CANCELLED' | 'DELIVERY_FAILED';

export interface Explanation {
  childOrderId: string;
  restaurantName: string;
  kind: ExplanationKind;
  reason: string | null;
  refundPaise: number;
  refundStatus: string;
  message: string;
}

type ExplainableChild = Pick<
  ChildOrder,
  | '_id'
  | 'restaurantName'
  | 'status'
  | 'rejectionReason'
  | 'cancellationReason'
  | 'cancelledBy'
  | 'deliveryFailureReason'
  | 'refundStatus'
  | 'refundRequestedPaise'
  | 'refundedPaise'
>;

export const RESTAURANT_TIMEOUT = 'RESTAURANT_TIMEOUT';

function refundSentence(c: ExplainableChild): string {
  const amount = c.refundRequestedPaise ?? 0;
  if (amount <= 0) return 'No refund applies.';
  switch (c.refundStatus) {
    case 'SUCCEEDED':
      return `${formatINR(amount)} refunded.`;
    case 'FAILED':
      return `The ${formatINR(amount)} refund failed; our team will retry it.`;
    default:
      return `${formatINR(amount)} refund initiated.`;
  }
}

export function explainChild(c: ExplainableChild): Explanation | null {
  const base = {
    childOrderId: String(c._id),
    restaurantName: c.restaurantName,
    refundPaise: c.refundRequestedPaise ?? 0,
    refundStatus: c.refundStatus ?? 'NONE',
  };
  const name = c.restaurantName;
  if (c.status === 'REJECTED') {
    const reason = c.rejectionReason ?? null;
    const lead = reason === RESTAURANT_TIMEOUT ? `${name} did not respond in time.` : `${name} declined your order${reason ? ` (${reason})` : ''}.`;
    return { ...base, kind: 'REJECTED', reason, message: `${lead} ${refundSentence(c)}` };
  }
  if (c.status === 'CANCELLED') {
    const reason = c.cancellationReason ?? null;
    const lead =
      c.cancelledBy === 'CUSTOMER'
        ? `You cancelled your ${name} order.`
        : `Your ${name} order was cancelled by Thali support${reason ? ` (${reason})` : ''}.`;
    return { ...base, kind: 'CANCELLED', reason, message: `${lead} ${refundSentence(c)}` };
  }
  if (c.status === 'DELIVERY_FAILED') {
    const reason = c.deliveryFailureReason ?? null;
    return {
      ...base,
      kind: 'DELIVERY_FAILED',
      reason,
      message: `Delivery of your ${name} order failed${reason ? ` (${reason})` : ''}. Our support team is reviewing it and will update you about a refund.`,
    };
  }
  return null;
}

export function explanations(children: ExplainableChild[]): Explanation[] {
  return children.map(explainChild).filter((x): x is Explanation => x !== null);
}

export interface AdjustedTotals {
  paidPaise: number;
  refundedPaise: number;
  refundPendingPaise: number;
  netPaise: number;
}

export function adjustedTotals(
  group: Pick<CheckoutGroup, 'pricing' | 'placedAt'>,
  children: Pick<ChildOrder, 'refundRequestedPaise' | 'refundedPaise'>[],
): AdjustedTotals {
  const paidPaise = group.placedAt ? group.pricing.totalPaise : 0;
  const refundedPaise = children.reduce((s, c) => s + (c.refundedPaise ?? 0), 0);
  const refundPendingPaise = children.reduce((s, c) => s + Math.max(0, (c.refundRequestedPaise ?? 0) - (c.refundedPaise ?? 0)), 0);
  return { paidPaise, refundedPaise, refundPendingPaise, netPaise: paidPaise - refundedPaise };
}
