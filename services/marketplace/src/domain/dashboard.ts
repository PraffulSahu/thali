/**
 * Owner dashboard + admin overview — every number comes from stored records (context §4 "Dashboard
 * metrics calculated from actual stored records"). Order metrics are owned by orders and fetched from
 * `GET /internal/orders/stats`; if orders is unreachable the dashboard still renders menu/rating data
 * with `orders: null, ordersAvailable: false` (never invented numbers).
 */
import { Types } from 'mongoose';
import type { AppContext } from '../context.js';
import { findOwned } from './onboarding.js';
import { isOpenAt } from './open-status.js';
import { ratingOf, type RestaurantLean } from './restaurant-view.js';

export const LOW_STOCK_THRESHOLD = 5;
const DAY_MS = 86_400_000;

export async function ownerDashboard(ctx: AppContext, restaurantId: string, ownerUserId: string, range: { from?: Date; to?: Date }) {
  const doc = await findOwned(ctx, restaurantId, ownerUserId);
  const r = doc.toObject() as RestaurantLean;
  const to = range.to ?? ctx.now();
  const from = range.from ?? new Date(to.getTime() - 30 * DAY_MS);
  const rid = new Types.ObjectId(restaurantId);

  const [orders, menuAgg, lowStock] = await Promise.all([
    ctx.orders.getStats({ restaurantId, from: from.toISOString(), to: to.toISOString() }).catch((err: unknown) => {
      ctx.logger.warn({ err, restaurantId }, 'orders stats unavailable for dashboard');
      return null;
    }),
    ctx.models.MenuItem.aggregate<{ total: number; unavailable: number; outOfStock: number }>([
      { $match: { restaurantId: rid } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          unavailable: { $sum: { $cond: [{ $eq: ['$available', false] }, 1, 0] } },
          outOfStock: { $sum: { $cond: [{ $and: ['$trackStock', { $lte: [{ $subtract: ['$stockQty', '$reservedQty'] }, 0] }] }, 1, 0] } },
        },
      },
    ]),
    ctx.models.MenuItem.aggregate<{ _id: unknown; name: string; availableQty: number }>([
      { $match: { restaurantId: rid, trackStock: true } },
      { $project: { name: 1, availableQty: { $subtract: ['$stockQty', '$reservedQty'] } } },
      { $match: { availableQty: { $gt: 0, $lte: LOW_STOCK_THRESHOLD } } },
      { $sort: { availableQty: 1, name: 1 } },
      { $limit: 20 },
    ]),
  ]);
  const open = isOpenAt(r, ctx.now());
  const m = menuAgg[0] ?? { total: 0, unavailable: 0, outOfStock: 0 };
  return {
    restaurant: {
      id: restaurantId,
      name: r.name,
      status: r.status,
      open: open.open,
      ...(open.reason ? { closedReason: open.reason } : {}),
      pausedUntil: r.pausedUntil ? new Date(r.pausedUntil).toISOString() : null,
    },
    period: { from: from.toISOString(), to: to.toISOString() },
    orders,
    ordersAvailable: orders !== null,
    rating: ratingOf(r),
    ratingCount: r.ratingCount ?? 0,
    menu: {
      itemsTotal: m.total,
      itemsUnavailable: m.unavailable,
      itemsOutOfStock: m.outOfStock,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      lowStock: lowStock.map((x) => ({ itemId: String(x._id), name: x.name, availableQty: x.availableQty })),
    },
  };
}

export async function adminOverview(ctx: AppContext) {
  const now = ctx.now();
  const count = <T>(rows: { _id: T; n: number }[]) => Object.fromEntries(rows.map((x) => [String(x._id), x.n])) as Record<string, number>;
  const [byStatus, couponsTotal, couponsActive, redemptions, membershipsBy, held, ratings, items] = await Promise.all([
    ctx.models.Restaurant.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ctx.models.Coupon.countDocuments({}),
    ctx.models.Coupon.countDocuments({ active: true, validFrom: { $lte: now }, validTo: { $gte: now } }),
    ctx.models.CouponRedemption.aggregate<{ _id: string; n: number; discountPaise: number }>([{ $group: { _id: '$status', n: { $sum: 1 }, discountPaise: { $sum: '$discountPaise' } } }]),
    ctx.models.Membership.aggregate<{ _id: string; n: number }>([
      { $match: { $or: [{ status: { $ne: 'ACTIVE' } }, { endsAt: { $gt: now } }] } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    ctx.models.StockReservation.countDocuments({ status: 'HELD' }),
    ctx.models.Rating.countDocuments({}),
    ctx.models.MenuItem.countDocuments({}),
  ]);
  const restaurants = count(byStatus);
  const redeemed = redemptions.find((x) => x._id === 'REDEEMED');
  const memberships = count(membershipsBy);
  return {
    generatedAt: now.toISOString(),
    restaurants: {
      total: Object.values(restaurants).reduce((a, b) => a + b, 0),
      byStatus: restaurants,
      pendingApproval: restaurants.APPROVAL_PENDING ?? 0,
      pendingVerification: restaurants.VERIFICATION_PENDING ?? 0,
    },
    coupons: { total: couponsTotal, active: couponsActive, redeemed: redeemed?.n ?? 0, redeemedDiscountPaise: redeemed?.discountPaise ?? 0, held: redemptions.find((x) => x._id === 'HELD')?.n ?? 0 },
    memberships: { active: memberships.ACTIVE ?? 0, pendingPayment: memberships.PENDING_PAYMENT ?? 0, byStatus: memberships },
    reservations: { held },
    ratings: { total: ratings },
    menu: { items },
  };
}
