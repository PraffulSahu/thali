/** 👤 `GET /api/v1/coupons/available` — coupons the signed-in customer can apply now (server-enforced eligibility). */
import { z } from 'zod';
import { requireAuth } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { availableCoupons } from '../domain/coupons.js';
import { API, json, userIdOf } from './common.js';

export const CouponPublicView = z
  .object({
    code: z.string(),
    description: z.string(),
    type: z.enum(['FLAT', 'PERCENT']),
    valuePaise: z.number().int().nullable(),
    valueBps: z.number().int().nullable(),
    maxDiscountPaise: z.number().int().nullable(),
    minOrderPaise: z.number().int(),
    validTo: z.string(),
    firstOrderOnly: z.boolean(),
    remainingUses: z.number().int().nullable().describe('Uses left for this customer (null = unlimited)'),
  })
  .meta({ id: 'AvailableCoupon' });

export const couponRoutes: RouteModule = {
  name: 'coupons',
  register(r, ctx) {
    r.get(`${API}/coupons/available`, requireAuth(), async (req, res) => {
      res.json({ items: await availableCoupons(ctx, userIdOf(req)) });
    });
  },
  openapi(api) {
    api.route({
      method: 'get',
      path: `${API}/coupons/available`,
      tags: ['coupons'],
      security: 'bearer',
      summary: 'Coupons I can apply right now (active, in window, not exhausted, first-order rule, per-user limit)',
      responses: { 200: { description: 'Coupons', content: json(z.object({ items: z.array(CouponPublicView) })) } },
    });
  },
};
