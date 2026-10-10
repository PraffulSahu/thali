/** 👤 `POST /api/v1/restaurants/:id/ratings {childOrderId, stars, comment?}` — customer of a DELIVERED child order, once. */
import { z } from 'zod';
import { requireAuth, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { createRating } from '../domain/ratings.js';
import { API, json, RestaurantIdParams, userIdOf } from './common.js';

const RatingBody = z.object({ childOrderId: z.string().min(1).max(64), stars: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() }).strict();
export const RatingView = z
  .object({ id: z.string(), restaurantId: z.string(), childOrderId: z.string(), stars: z.number().int(), comment: z.string(), createdAt: z.string().nullable() })
  .meta({ id: 'Rating' });

export const ratingRoutes: RouteModule = {
  name: 'ratings',
  register(r, ctx) {
    const v = validate({ params: RestaurantIdParams, body: RatingBody });
    r.post(`${API}/restaurants/:id/ratings`, requireAuth(), v, async (req, res) => {
      const { params, body } = v.get(req);
      res.status(201).json(await createRating(ctx, { restaurantId: params.id, userId: userIdOf(req), ...body }));
    });
  },
  openapi(api) {
    api.route({
      method: 'post',
      path: `${API}/restaurants/:id/ratings`,
      tags: ['ratings'],
      security: 'bearer',
      summary: 'Rate a delivered order (only its customer, once per child order)',
      request: { params: RestaurantIdParams, body: { content: json(RatingBody) } },
      responses: { 201: { description: 'Rating', content: json(RatingView) } },
      errors: ['NOT_FOUND', 'CONFLICT', 'UPSTREAM_ERROR'],
    });
  },
};
