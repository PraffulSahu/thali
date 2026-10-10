/**
 * Identity internal client: binding `GET /internal/users/:id` (name + phone snapshot for the
 * child order's masked customer contact).
 */
import { z } from 'zod';
import { enumValues, Role } from '@thali/contracts';
import { internalClient, UpstreamError } from '@thali/service-kit';
import type { OrdersConfig } from '../config.js';

export const InternalUserSchema = z.object({
  id: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  roles: z.array(z.enum(enumValues(Role))),
  status: z.enum(['ACTIVE', 'BLOCKED']),
  notificationPrefs: z.object({
    orderSms: z.boolean(),
    orderEmail: z.boolean(),
    marketingSms: z.boolean(),
    marketingEmail: z.boolean(),
  }),
});
export type InternalUser = z.output<typeof InternalUserSchema>;

export interface IdentityClient {
  /** null on 404. */
  getUser(id: string): Promise<InternalUser | null>;
}

export function createIdentityClient(config: OrdersConfig): IdentityClient {
  const http = internalClient('identity', config.IDENTITY_URL, {
    from: 'orders',
    secret: config.INTERNAL_SERVICE_SECRET,
    timeoutMs: config.INTERNAL_HTTP_TIMEOUT_MS,
  });
  return {
    async getUser(id) {
      try {
        return await http.get(`/internal/users/${encodeURIComponent(id)}`, { schema: InternalUserSchema });
      } catch (e) {
        if (e instanceof UpstreamError && e.upstreamStatus === 404) return null;
        throw e;
      }
    },
  };
}
