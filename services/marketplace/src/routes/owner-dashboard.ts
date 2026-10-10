/** 🍽 `GET /api/v1/owner/restaurants/:id/dashboard?from&to` — metrics from orders stats + own menu/ratings (default last 30 days). */
import { z } from 'zod';
import { requireAuth, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { OrderStatsSchema } from '../clients/orders.js';
import { ownerDashboard } from '../domain/dashboard.js';
import { API, json, RatingView, RestaurantIdParams, userIdOf } from './common.js';

const RangeQuery = z
  .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
  .refine((q) => !q.from || !q.to || q.from < q.to, { message: 'from must be before to', path: ['from'] });

const DashboardView = z
  .object({
    restaurant: z.object({ id: z.string(), name: z.string(), status: z.string(), open: z.boolean(), closedReason: z.string().optional(), pausedUntil: z.string().nullable() }),
    period: z.object({ from: z.string(), to: z.string() }),
    orders: OrderStatsSchema.nullable().describe('From orders; null when orders is unreachable'),
    ordersAvailable: z.boolean(),
    rating: RatingView,
    ratingCount: z.number().int(),
    menu: z.object({
      itemsTotal: z.number().int(),
      itemsUnavailable: z.number().int(),
      itemsOutOfStock: z.number().int(),
      lowStockThreshold: z.number().int(),
      lowStock: z.array(z.object({ itemId: z.string(), name: z.string(), availableQty: z.number().int() })),
    }),
  })
  .meta({ id: 'OwnerDashboard' });

export const ownerDashboardRoutes: RouteModule = {
  name: 'owner-dashboard',
  register(r, ctx) {
    const v = validate({ params: RestaurantIdParams, query: RangeQuery });
    r.get(`${API}/owner/restaurants/:id/dashboard`, requireAuth({ roles: ['RESTAURANT_OWNER'] }), v, async (req, res) => {
      const { params, query } = v.get(req);
      res.json(await ownerDashboard(ctx, params.id, userIdOf(req), query));
    });
  },
  openapi(api) {
    api.route({
      method: 'get',
      path: `${API}/owner/restaurants/:id/dashboard`,
      tags: ['owner-dashboard'],
      security: 'bearer',
      summary: 'Restaurant dashboard (orders metrics from orders service; menu + ratings from marketplace)',
      request: { params: RestaurantIdParams, query: RangeQuery },
      responses: { 200: { description: 'Dashboard', content: json(DashboardView) } },
      errors: ['NOT_FOUND'],
    });
  },
};
