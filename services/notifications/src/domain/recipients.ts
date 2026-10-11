/**
 * Recipient lookup (identity `GET /internal/users/:id`, binding shape in docs/03-LLD.md) and the
 * channel plan: in-app always for user-facing templates; SMS/email only when the template allows the
 * channel, the user has an address, is not blocked, and the preference (or "transactional") permits it.
 */
import { z } from 'zod';
import type { InternalClient } from '@thali/service-kit';
import type { Channel, TemplateName } from './templates.js';
import { templateDef } from './templates.js';

export interface NotificationPrefs {
  orderSms: boolean;
  orderEmail: boolean;
  marketingSms: boolean;
  marketingEmail: boolean;
}

export interface IdentityUser {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  roles: string[];
  status: 'ACTIVE' | 'BLOCKED';
  notificationPrefs: NotificationPrefs;
}

export interface RecipientDirectory {
  /** `null` = unknown user (404). Throws when identity is unreachable (the event is retried). */
  getUser(id: string): Promise<IdentityUser | null>;
}

const IdentityUserSchema = z.object({
  id: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  roles: z.array(z.string()),
  status: z.enum(['ACTIVE', 'BLOCKED']),
  notificationPrefs: z.object({
    orderSms: z.boolean(),
    orderEmail: z.boolean(),
    marketingSms: z.boolean(),
    marketingEmail: z.boolean(),
  }),
});

export function createIdentityDirectory(identity: InternalClient): RecipientDirectory {
  return {
    async getUser(id) {
      try {
        return await identity.get(`/internal/users/${encodeURIComponent(id)}`, { schema: IdentityUserSchema });
      } catch (err) {
        if ((err as { code?: string; upstreamStatus?: number }).upstreamStatus === 404) return null;
        throw err;
      }
    },
  };
}

/** orders `GET /internal/orders/child/:id` (binding shape): only what we need. */
export interface OrdersLookup {
  /** `null` = unknown order. Throws when orders is unreachable. */
  getChildOrder(childOrderId: string): Promise<{ id: string; userId: string } | null>;
}

/**
 * Why SMS/email must NOT be sent to this user (`null` = send). Decided at dispatch time, outside any transaction:
 * blocked users and missing addresses never get SMS/email; otherwise the preference (or the template's
 * transactional flag) decides. In-app is never skipped.
 */
export function skipReason(template: TemplateName, channel: Channel, user: IdentityUser): string | null {
  if (channel === 'IN_APP') return null;
  const def = templateDef(template);
  if (user.status !== 'ACTIVE') return 'USER_BLOCKED';
  if (channel === 'SMS') {
    if (!user.phone) return 'NO_PHONE';
    return def.transactionalSms || user.notificationPrefs.orderSms ? null : 'OPTED_OUT';
  }
  if (!user.email) return 'NO_EMAIL';
  return def.transactionalEmail || user.notificationPrefs.orderEmail ? null : 'OPTED_OUT';
}
