/**
 * DLV-1 "Call": the assigned partner asks to contact the restaurant or the customer.
 *
 * Modes:
 *  - DEMO   (APP_MODE=demo): no real call. `telUrl` null, masked `displayNumber`, note "Calling is
 *           simulated in demo". The customer's full number is never fetched (masked snapshot only).
 *  - DIRECT (pilot, every other mode): `tel:` URL with the real number — customer from identity
 *           `GET /internal/users/:id`, restaurant from the job's `pickup.phone` (order.accepted) or
 *           marketplace `GET /internal/restaurants/:id`.
 *  - PROXY  (reserved for a future masked-number provider; not implemented).
 *
 * Allowed states: RESTAURANT while ASSIGNED / AT_PICKUP; CUSTOMER while AT_PICKUP / PICKED_UP /
 * OUT_FOR_DELIVERY. Otherwise 409 CONFLICT {reason:'NOT_CALLABLE_NOW'}. Only the assigned partner
 * (404 for anyone else). Every reveal is audited (`audit.recorded`, action
 * `delivery.contact_revealed`) BEFORE the number is returned; the audit summary never contains it.
 */
import { DomainError } from '@thali/contracts';
import { auditEvent, withTransaction } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import type { JobLean } from '../models/delivery-job.js';

export type ContactTarget = 'CUSTOMER' | 'RESTAURANT';
export type ContactMode = 'DIRECT' | 'PROXY' | 'DEMO';

export const CONTACT_REVEAL_TTL_SEC = 600;
export const DEMO_CALL_NOTE = 'Calling is simulated in demo';

const CALLABLE: Record<ContactTarget, readonly string[]> = {
  RESTAURANT: ['ASSIGNED', 'AT_PICKUP'],
  CUSTOMER: ['AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY'],
};

export interface ContactResult {
  target: ContactTarget;
  mode: ContactMode;
  telUrl: string | null;
  displayNumber: string;
  expiresAt: string;
  note: string | null;
}

/** `+919876543210` / `+91******3210` → `+91 ••••• •3210` (only the last 4 digits survive). */
export function displayMasked(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return null;
  const p = phone.trim();
  // country code: +91 (masked snapshots keep it), else the digits before a 10-digit national number
  const cc = p.startsWith('+91') ? '+91' : p.startsWith('+') && digits.length > 10 ? `+${digits.slice(0, digits.length - 10)}` : '';
  return `${cc ? `${cc} ` : ''}••••• •${digits.slice(-4)}`;
}

/** E.164-ish `tel:` target (keeps the leading + and digits only). */
const telUrl = (phone: string) => `tel:${phone.trim().replace(/[^\d+]/g, '')}`;

const noPhone = () => new DomainError('CONFLICT', 'No phone number is on file for this contact', undefined, { reason: 'NO_PHONE_ON_FILE' });

async function restaurantPhone(ctx: DeliveryContext, job: JobLean): Promise<string | null> {
  const stored = (job.pickup as { phone?: string | null }).phone;
  if (stored) return stored;
  const r = await ctx.marketplace.getRestaurant(job.restaurantId);
  return r?.phone ?? null;
}

export async function revealContact(ctx: DeliveryContext, userId: string, jobId: string, target: ContactTarget, ip?: string): Promise<ContactResult> {
  const job = await ctx.models.Job.findOne({ _id: jobId, partnerUserId: userId }).lean<JobLean>();
  if (!job) throw new DomainError('NOT_FOUND', 'Delivery not found');
  if (!CALLABLE[target].includes(job.status)) {
    throw new DomainError('CONFLICT', `You can't call the ${target.toLowerCase()} while the delivery is ${job.status}`, undefined, { reason: 'NOT_CALLABLE_NOW', status: job.status, target });
  }

  const mode: ContactMode = ctx.config.APP_MODE === 'demo' ? 'DEMO' : 'DIRECT';
  let phone: string | null;
  if (target === 'RESTAURANT') phone = await restaurantPhone(ctx, job);
  else if (mode === 'DEMO') phone = job.drop.phoneMasked || null; // never fetch the real number in demo
  else phone = (await ctx.identity.getUser(job.customerUserId))?.phone ?? null;
  const displayNumber = phone ? displayMasked(phone) : null;
  if (!phone || !displayNumber) throw noPhone();

  const now = ctx.now();
  const code = (job as { childOrderCode?: string | null }).childOrderCode ?? job.childOrderId;
  await withTransaction(ctx.conn, (session) =>
    auditEvent(ctx.conn, session, {
      service: 'delivery',
      actorId: userId,
      actorRole: 'DELIVERY_PARTNER',
      action: 'delivery.contact_revealed',
      targetType: 'delivery_job',
      targetId: job._id.toString(),
      summary: `Partner requested the ${target.toLowerCase()} contact for ${code} (${mode}, status ${job.status})`,
      ip,
    }),
  );

  return {
    target,
    mode,
    telUrl: mode === 'DIRECT' ? telUrl(phone) : null,
    displayNumber,
    expiresAt: new Date(now.getTime() + CONTACT_REVEAL_TTL_SEC * 1000).toISOString(),
    note: mode === 'DEMO' ? DEMO_CALL_NOTE : null,
  };
}
