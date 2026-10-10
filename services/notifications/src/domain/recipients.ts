/**
 * Recipient lookup (identity `GET /internal/users/:id`, binding shape from service-context.md) and the
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

export function planChannels(template: TemplateName, user: IdentityUser): Channel[] {
  const def = templateDef(template);
  const out: Channel[] = [];
  const active = user.status === 'ACTIVE';
  if (def.channels.includes('IN_APP')) out.push('IN_APP');
  if (def.channels.includes('SMS') && active && user.phone && (def.transactionalSms || user.notificationPrefs.orderSms)) out.push('SMS');
  if (def.channels.includes('EMAIL') && active && user.email && (def.transactionalEmail || user.notificationPrefs.orderEmail)) out.push('EMAIL');
  return out;
}
