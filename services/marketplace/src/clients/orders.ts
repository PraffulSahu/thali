/**
 * orders internal client (binding shapes, service-context "Internal API shapes"):
 *   GET /internal/checkouts/:id/status        → { id, status, paymentIntentId }        (reservation sweeper)
 *   GET /internal/orders/child/:id            → { id, code, checkoutGroupId, userId, restaurantId,
 *                                                 restaurantOwnerId, status, deliveredAt }  (ratings)
 *   GET /internal/orders/stats?restaurantId&from&to → { restaurantId, from, to, ordersTotal, byStatus,
 *                                                 acceptanceRate, avgAcceptSeconds, grossPaise, netRevenuePaise } (dashboard)
 * 404 → `null` for the two lookups. Responses are zod-validated (drift → 502 UPSTREAM_ERROR).
 */
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import { internalClient, UpstreamError } from '@thali/service-kit';

export const CheckoutStatusSchema = z.object({ id: z.string(), status: z.string(), paymentIntentId: z.string().nullable().default(null) });
export type CheckoutStatusInfo = z.output<typeof CheckoutStatusSchema>;

export const ChildOrderInfoSchema = z.object({
  id: z.string(),
  code: z.string(),
  checkoutGroupId: z.string(),
  userId: z.string(),
  restaurantId: z.string(),
  restaurantOwnerId: z.string(),
  status: z.string(),
  deliveredAt: z.string().nullable(),
});
export type ChildOrderInfo = z.output<typeof ChildOrderInfoSchema>;

export const OrderStatsSchema = z
  .object({
    restaurantId: z.string(),
    from: z.string(),
    to: z.string(),
    ordersTotal: z.number().int().nonnegative(),
    byStatus: z.record(z.string(), z.number().int().nonnegative()),
    acceptanceRate: z.number().nullable(),
    avgAcceptSeconds: z.number().nullable(),
    grossPaise: z.number().int(),
    netRevenuePaise: z.number().int(),
  })
  .meta({ id: 'OrderStats' });
export type OrderStats = z.output<typeof OrderStatsSchema>;

export interface OrdersClient {
  /** null when orders has no such checkout (404). */
  getCheckoutStatus(checkoutId: string): Promise<CheckoutStatusInfo | null>;
  /** null when orders has no such child order (404). */
  getChildOrder(childOrderId: string): Promise<ChildOrderInfo | null>;
  getStats(q: { restaurantId: string; from: string; to: string }): Promise<OrderStats>;
}

const isNotFound = (e: unknown) =>
  (e instanceof UpstreamError && e.upstreamStatus === 404) || (e instanceof DomainError && e.code === 'NOT_FOUND');

export function createOrdersClient(opts: { baseUrl: string; secret: string; timeoutMs?: number }): OrdersClient {
  const http = internalClient('orders', opts.baseUrl, { from: 'marketplace', secret: opts.secret, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  return {
    async getCheckoutStatus(id) {
      try {
        return await http.get(`/internal/checkouts/${encodeURIComponent(id)}/status`, { schema: CheckoutStatusSchema });
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async getChildOrder(id) {
      try {
        return await http.get(`/internal/orders/child/${encodeURIComponent(id)}`, { schema: ChildOrderInfoSchema });
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    getStats: (q) => http.get('/internal/orders/stats', { query: q, schema: OrderStatsSchema }),
  };
}
