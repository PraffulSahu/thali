/** 👤 `POST /api/v1/restaurants/:id/ratings {childOrderId, stars, comment?}` — customer of a DELIVERED child order, once. */
import { z } from 'zod';
import { requireAuth, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { createRating, myRatings } from '../domain/ratings.js';
import { API, json, RestaurantIdParams, splitCsv, userIdOf } from './common.js';

const RatingBody = z.object({ childOrderId: z.string().min(1).max(64), stars: z.number().int().min(1).max(5), comment: z.string().trim().max(500).optional() }).strict();
export const RatingView = z
  .object({ id: z.string(), restaurantId: z.string(), childOrderId: z.string(), stars: z.number().int(), comment: z.string(), createdAt: z.string().nullable() })
  .meta({ id: 'Rating' });

const MineQuery = z.object({
  childOrderIds: z
    .string()
    .max(2000)
    .transform(splitCsv)
    .pipe(z.array(z.string().min(1).max(64)).min(1).max(50))
    .describe('CSV of child order ids (1–50)'),
});
const MyRating = z.object({ childOrderId: z.string(), restaurantId: z.string(), stars: z.number().int(), createdAt: z.string().nullable() }).meta({ id: 'MyRating' });

export const ratingRoutes: RouteModule = {
  name: 'ratings',
  register(r, ctx) {
    const vMine = validate({ query: MineQuery });
    r.get(`${API}/restaurants/ratings/mine`, requireAuth(), vMine, async (req, res) => {
      res.json({ items: await myRatings(ctx, userIdOf(req), vMine.get(req).query.childOrderIds) });
    });

    const v = validate({ params: RestaurantIdParams, body: RatingBody });
    r.post(`${API}/restaurants/:id/ratings`, requireAuth(), v, async (req, res) => {
      const { params, body } = v.get(req);
      res.status(201).json(await createRating(ctx, { restaurantId: params.id, userId: userIdOf(req), ...body }));
    });
  },
  openapi(api) {
    api.route({
      method: 'get',
      path: `${API}/restaurants/ratings/mine`,
      tags: ['ratings'],
      security: 'bearer',
      summary: 'Have I rated these orders? (MKT-14) Only my own ratings are returned; unrated ids are absent.',
      request: { query: MineQuery },
      responses: { 200: { description: 'My ratings', content: json(z.object({ items: z.array(MyRating) })) } },
    });
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
