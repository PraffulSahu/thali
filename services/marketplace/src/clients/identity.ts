/**
 * identity internal client (binding shape, service-context "Internal API shapes"):
 *   POST /internal/users/:id/roles { role } → 200 { userId, roles } (idempotent)
 */
import { z } from 'zod';
import type { Role } from '@thali/contracts';
import { internalClient } from '@thali/service-kit';

export interface IdentityClient {
  grantRole(userId: string, role: 'RESTAURANT_OWNER'): Promise<{ userId: string; roles: Role[] }>;
}

const GrantRoleResponse = z.object({ userId: z.string(), roles: z.array(z.string()) });

export function createIdentityClient(opts: { baseUrl: string; secret: string }): IdentityClient {
  const http = internalClient('identity', opts.baseUrl, { from: 'marketplace', secret: opts.secret });
  return {
    async grantRole(userId, role) {
      const res = await http.post(`/internal/users/${encodeURIComponent(userId)}/roles`, { role }, { schema: GrantRoleResponse });
      return res as { userId: string; roles: Role[] };
    },
  };
}
