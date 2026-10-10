/**
 * Internal order routes (service tokens; binding shapes in service-context.md):
 *   GET /internal/orders/child/:id → { id, code, checkoutGroupId, userId, restaurantId,
 *       restaurantOwnerId, status, deliveredAt }        (marketplace ratings, notifications, …)
 *   GET /internal/orders/stats?restaurantId&from&to → RestaurantStats   (marketplace dashboard)
 */
import express from 'express';
import { Types } from 'mongoose';
import { DomainError } from '@thali/contracts';
import { requireInternal, validate, type OpenApi } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { ChildOrder } from '../models/child-order.js';
import { restaurantStats } from '../domain/stats.js';
import { InternalChildOrder, InternalChildParams, RestaurantStatsView, StatsQuery, json } from '../order-schemas.js';
import type { RouteModule } from './types.js';

const CHILD_CALLERS = ['marketplace', 'notifications', 'payments', 'delivery'] as const;

function register(app: express.Express, ctx: OrdersContext): void {
  const r = express.Router();

  const vChild = validate({ params: InternalChildParams });
  r.get('/internal/orders/child/:id', requireInternal([...CHILD_CALLERS]), vChild, async (req, res) => {
    const { id } = vChild.get(req).params;
    const c = Types.ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? await ctx.models.ChildOrder.findById(id).lean<ChildOrder>() : null;
    if (!c) throw new DomainError('NOT_FOUND', 'Child order not found');
    res.json({
      id: String(c._id),
      code: c.code,
      checkoutGroupId: String(c.checkoutGroupId),
      userId: c.userId,
      restaurantId: c.restaurantId,
      restaurantOwnerId: c.restaurantOwnerId,
      status: c.status,
      deliveredAt: c.deliveredAt ? new Date(c.deliveredAt).toISOString() : null,
    });
  });

  const vStats = validate({ query: StatsQuery });
  r.get('/internal/orders/stats', requireInternal(['marketplace']), vStats, async (req, res) => {
    const q = vStats.get(req).query;
    res.json(await restaurantStats(ctx, { restaurantId: q.restaurantId, from: new Date(q.from), to: new Date(q.to) }));
  });

  app.use(r);
}

function openapi(o: OpenApi): void {
  o.route({
    method: 'get',
    path: '/internal/orders/child/:id',
    tags: ['internal'],
    summary: 'Child order facts for other services (ratings eligibility, notification recipients)',
    security: 'internal',
    request: { params: InternalChildParams },
    responses: { 200: { description: 'Child order', content: json(InternalChildOrder) } },
    errors: ['NOT_FOUND'],
  });
  o.route({
    method: 'get',
    path: '/internal/orders/stats',
    tags: ['internal'],
    summary: 'Restaurant order stats for the marketplace dashboard (window on placedAt)',
    security: 'internal',
    request: { query: StatsQuery },
    responses: { 200: { description: 'Stats', content: json(RestaurantStatsView) } },
  });
}

export const internalOrdersModule: RouteModule = { name: 'internal-orders', register, openapi };
