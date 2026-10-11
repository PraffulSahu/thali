/**
 * Typed clients for other services (binding internal API shapes, docs/03-LLD.md).
 * marketplace `GET /internal/restaurants/:id` → restaurant ownership for finance routes.
 * orders `GET /internal/orders/child/:id` → child checkout/restaurant/total for manual refunds.
 */
import { z } from 'zod';
import { internalClient, UpstreamError } from '@thali/service-kit';

export const RestaurantInfoSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  name: z.string(),
  status: z.string(),
  location: z.object({ lat: z.number(), lng: z.number() }),
  address: z.object({ line1: z.string(), line2: z.string().optional(), city: z.string(), pincode: z.string() }),
  phone: z.string(),
  commissionBps: z.number(),
  packagingFeePaise: z.number(),
  avgPrepMinutes: z.number(),
});
export type RestaurantInfo = z.infer<typeof RestaurantInfoSchema>;

const OwnershipSchema = z.looseObject({ id: z.string(), ownerUserId: z.string() });

export interface MarketplaceClient {
  /** null when marketplace answers 404. */
  getRestaurant(id: string): Promise<RestaurantInfo | null>;
}

export function createMarketplaceClient(opts: { baseUrl: string; secret: string; timeoutMs?: number }): MarketplaceClient {
  const client = internalClient('marketplace', opts.baseUrl, { from: 'payments', secret: opts.secret, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  return {
    async getRestaurant(id) {
      try {
        // Only the ownership fields are relied upon; tolerate additive fields.
        const r = await client.get(`/internal/restaurants/${encodeURIComponent(id)}`, { schema: OwnershipSchema });
        return r as unknown as RestaurantInfo;
      } catch (err) {
        if (err instanceof UpstreamError && err.upstreamStatus === 404) return null;
        throw err;
      }
    },
  };
}

export const ChildOrderInfoSchema = z.looseObject({
  id: z.string(),
  checkoutGroupId: z.string(),
  restaurantId: z.string(),
  status: z.string(),
  totalPaise: z.number().int(),
  committedRefundPaise: z.number().int().default(0),
});
export type ChildOrderInfo = z.infer<typeof ChildOrderInfoSchema>;

export interface OrdersClient {
  /** null when orders answers 404. */
  getChildOrder(id: string): Promise<ChildOrderInfo | null>;
}

export function createOrdersClient(opts: { baseUrl: string; secret: string; timeoutMs?: number }): OrdersClient {
  const client = internalClient('orders', opts.baseUrl, { from: 'payments', secret: opts.secret, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  return {
    async getChildOrder(id) {
      try {
        return await client.get(`/internal/orders/child/${encodeURIComponent(id)}`, { schema: ChildOrderInfoSchema });
      } catch (err) {
        if (err instanceof UpstreamError && err.upstreamStatus === 404) return null;
        throw err;
      }
    },
  };
}
