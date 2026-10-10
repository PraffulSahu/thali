/**
 * Internal routes (service token). `GET /internal/restaurants/:id` — binding shape for payments,
 * orders and delivery:
 *   { id, ownerUserId, name, status, location: {lat,lng}, address: {line1, line2?, city, pincode},
 *     phone, commissionBps, packagingFeePaise, avgPrepMinutes }
 * `location`, `address` and `phone` can only be null for DRAFT restaurants that have not filled them in
 * (submission requires them).
 */
import { z } from 'zod';
import { DomainError, RestaurantStatusSchema } from '@thali/contracts';
import { requireInternal, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import type { RestaurantLean } from '../domain/restaurant-view.js';
import { toLatLng } from '../domain/serviceability.js';
import { json } from './common.js';

export const InternalRestaurant = z
  .object({
    id: z.string(),
    ownerUserId: z.string(),
    name: z.string(),
    status: RestaurantStatusSchema,
    location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
    address: z.object({ line1: z.string(), line2: z.string().optional(), city: z.string(), pincode: z.string() }).nullable(),
    phone: z.string().nullable(),
    commissionBps: z.number().int(),
    packagingFeePaise: z.number().int(),
    avgPrepMinutes: z.number().int(),
  })
  .meta({ id: 'InternalRestaurant' });

export function internalRestaurantView(r: RestaurantLean) {
  return {
    id: String(r._id),
    ownerUserId: r.ownerUserId,
    name: r.name,
    status: r.status,
    location: r.location?.coordinates?.length === 2 ? toLatLng(r.location) : null,
    address: r.address?.line1 ? { line1: r.address.line1, ...(r.address.line2 ? { line2: r.address.line2 } : {}), city: r.address.city!, pincode: r.address.pincode! } : null,
    phone: r.phone ?? null,
    commissionBps: r.commissionBps ?? 1800,
    packagingFeePaise: r.packagingFeePaise ?? 0,
    avgPrepMinutes: r.avgPrepMinutes ?? 20,
  };
}

const Params = z.object({ id: z.string().min(1).max(64) });
const CALLERS = ['payments', 'orders', 'delivery'] as const;

export const internalRoutes: RouteModule = {
  name: 'internal',
  register(r, ctx) {
    const v = validate({ params: Params });
    r.get('/internal/restaurants/:id', requireInternal([...CALLERS]), v, async (req, res) => {
      const { id } = v.get(req).params;
      const doc = /^[a-f0-9]{24}$/i.test(id) ? await ctx.models.Restaurant.findById(id).lean<RestaurantLean>() : null;
      if (!doc) throw new DomainError('NOT_FOUND', 'Restaurant not found');
      res.json(internalRestaurantView(doc));
    });
  },
  openapi(api) {
    api.route({
      method: 'get', path: '/internal/restaurants/:id', tags: ['internal'], security: 'internal',
      summary: 'Restaurant facts for payments/orders/delivery (callers: payments, orders, delivery)',
      request: { params: Params }, responses: { 200: { description: 'Restaurant', content: json(InternalRestaurant) } }, errors: ['NOT_FOUND'],
    });
  },
};
