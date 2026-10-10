/**
 * orders client (binding shape): `POST /internal/cart/merge {userId, guestToken}` → 200
 * `{merged: boolean, lineCount}`. Called best-effort after OTP verify.
 */
import { z } from 'zod';
import { internalClient } from '@thali/service-kit';
import type { IdentityConfig } from '../config.js';

export interface CartMergeResult {
  merged: boolean;
  lineCount: number;
}

export interface OrdersClient {
  mergeCart(userId: string, guestToken: string): Promise<CartMergeResult>;
}

const MergeResult = z.object({ merged: z.boolean(), lineCount: z.number().int().nonnegative() });

export function createOrdersClient(
  config: Pick<IdentityConfig, 'ORDERS_URL' | 'INTERNAL_SERVICE_SECRET'>,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): OrdersClient {
  const client = internalClient('orders', config.ORDERS_URL, {
    from: 'identity',
    secret: config.INTERNAL_SERVICE_SECRET,
    timeoutMs: opts.timeoutMs ?? 3000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return {
    mergeCart: (userId, guestToken) => client.post('/internal/cart/merge', { userId, guestToken }, { schema: MergeResult }),
  };
}
