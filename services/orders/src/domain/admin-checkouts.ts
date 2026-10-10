/**
 * ORD-1: checkout-level admin order list (`GET /admin/orders/checkouts`) for the admin overview's
 * "Recent orders" table: one row per checkout with every restaurant, the derived checkout status,
 * paid / refunded / refund-pending totals and an `attention` flag.
 *
 * Order: `placedAt desc, _id desc` (newest placed first). Never-placed checkouts (AWAITING_PAYMENT,
 * PAYMENT_FAILED, EXPIRED; `placedAt = null`) are only listed when `status` asks for them, and then
 * sort after every placed one. `from` / `to` apply to `placedAt` (to `createdAt` for never-placed).
 * Cursor = base64url JSON `{p: placedAt ISO | null, i: _id}`.
 *
 * Cost per page: one indexed `checkout_groups` query + one `$in` fetch of the page's children
 * (+ one `distinct` on `child_orders` when filtering by restaurant / child code / name prefix).
 */
import { Types } from 'mongoose';
import { DomainError, type CheckoutStatus, type ChildOrderStatus } from '@thali/contracts';
import type { OrdersContext } from '../context.js';
import type { CheckoutGroup } from '../models/checkout-group.js';
import type { ChildOrder } from '../models/child-order.js';
import { adjustedTotals } from './derive.js';

export type CheckoutAttention = 'DELIVERY_FAILED' | 'REFUND_FAILED' | 'FINDING_PARTNER' | 'AWAITING_ACCEPTANCE';
export const CHECKOUT_ATTENTION: readonly CheckoutAttention[] = ['DELIVERY_FAILED', 'REFUND_FAILED', 'FINDING_PARTNER', 'AWAITING_ACCEPTANCE'];

const AFTER_ACCEPT: ChildOrderStatus[] = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'];
const NO_PARTNER_YET = new Set<string | null>([null, 'PENDING_ASSIGNMENT', 'OFFERED']);

/**
 * The most urgent thing about a checkout, most severe first: a child whose delivery failed, a failed
 * refund, an accepted child still without a partner (`deliveryStatus` null / PENDING_ASSIGNMENT /
 * OFFERED), a child the restaurant has not accepted yet. null = nothing to do.
 */
export function checkoutAttention(children: Pick<ChildOrder, 'status' | 'deliveryStatus' | 'refundStatus'>[]): CheckoutAttention | null {
  if (children.some((c) => c.status === 'DELIVERY_FAILED')) return 'DELIVERY_FAILED';
  if (children.some((c) => c.refundStatus === 'FAILED')) return 'REFUND_FAILED';
  if (children.some((c) => AFTER_ACCEPT.includes(c.status) && NO_PARTNER_YET.has(c.deliveryStatus ?? null))) return 'FINDING_PARTNER';
  if (children.some((c) => c.status === 'PLACED')) return 'AWAITING_ACCEPTANCE';
  return null;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function adminCheckoutRow(g: CheckoutGroup, children: ChildOrder[]) {
  const sorted = [...children].sort((a, b) => (a.restaurantId < b.restaurantId ? -1 : a.restaurantId > b.restaurantId ? 1 : 0));
  const contact = g.customerContact ?? sorted[0]?.customerContact ?? null;
  const totals = adjustedTotals(g, children);
  return {
    id: String(g._id),
    code: g.code,
    status: g.status,
    userId: g.userId,
    placedAt: iso(g.placedAt),
    createdAt: iso(g.createdAt),
    customer: { name: contact?.name ?? '', phoneMasked: contact?.phoneMasked ?? '' },
    restaurants: sorted.map((c) => ({
      id: c.restaurantId,
      childOrderId: String(c._id),
      childCode: c.code,
      name: c.restaurantName,
      childStatus: c.status,
      deliveryStatus: c.deliveryStatus ?? null,
      refundStatus: c.refundStatus,
    })),
    totalPaise: g.pricing.totalPaise,
    paidPaise: totals.paidPaise,
    refundedPaise: totals.refundedPaise,
    refundPendingPaise: totals.refundPendingPaise,
    attention: checkoutAttention(children),
  };
}
export type AdminCheckoutRow = ReturnType<typeof adminCheckoutRow>;

// ------------------------------------------------------------------------- cursor

interface Position {
  placedAt: Date | null;
  _id: Types.ObjectId;
}

const badCursor = () =>
  new DomainError('VALIDATION_FAILED', 'Invalid cursor', 400, { issues: [{ path: 'query.cursor', code: 'invalid_format', message: 'Invalid cursor' }] });

export function encodeCheckoutCursor(pos: Position): string {
  return Buffer.from(JSON.stringify({ p: pos.placedAt ? pos.placedAt.toISOString() : null, i: pos._id.toHexString() }), 'utf8').toString('base64url');
}

export function decodeCheckoutCursor(cursor: string): Position {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw badCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  const { p, i } = (parsed ?? {}) as { p?: unknown; i?: unknown };
  if (typeof i !== 'string' || !/^[0-9a-f]{24}$/i.test(i)) throw badCursor();
  if (p !== null && typeof p !== 'string') throw badCursor();
  const placedAt = p === null ? null : new Date(p);
  if (placedAt && Number.isNaN(placedAt.getTime())) throw badCursor();
  return { placedAt, _id: new Types.ObjectId(i) };
}

/** Rows strictly after `pos` in `placedAt desc, _id desc` order (nulls last). */
function afterCursor(pos: Position): Record<string, unknown> {
  if (!pos.placedAt) return { placedAt: null, _id: { $lt: pos._id } };
  return { $or: [{ placedAt: { $lt: pos.placedAt } }, { placedAt: pos.placedAt, _id: { $lt: pos._id } }, { placedAt: null }] };
}

// ------------------------------------------------------------------------- query

export interface AdminCheckoutsQuery {
  q?: string;
  status?: CheckoutStatus[];
  phone4?: string;
  restaurantId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function groupIdsOfChildren(ctx: OrdersContext, filter: Record<string, unknown>): Promise<Types.ObjectId[]> {
  return (await ctx.models.ChildOrder.distinct('checkoutGroupId', filter)) as Types.ObjectId[];
}

/** `q`: a phone (already reduced to `phone4` by the caller), TH- code (checkout or child), an id, or a restaurant name prefix. */
async function termFilter(ctx: OrdersContext, term: string): Promise<Record<string, unknown>> {
  if (/^TH-/i.test(term)) {
    const code = term.toUpperCase();
    return { $or: [{ code }, { _id: { $in: await groupIdsOfChildren(ctx, { code }) } }] };
  }
  if (/^[0-9a-f]{24}$/i.test(term)) {
    const id = new Types.ObjectId(term);
    const viaChildren = await groupIdsOfChildren(ctx, { $or: [{ _id: id }, { restaurantId: term }] });
    return { $or: [{ _id: id }, { userId: term }, { _id: { $in: viaChildren } }] };
  }
  return { _id: { $in: await groupIdsOfChildren(ctx, { restaurantName: { $regex: `^${escapeRegex(term)}`, $options: 'i' } }) } };
}

export async function listAdminCheckouts(ctx: OrdersContext, q: AdminCheckoutsQuery) {
  const and: Record<string, unknown>[] = [];
  if (q.status?.length) and.push({ status: { $in: q.status } });
  else and.push({ placedAt: { $ne: null } });
  if (q.phone4) and.push({ 'customerContact.phoneLast4': q.phone4 });
  if (q.q) and.push(await termFilter(ctx, q.q));
  if (q.restaurantId) and.push({ _id: { $in: await groupIdsOfChildren(ctx, { restaurantId: q.restaurantId }) } });
  if (q.from || q.to) {
    const range = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lte: new Date(q.to) } : {}) };
    and.push({ $or: [{ placedAt: range }, { placedAt: null, createdAt: range }] });
  }
  if (q.cursor) and.push(afterCursor(decodeCheckoutCursor(q.cursor)));

  const groups = await ctx.models.CheckoutGroup.find({ $and: and })
    .sort({ placedAt: -1, _id: -1 })
    .limit(q.limit + 1)
    .lean<CheckoutGroup[]>();
  const page = groups.slice(0, q.limit);
  const children = page.length
    ? await ctx.models.ChildOrder.find({ checkoutGroupId: { $in: page.map((g) => g._id) } }).lean<ChildOrder[]>()
    : [];
  const byGroup = new Map<string, ChildOrder[]>();
  for (const c of children) {
    const k = String(c.checkoutGroupId);
    byGroup.set(k, [...(byGroup.get(k) ?? []), c]);
  }
  const last = page[page.length - 1];
  return {
    items: page.map((g) => adminCheckoutRow(g, byGroup.get(String(g._id)) ?? [])),
    nextCursor: groups.length > q.limit && last ? encodeCheckoutCursor({ placedAt: last.placedAt ?? null, _id: last._id }) : null,
  };
}
