/**
 * Atomic reservations (LLD §8 step 6, ADR-004) and their lifecycle.
 *
 * `reserve` runs ONE Mongo transaction:
 *   1. insert the `stock_reservations` doc first (unique `checkoutId`) — a concurrent duplicate either
 *      write-conflicts (retried by the driver, then sees the committed doc) or hits E11000, after which
 *      the stored result is replayed. So a checkoutId reserves stock exactly once.
 *   2. per tracked item: `$inc reservedQty` guarded by `$expr: stockQty - reservedQty >= qty`.
 *      No match → 409 OUT_OF_STOCK and the whole transaction (incl. earlier lines) aborts.
 *   3. coupon: per-user count (HELD + REDEEMED) < perUserLimit, then `$inc heldCount` guarded by
 *      `usedCount + heldCount < totalLimit`. Every hold writes the coupon doc, so two concurrent holds
 *      for the same coupon always write-conflict: the loser retries on a fresh snapshot and re-counts —
 *      no write skew on the per-user check either. Fail → 422 COUPON_LIMIT_REACHED / COUPON_INVALID.
 *   4. membership: usage HELD pushed with `$inc freeDeliveriesHeld` guarded by
 *      `freeDeliveriesUsed + freeDeliveriesHeld + n <= quota`, ACTIVE, owned by the user, in term.
 *      Fail → 409 CONFLICT (`details.reason = MEMBERSHIP_UNAVAILABLE`).
 *
 * Lifecycle (event handlers / sweeper, each inside the caller's transaction, each guarded by a
 * conditional status update so concurrent handler + sweeper apply exactly once):
 *   commit  HELD → COMMITTED: stockQty -= qty, reservedQty -= qty; coupon REDEEMED (usedCount++, heldCount--);
 *           membership usage USED (used += n, held -= n).
 *   release HELD → RELEASED: reservedQty -= qty; coupon RELEASED (heldCount--); usage RELEASED (held -= n).
 *           Unknown checkoutId (orders' orphan releases) → no-op.
 *   closeChild (order.rejected / order.cancelled) after commit: restock that restaurant's tracked lines
 *           once per child; when every child of the checkout is closed, release the coupon (LLD §6).
 */
import { Types, type ClientSession } from 'mongoose';
import { DomainError } from '@thali/contracts';
import { withTransaction } from '@thali/service-kit';
import type { AppContext } from '../context.js';
import type { StockReservationDoc } from '../models/stock-reservation.js';
import { assertCouponLive, couponInvalid, couponLimit, firstOrderUsed, normalizeCode, userRedemptionCount, type CouponLean } from './coupons.js';

export type ReservationLean = StockReservationDoc & { _id: Types.ObjectId };

export interface ReserveInput {
  checkoutId: string;
  userId: string;
  lines: { restaurantId: string; itemId: string; qty: number }[];
  couponCode?: string;
  couponDiscountPaise: number;
  membership?: { membershipId: string; freeDeliveries: number; discountPaise: number };
  ttlSec: number;
}

export interface ReserveResult {
  checkoutId: string;
  status: string;
  expiresAt: string;
}

const resultOf = (r: Pick<ReservationLean, 'checkoutId' | 'status' | 'expiresAt'>): ReserveResult => ({
  checkoutId: r.checkoutId,
  status: r.status,
  expiresAt: new Date(r.expiresAt).toISOString(),
});

function replay(existing: ReservationLean, userId: string): ReserveResult {
  if (existing.userId !== userId) throw new DomainError('CONFLICT', 'checkoutId already used by another reservation');
  // a released hold must never be mistaken for a live one by a retrying caller
  if (existing.status === 'RELEASED') throw new DomainError('CONFLICT', 'This reservation was already released', undefined, { reason: 'RESERVATION_RELEASED' });
  return resultOf(existing);
}

const oid = (id: string) => new Types.ObjectId(id);

/** Merge duplicate (restaurant, item) lines (orders already aggregates; defensive). */
function aggregate(lines: ReserveInput['lines']) {
  const m = new Map<string, { restaurantId: string; itemId: string; qty: number }>();
  for (const l of lines) {
    const k = `${l.restaurantId}|${l.itemId}`;
    const cur = m.get(k);
    if (cur) cur.qty += l.qty;
    else m.set(k, { ...l });
  }
  return [...m.values()];
}

export async function reserve(ctx: AppContext, input: ReserveInput): Promise<ReserveResult> {
  const existing = await ctx.models.StockReservation.findOne({ checkoutId: input.checkoutId }).lean<ReservationLean>();
  if (existing) return replay(existing, input.userId);
  const lines = aggregate(input.lines);

  try {
    return await withTransaction(ctx.conn, async (session) => {
      const now = ctx.now();
      const expiresAt = new Date(now.getTime() + input.ttlSec * 1000);
      const [doc] = await ctx.models.StockReservation.create([{ checkoutId: input.checkoutId, userId: input.userId, status: 'HELD', expiresAt, lines: [] }], { session });

      // 1) stock
      const held: { restaurantId: string; itemId: string; qty: number; tracked: boolean }[] = [];
      for (const l of lines) {
        const item = await ctx.models.MenuItem.findOne({ _id: oid(l.itemId), restaurantId: oid(l.restaurantId) }, { trackStock: 1, name: 1 })
          .session(session)
          .lean<{ trackStock?: boolean; name: string }>();
        if (!item) {
          throw new DomainError('ITEM_UNAVAILABLE', 'An item is no longer on the menu', undefined, {
            problems: [{ code: 'ITEM_UNAVAILABLE', restaurantId: l.restaurantId, itemId: l.itemId, message: 'This item is no longer on the menu' }],
          });
        }
        if (item.trackStock) {
          const upd = await ctx.models.MenuItem.updateOne(
            { _id: oid(l.itemId), restaurantId: oid(l.restaurantId), trackStock: true, $expr: { $gte: [{ $subtract: ['$stockQty', '$reservedQty'] }, l.qty] } },
            { $inc: { reservedQty: l.qty } },
            { session },
          );
          if (upd.modifiedCount !== 1) {
            throw new DomainError('OUT_OF_STOCK', `${item.name} is out of stock`, undefined, {
              problems: [{ code: 'OUT_OF_STOCK', restaurantId: l.restaurantId, itemId: l.itemId, message: `Not enough ${item.name} left` }],
            });
          }
        }
        held.push({ ...l, tracked: !!item.trackStock });
      }

      // 2) coupon
      let couponId: unknown;
      let couponCode: string | undefined;
      if (input.couponCode) {
        couponCode = normalizeCode(input.couponCode);
        const c = await ctx.models.Coupon.findOne({ code: couponCode }).session(session).lean<CouponLean>();
        assertCouponLive(c, now);
        if (c.firstOrderOnly && (await firstOrderUsed(ctx, input.userId, session))) throw couponInvalid('FIRST_ORDER_ONLY', 'This coupon is valid on your first order only');
        if (c.perUserLimit != null && (await userRedemptionCount(ctx, c._id, input.userId, session)) >= c.perUserLimit) {
          throw couponLimit('PER_USER_LIMIT', 'You have already used this coupon');
        }
        const upd = await ctx.models.Coupon.updateOne(
          {
            _id: c._id,
            active: true,
            $expr: { $or: [{ $eq: [{ $ifNull: ['$totalLimit', null] }, null] }, { $lt: [{ $add: ['$usedCount', '$heldCount'] }, '$totalLimit'] }] },
          },
          { $inc: { heldCount: 1 } },
          { session },
        );
        if (upd.modifiedCount !== 1) throw couponLimit('TOTAL_LIMIT', 'This coupon has been fully used');
        await ctx.models.CouponRedemption.create(
          [
            {
              couponId: c._id,
              code: c.code,
              userId: input.userId,
              checkoutId: input.checkoutId,
              status: 'HELD',
              discountPaise: input.couponDiscountPaise,
              expiresAt,
              ...(c.firstOrderOnly ? { firstOrderGuard: true } : {}),
            },
          ],
          { session },
        );
        couponId = c._id;
      }

      // 3) membership usage
      if (input.membership) {
        const m = input.membership;
        const upd = Types.ObjectId.isValid(m.membershipId)
          ? await ctx.models.Membership.updateOne(
              {
                _id: oid(m.membershipId),
                userId: input.userId,
                status: 'ACTIVE',
                startsAt: { $lte: now },
                endsAt: { $gt: now },
                'usage.checkoutId': { $ne: input.checkoutId },
                $expr: { $lte: [{ $add: ['$freeDeliveriesUsed', '$freeDeliveriesHeld', m.freeDeliveries] }, '$planSnapshot.benefits.freeDeliveriesPerPeriod'] },
              },
              {
                $inc: { freeDeliveriesHeld: m.freeDeliveries },
                $push: { usage: { checkoutId: input.checkoutId, freeDeliveries: m.freeDeliveries, discountPaise: m.discountPaise, status: 'HELD', at: now } },
              },
              { session },
            )
          : { modifiedCount: 0 };
        if (upd.modifiedCount !== 1) {
          throw new DomainError('CONFLICT', 'Membership benefit is no longer available', undefined, { reason: 'MEMBERSHIP_UNAVAILABLE' });
        }
      }

      await ctx.models.StockReservation.updateOne(
        { _id: doc!._id },
        {
          $set: {
            lines: held,
            ...(couponCode ? { couponCode, couponId, couponDiscountPaise: input.couponDiscountPaise } : {}),
            ...(input.membership
              ? { membershipId: oid(input.membership.membershipId), membershipFreeDeliveries: input.membership.freeDeliveries, membershipDiscountPaise: input.membership.discountPaise }
              : {}),
          },
        },
        { session },
      );
      return resultOf({ checkoutId: input.checkoutId, status: 'HELD', expiresAt });
    });
  } catch (e) {
    const dup = e as { code?: number; keyPattern?: Record<string, unknown> };
    if (dup?.code === 11000 && dup.keyPattern && 'userId' in dup.keyPattern) {
      // first_order_guard: a concurrent checkout of this user holds another first-order coupon
      throw couponInvalid('FIRST_ORDER_ONLY', 'This coupon is valid on your first order only');
    }
    if (dup?.code === 11000) {
      const winner = await ctx.models.StockReservation.findOne({ checkoutId: input.checkoutId }).lean<ReservationLean>();
      if (winner) return replay(winner, input.userId);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------
// lifecycle (all inside the caller's transaction)

async function maybeReleaseCoupon(ctx: AppContext, session: ClientSession, r: Pick<ReservationLean, 'checkoutId' | 'couponId' | 'childOrderIds' | 'closedChildIds'>) {
  const children = r.childOrderIds ?? [];
  if (!r.couponId || !children.length) return;
  const closed = new Set(r.closedChildIds ?? []);
  if (!children.every((c) => closed.has(c))) return;
  const red = await ctx.models.CouponRedemption.findOneAndUpdate(
    { checkoutId: r.checkoutId, status: 'REDEEMED' },
    { $set: { status: 'RELEASED' }, $unset: { firstOrderGuard: 1 } },
    { session },
  );
  if (red) await ctx.models.Coupon.updateOne({ _id: red.couponId }, { $inc: { usedCount: -1 } }, { session });
}

export type CommitOutcome = 'COMMITTED' | 'ALREADY_COMMITTED' | 'RELEASED' | 'MISSING';

export async function commitReservation(ctx: AppContext, session: ClientSession, checkoutId: string, childOrderIds?: string[]): Promise<CommitOutcome> {
  const now = ctx.now();
  const r = await ctx.models.StockReservation.findOneAndUpdate(
    { checkoutId, status: 'HELD' },
    { $set: { status: 'COMMITTED', committedAt: now, ...(childOrderIds?.length ? { childOrderIds } : {}) } },
    { session, new: true },
  ).lean<ReservationLean>();
  if (!r) {
    const cur = await ctx.models.StockReservation.findOne({ checkoutId }).session(session).lean<ReservationLean>();
    if (!cur) return 'MISSING';
    if (cur.status === 'COMMITTED') {
      if (childOrderIds?.length && !(cur.childOrderIds ?? []).length) {
        const upd = await ctx.models.StockReservation.findOneAndUpdate({ _id: cur._id }, { $set: { childOrderIds } }, { session, new: true }).lean<ReservationLean>();
        if (upd) await maybeReleaseCoupon(ctx, session, upd);
      }
      return 'ALREADY_COMMITTED';
    }
    return 'RELEASED';
  }
  for (const l of r.lines.filter((x) => x.tracked)) {
    await ctx.models.MenuItem.updateOne({ _id: oid(l.itemId) }, { $inc: { stockQty: -l.qty, reservedQty: -l.qty } }, { session });
  }
  const red = await ctx.models.CouponRedemption.findOneAndUpdate({ checkoutId, status: 'HELD' }, { $set: { status: 'REDEEMED' } }, { session });
  if (red) await ctx.models.Coupon.updateOne({ _id: red.couponId }, { $inc: { usedCount: 1, heldCount: -1 } }, { session });
  if (r.membershipId) {
    const n = r.membershipFreeDeliveries ?? 0;
    await ctx.models.Membership.updateOne(
      { _id: r.membershipId, usage: { $elemMatch: { checkoutId, status: 'HELD' } } },
      { $set: { 'usage.$.status': 'USED' }, $inc: { freeDeliveriesHeld: -n, freeDeliveriesUsed: n } },
      { session },
    );
  }
  return 'COMMITTED';
}

export async function releaseReservation(ctx: AppContext, session: ClientSession, checkoutId: string, reason: string): Promise<boolean> {
  const r = await ctx.models.StockReservation.findOneAndUpdate(
    { checkoutId, status: 'HELD' },
    { $set: { status: 'RELEASED', releasedAt: ctx.now(), releaseReason: reason } },
    { session, new: true },
  ).lean<ReservationLean>();
  if (!r) return false; // unknown (orphan release), already released, or committed
  for (const l of r.lines.filter((x) => x.tracked)) {
    await ctx.models.MenuItem.updateOne({ _id: oid(l.itemId) }, { $inc: { reservedQty: -l.qty } }, { session });
  }
  const red = await ctx.models.CouponRedemption.findOneAndUpdate(
    { checkoutId, status: 'HELD' },
    { $set: { status: 'RELEASED' }, $unset: { firstOrderGuard: 1 } },
    { session },
  );
  if (red) await ctx.models.Coupon.updateOne({ _id: red.couponId }, { $inc: { heldCount: -1 } }, { session });
  if (r.membershipId) {
    const n = r.membershipFreeDeliveries ?? 0;
    await ctx.models.Membership.updateOne(
      { _id: r.membershipId, usage: { $elemMatch: { checkoutId, status: 'HELD' } } },
      { $set: { 'usage.$.status': 'RELEASED' }, $inc: { freeDeliveriesHeld: -n } },
      { session },
    );
  }
  return true;
}

/**
 * A child order left the fulfilment path (rejected / cancelled). Restock its restaurant's tracked lines
 * (when `restock`), at most once per child. If the reservation is still HELD the confirmation was
 * overtaken (the child was PLACED, so payment was captured) → commit first.
 */
export async function closeChild(
  ctx: AppContext,
  session: ClientSession,
  input: { checkoutId: string; childOrderId: string; restaurantId: string; restock: boolean },
): Promise<'CLOSED' | 'DUPLICATE' | 'MISSING' | 'RELEASED'> {
  let r = await ctx.models.StockReservation.findOne({ checkoutId: input.checkoutId }).session(session).lean<ReservationLean>();
  if (!r) return 'MISSING';
  if (r.status === 'HELD') {
    await commitReservation(ctx, session, input.checkoutId);
    r = (await ctx.models.StockReservation.findOne({ _id: r._id }).session(session).lean<ReservationLean>())!;
  }
  if (r.status === 'RELEASED') return 'RELEASED';
  const marked = await ctx.models.StockReservation.findOneAndUpdate(
    { _id: r._id, closedChildIds: { $ne: input.childOrderId } },
    { $push: { closedChildIds: input.childOrderId, ...(input.restock ? { restockedChildIds: input.childOrderId } : {}) } },
    { session, new: true },
  ).lean<ReservationLean>();
  if (!marked) return 'DUPLICATE';
  if (input.restock) {
    for (const l of marked.lines.filter((x) => x.tracked && x.restaurantId === input.restaurantId)) {
      await ctx.models.MenuItem.updateOne({ _id: oid(l.itemId) }, { $inc: { stockQty: l.qty } }, { session });
    }
  }
  await maybeReleaseCoupon(ctx, session, marked);
  return 'CLOSED';
}

/** Convenience wrappers running the lifecycle steps in their own transaction (sweeper). */
export const commitInTxn = (ctx: AppContext, checkoutId: string) => withTransaction(ctx.conn, (s) => commitReservation(ctx, s, checkoutId));
export const releaseInTxn = (ctx: AppContext, checkoutId: string, reason: string) => withTransaction(ctx.conn, (s) => releaseReservation(ctx, s, checkoutId, reason));
