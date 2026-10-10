/**
 * Restaurant order stats (binding internal shape; also `GET /owner/orders/stats`) and the admin
 * orders overview — computed from stored child orders, never cached or estimated.
 *
 * Definitions (restaurant stats, window applies to `placedAt` — only orders the restaurant saw):
 *  - ordersTotal: children placed in [from, to]; byStatus: their current status (all 13 keys)
 *  - acceptanceRate: accepted ÷ (accepted + rejected incl. timeouts); null when nothing decided
 *  - avgAcceptSeconds: mean(acceptedAt − placedAt) over accepted ones, rounded; null when none
 *  - grossPaise: Σ (itemsSubtotal + packaging) over DELIVERED children
 *  - netRevenuePaise: Σ restaurant earning − commission over DELIVERED children, exactly as the
 *    payments ledger posts it (items − coupon − membership + packaging − bpsOf(items, commissionBps))
 *
 * Admin overview "today" (since IST midnight) additions for the redesign (ORD-2):
 *  - today.byStatus: children placed today by CURRENT status (all 13 keys) — the status bar cohort
 *  - today.refundedPaise: Σ child refund mirror entries (`refunds[]`) SUCCEEDED today (entry `updatedAt`)
 *  - today.refundPendingPaise: Σ (requested − refunded) over children placed today whose refund is
 *    still REQUESTED / PROCESSING (FAILED is counted by `refundsFailed`, not as pending)
 *  - support: open / in-progress ticket counts (admin sidebar badge)
 */
import { bpsOf, enumValues, ChildOrderStatus } from '@thali/contracts';
import type { OrdersContext } from '../context.js';
import type { ChildOrder } from '../models/child-order.js';

export interface RestaurantStats {
  restaurantId: string;
  from: string;
  to: string;
  ordersTotal: number;
  byStatus: Record<ChildOrderStatus, number>;
  acceptanceRate: number | null;
  avgAcceptSeconds: number | null;
  grossPaise: number;
  netRevenuePaise: number;
}

const ALL_STATUSES = enumValues(ChildOrderStatus) as ChildOrderStatus[];
const zeroByStatus = () => Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<ChildOrderStatus, number>;

export async function restaurantStats(
  ctx: OrdersContext,
  q: { restaurantId: string; from: Date; to: Date; restaurantOwnerId?: string },
): Promise<RestaurantStats> {
  const filter: Record<string, unknown> = { restaurantId: q.restaurantId, placedAt: { $gte: q.from, $lte: q.to } };
  if (q.restaurantOwnerId !== undefined) filter.restaurantOwnerId = q.restaurantOwnerId;
  const rows = await ctx.models.ChildOrder.find(filter, { status: 1, placedAt: 1, acceptedAt: 1, breakdown: 1, commissionBps: 1 }).lean<
    Pick<ChildOrder, 'status' | 'placedAt' | 'acceptedAt' | 'breakdown' | 'commissionBps'>[]
  >();

  const byStatus = zeroByStatus();
  let accepted = 0;
  let rejected = 0;
  let acceptMsSum = 0;
  let grossPaise = 0;
  let netRevenuePaise = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.acceptedAt) {
      accepted++;
      if (r.placedAt) acceptMsSum += Math.max(0, new Date(r.acceptedAt).getTime() - new Date(r.placedAt).getTime());
    } else if (r.status === 'REJECTED') rejected++;
    if (r.status === 'DELIVERED') {
      const b = r.breakdown;
      grossPaise += b.itemsSubtotalPaise + b.packagingFeePaise;
      netRevenuePaise += b.itemsSubtotalPaise - b.couponDiscountPaise - b.membershipDiscountPaise + b.packagingFeePaise - bpsOf(b.itemsSubtotalPaise, r.commissionBps);
    }
  }
  return {
    restaurantId: q.restaurantId,
    from: q.from.toISOString(),
    to: q.to.toISOString(),
    ordersTotal: rows.length,
    byStatus,
    acceptanceRate: accepted + rejected > 0 ? accepted / (accepted + rejected) : null,
    avgAcceptSeconds: accepted > 0 ? Math.round(acceptMsSum / accepted / 1000) : null,
    grossPaise,
    netRevenuePaise,
  };
}

const IST_OFFSET_MS = 330 * 60_000;

/** Start of the current day in Asia/Kolkata, as a UTC Date. */
export function istDayStart(now = new Date()): Date {
  const ist = now.getTime() + IST_OFFSET_MS;
  return new Date(ist - (ist % 86_400_000) - IST_OFFSET_MS);
}

const ACTIVE: ChildOrderStatus[] = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED'];

export async function ordersOverview(ctx: OrdersContext, now = new Date()) {
  const since = istDayStart(now);
  const { ChildOrder: C, CheckoutGroup: G } = ctx.models;
  const { SupportTicket: T } = ctx.models;
  const [active, placed, delivered, rejected, cancelled, overdue, refundsPending, refundsFailed, gmv, todayByStatus, refunded, pending, ticketsOpen, ticketsInProgress] = await Promise.all([
    C.aggregate<{ _id: ChildOrderStatus; n: number }>([{ $match: { status: { $in: ACTIVE } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    C.countDocuments({ placedAt: { $gte: since } }),
    C.countDocuments({ deliveredAt: { $gte: since } }),
    C.countDocuments({ status: 'REJECTED', statusHistory: { $elemMatch: { to: 'REJECTED', at: { $gte: since } } } }),
    C.countDocuments({ status: 'CANCELLED', cancelledAt: { $gte: since } }),
    C.countDocuments({ status: 'PLACED', acceptBy: { $lt: now } }),
    C.countDocuments({ refundStatus: { $in: ['REQUESTED', 'PROCESSING', 'FAILED'] } }),
    C.countDocuments({ refundStatus: 'FAILED' }),
    G.aggregate<{ _id: null; n: number; gmv: number }>([
      { $match: { placedAt: { $gte: since } } },
      { $group: { _id: null, n: { $sum: 1 }, gmv: { $sum: '$pricing.totalPaise' } } },
    ]),
    C.aggregate<{ _id: ChildOrderStatus; n: number }>([{ $match: { placedAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    C.aggregate<{ _id: null; paise: number }>([
      { $match: { 'refunds.updatedAt': { $gte: since } } },
      { $unwind: '$refunds' },
      { $match: { 'refunds.status': 'SUCCEEDED', 'refunds.updatedAt': { $gte: since } } },
      { $group: { _id: null, paise: { $sum: '$refunds.amountPaise' } } },
    ]),
    C.aggregate<{ _id: null; paise: number }>([
      { $match: { placedAt: { $gte: since }, refundStatus: { $in: ['REQUESTED', 'PROCESSING'] } } },
      {
        $group: {
          _id: null,
          paise: { $sum: { $max: [0, { $subtract: [{ $ifNull: ['$refundRequestedPaise', 0] }, { $ifNull: ['$refundedPaise', 0] }] }] } },
        },
      },
    ]),
    T.countDocuments({ status: 'OPEN' }),
    T.countDocuments({ status: 'IN_PROGRESS' }),
  ]);
  const byStatus = zeroByStatus();
  for (const s of todayByStatus) byStatus[s._id] = s.n;
  const activeByStatus = Object.fromEntries(ACTIVE.map((s) => [s, 0])) as Record<string, number>;
  for (const a of active) activeByStatus[a._id] = a.n;
  return {
    generatedAt: now.toISOString(),
    today: {
      since: since.toISOString(),
      checkouts: gmv[0]?.n ?? 0,
      placed,
      delivered,
      rejected,
      cancelled,
      gmvPaise: gmv[0]?.gmv ?? 0,
      byStatus,
      refundedPaise: refunded[0]?.paise ?? 0,
      refundPendingPaise: pending[0]?.paise ?? 0,
    },
    activeByStatus,
    awaitingAcceptance: activeByStatus.PLACED ?? 0,
    overdueAcceptance: overdue,
    deliveryFailed: activeByStatus.DELIVERY_FAILED ?? 0,
    refundsPending,
    refundsFailed,
    support: { open: ticketsOpen, inProgress: ticketsInProgress },
  };
}
