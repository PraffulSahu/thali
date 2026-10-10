/**
 * 🔓/👤 `GET /api/v1/coupons/available` (MKT-7) — signed in: coupons this customer can apply now
 * (server-enforced eligibility, `eligibility: 'ELIGIBLE'`); guest: every live coupon with
 * `remainingUses: null`, `eligibility: 'SIGN_IN_TO_CHECK'`.
 */
import { z } from 'zod';
import { requireAuth } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { availableCoupons, guestCoupons } from '../domain/coupons.js';
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
    remainingUses: z.number().int().nullable().describe('Uses left for this customer (null = unlimited, or a guest)'),
    offerHeadline: z.string().describe('"50% off up to ₹100" / "₹100 off"'),
    eligibility: z.enum(['ELIGIBLE', 'SIGN_IN_TO_CHECK']).describe('SIGN_IN_TO_CHECK for guests (per-user rules not evaluated)'),
    restaurantIds: z.array(z.string()).describe('Restaurants it applies to; empty = all (MKT-8)'),
    badgeLabel: z.string().nullable(),
  })
  .meta({ id: 'AvailableCoupon' });

export const couponRoutes: RouteModule = {
  name: 'coupons',
  register(r, ctx) {
    r.get(`${API}/coupons/available`, requireAuth({ optional: true }), async (req, res) => {
      res.json({ items: req.auth ? await availableCoupons(ctx, userIdOf(req)) : await guestCoupons(ctx) });
    });
  },
  openapi(api) {
    api.route({
      method: 'get',
      path: `${API}/coupons/available`,
      tags: ['coupons'],
      summary: 'Offers (optional bearer token). Signed in: coupons I can apply right now (active, in window, not exhausted, first-order rule, per-user limit). Guest: all live coupons (SIGN_IN_TO_CHECK).',
      responses: { 200: { description: 'Coupons', content: json(z.object({ items: z.array(CouponPublicView) })) } },
    });
  },
};
