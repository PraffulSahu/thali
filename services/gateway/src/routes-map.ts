/**
 * Gateway prefix -> service table (HLD 3.1, implemented exactly) + longest-prefix matcher.
 *
 * Matching is on path-segment boundaries (`/api/v1/me` matches `/api/v1/me` and `/api/v1/me/x`, never
 * `/api/v1/message`) and case-sensitive (anything else is a 404 at the gateway, never forwarded).
 * `/internal/*` is not in the table, so it can never be proxied. Prefixes owned by the gateway itself map
 * to `'gateway'`; the proxy never forwards those.
 */
import type { ServiceName } from '@thali/contracts';

export type UpstreamService = Exclude<ServiceName, 'gateway'>;
export type RouteTarget = UpstreamService | 'gateway';
export type RouteEntry = readonly [prefix: string, target: RouteTarget];

export const UPSTREAM_SERVICES: readonly UpstreamService[] = [
  'identity',
  'marketplace',
  'orders',
  'payments',
  'delivery',
  'notifications',
];

export const PREFIX_MAP: readonly RouteEntry[] = [
  // identity
  ['/api/v1/auth', 'identity'],
  ['/api/v1/me', 'identity'],
  ['/api/v1/admin/users', 'identity'],
  ['/api/v1/admin/audit-logs', 'identity'],
  ['/api/v1/admin/admins', 'identity'],
  ['/.well-known/jwks.json', 'identity'],
  // marketplace
  ['/api/v1/discovery', 'marketplace'],
  ['/api/v1/restaurants', 'marketplace'],
  ['/api/v1/owner/restaurants', 'marketplace'],
  ['/api/v1/coupons', 'marketplace'],
  ['/api/v1/memberships', 'marketplace'],
  ['/api/v1/banners', 'marketplace'],
  ['/api/v1/cuisines', 'marketplace'],
  ['/api/v1/admin/marketplace', 'marketplace'],
  // orders
  ['/api/v1/cart', 'orders'],
  ['/api/v1/checkouts', 'orders'],
  ['/api/v1/orders', 'orders'],
  ['/api/v1/owner/orders', 'orders'],
  ['/api/v1/support', 'orders'],
  ['/api/v1/admin/orders', 'orders'],
  ['/api/v1/admin/support', 'orders'],
  // payments
  ['/api/v1/payments', 'payments'],
  ['/api/v1/webhooks/razorpay', 'payments'],
  ['/api/v1/finance', 'payments'],
  ['/api/v1/admin/finance', 'payments'],
  ['/api/v1/demo-pay', 'payments'],
  // delivery
  ['/api/v1/partner', 'delivery'],
  ['/api/v1/deliveries', 'delivery'],
  ['/api/v1/admin/delivery', 'delivery'],
  // notifications
  ['/api/v1/notifications', 'notifications'],
  ['/api/v1/realtime', 'notifications'],
  ['/api/v1/webhooks/twilio', 'notifications'],
  ['/api/v1/webhooks/resend', 'notifications'],
  ['/api/v1/admin/notifications', 'notifications'],
  // gateway itself
  ['/api/v1/meta', 'gateway'],
  ['/api/v1/admin/health', 'gateway'],
  ['/api/docs', 'gateway'],
];

/** Longest matching prefix wins; `null` when nothing matches. */
export function resolveService(path: string, map: readonly RouteEntry[] = PREFIX_MAP): RouteTarget | null {
  let best: RouteEntry | undefined;
  for (const entry of map) {
    const prefix = entry[0];
    if (path === prefix || path.startsWith(prefix + '/')) {
      if (!best || prefix.length > best[0].length) best = entry;
    }
  }
  return best ? best[1] : null;
}

/** Streaming (SSE) routes: no upstream timeout, no compression, headers flushed immediately. */
export const SSE_PATHS: readonly string[] = ['/api/v1/realtime/stream'];

export const isSsePath = (path: string): boolean => SSE_PATHS.some((p) => path === p || path.startsWith(p + '/'));
