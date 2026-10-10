/**
 * Ratings (PRD; LLD 3.2): only the order's customer, only after the child order is DELIVERED (verified
 * with orders `GET /internal/orders/child/:id`), once per child order (unique `childOrderId`). The
 * restaurant's `ratingSum`/`ratingCount` are `$inc`ed in the same transaction; discovery shows a rating
 * only from 5 ratings on (Task 8 `ratingOf`).
 */
import { Types } from 'mongoose';
import { DomainError } from '@thali/contracts';
import { withTransaction } from '@thali/service-kit';
import type { AppContext } from '../context.js';

export interface RatingInput {
  restaurantId: string;
  userId: string;
  childOrderId: string;
  stars: number;
  comment?: string;
}

export function ratingView(r: { _id: unknown; restaurantId: unknown; childOrderId: string; userId: string; stars: number; comment?: string | null; createdAt?: Date }) {
  return {
    id: String(r._id),
    restaurantId: String(r.restaurantId),
    childOrderId: r.childOrderId,
    stars: r.stars,
    comment: r.comment ?? '',
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
  };
}

const alreadyRated = () => new DomainError('CONFLICT', 'This order has already been rated', undefined, { reason: 'ALREADY_RATED' });

export async function createRating(ctx: AppContext, input: RatingInput) {
  if (!/^[a-f0-9]{24}$/i.test(input.restaurantId)) throw new DomainError('NOT_FOUND', 'Restaurant not found');
  const rid = new Types.ObjectId(input.restaurantId);
  if (!(await ctx.models.Restaurant.exists({ _id: rid }))) throw new DomainError('NOT_FOUND', 'Restaurant not found');
  if (await ctx.models.Rating.exists({ childOrderId: input.childOrderId })) throw alreadyRated();

  const child = await ctx.orders.getChildOrder(input.childOrderId);
  if (!child) throw new DomainError('NOT_FOUND', 'Order not found');
  if (child.userId !== input.userId) throw new DomainError('FORBIDDEN', 'Only the customer who placed this order can rate it');
  if (child.restaurantId !== input.restaurantId) {
    throw new DomainError('VALIDATION_FAILED', 'This order is not from this restaurant', undefined, { issues: [{ path: 'body.childOrderId', message: 'Order belongs to another restaurant' }] });
  }
  if (child.status !== 'DELIVERED') throw new DomainError('CONFLICT', 'You can rate an order once it has been delivered', undefined, { reason: 'NOT_DELIVERED', status: child.status });

  try {
    return await withTransaction(ctx.conn, async (session) => {
      const [doc] = await ctx.models.Rating.create(
        [{ restaurantId: rid, childOrderId: input.childOrderId, userId: input.userId, stars: input.stars, comment: input.comment ?? '' }],
        { session },
      );
      await ctx.models.Restaurant.updateOne({ _id: rid }, { $inc: { ratingSum: input.stars, ratingCount: 1 } }, { session });
      return ratingView(doc!.toObject());
    });
  } catch (e) {
    if ((e as { code?: number })?.code === 11000) throw alreadyRated();
    throw e;
  }
}

/** MKT-14: which of these child orders has this customer already rated? (unique `childOrderId` index) */
export async function myRatings(ctx: AppContext, userId: string, childOrderIds: string[]) {
  if (!childOrderIds.length) return [];
  const rows = await ctx.models.Rating.find({ childOrderId: { $in: childOrderIds }, userId }, { childOrderId: 1, restaurantId: 1, stars: 1, createdAt: 1 })
    .lean<{ childOrderId: string; restaurantId: unknown; stars: number; createdAt?: Date }[]>();
  return rows.map((r) => ({ childOrderId: r.childOrderId, restaurantId: String(r.restaurantId), stars: r.stars, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null }));
}
