/**
 * Typed clients for other services (binding internal API shapes, service-context.md).
 * marketplace `GET /internal/restaurants/:id` → restaurant ownership for finance routes.
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

export function createMarketplaceClient(opts: { baseUrl: string; secret: string }): MarketplaceClient {
  const client = internalClient('marketplace', opts.baseUrl, { from: 'payments', secret: opts.secret });
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
