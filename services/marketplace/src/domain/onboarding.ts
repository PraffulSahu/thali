/**
 * Restaurant onboarding (PRD R-1/R-2/R-4, LLD 4.6): create DRAFT (grants RESTAURANT_OWNER), profile
 * edits, submit → VERIFICATION_PENDING (email gate) → APPROVAL_PENDING → admin; settlement (encrypted),
 * hours, pause/resume, KYC documents.
 */
import { DomainError, type RestaurantStatus } from '@thali/contracts';
import { auditEvent, encryptField, withTransaction } from '@thali/service-kit';
import { Types } from 'mongoose';
import type { AppContext } from '../context.js';
import { emitRestaurantSubmitted, emitRestaurantUpdated } from '../events/restaurant-events.js';
import { issueVerification } from './email-verification.js';
import type { RestaurantHydrated } from './restaurant-view.js';
import { transitionRestaurant } from './transitions.js';
import { verifyAttachment } from './uploads.js';
import type { HoursSlot } from './open-status.js';

export interface ProfileInput {
  businessName?: string;
  name?: string;
  description?: string;
  cuisines?: string[];
  phone?: string;
  businessEmail?: string;
  address?: { line1: string; line2?: string; city: string; pincode: string };
  location?: { lat: number; lng: number };
  deliveryRadiusKm?: number;
  hours?: HoursSlot[];
  packagingFeePaise?: number;
  avgPrepMinutes?: number;
  images?: { cover?: string | null; logo?: string | null };
}

export const restaurantPrefix = (id: string) => `restaurants/${id}`;

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'restaurant';
}

const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;

/** Owned restaurant or 404 (also for malformed ids and other owners — no existence leak). */
export async function findOwned(ctx: AppContext, id: string, ownerUserId: string, session?: import('mongoose').ClientSession) {
  if (!Types.ObjectId.isValid(id)) throw new DomainError('NOT_FOUND', 'Restaurant not found');
  const q = ctx.models.Restaurant.findOne({ _id: id, ownerUserId });
  if (session) q.session(session);
  const doc = await q;
  if (!doc) throw new DomainError('NOT_FOUND', 'Restaurant not found');
  return doc;
}

function applyProfile(doc: RestaurantHydrated, p: ProfileInput) {
  const simple = ['businessName', 'name', 'description', 'cuisines', 'phone', 'deliveryRadiusKm', 'packagingFeePaise', 'avgPrepMinutes'] as const;
  for (const k of simple) if (p[k] !== undefined) doc.set(k, p[k]);
  if (p.address) doc.set('address', p.address);
  if (p.location) doc.set('location', { type: 'Point', coordinates: [p.location.lng, p.location.lat] });
  if (p.hours) doc.set('hours', p.hours);
  if (p.images) {
    for (const k of ['cover', 'logo'] as const) {
      if (p.images[k] === null) doc.set(`images.${k}`, undefined);
      else if (p.images[k] !== undefined) doc.set(`images.${k}`, p.images[k]);
    }
  }
}

/** Grants RESTAURANT_OWNER first (idempotent), then creates the DRAFT — no orphan restaurant on failure. */
export async function createRestaurant(ctx: AppContext, ownerUserId: string, input: ProfileInput & { name: string }) {
  await ctx.identity.grantRole(ownerUserId, 'RESTAURANT_OWNER');
  const { images: _ignored, businessEmail, ...profile } = input;
  const id = new Types.ObjectId();
  const base = slugify(input.name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${attempt === 1 ? String(id).slice(-6) : Math.random().toString(36).slice(2, 8)}`;
    try {
      const doc = new ctx.models.Restaurant({ _id: id, ownerUserId, name: input.name, slug, status: 'DRAFT' });
      applyProfile(doc, profile);
      if (businessEmail) doc.businessEmail = businessEmail;
      await doc.save();
      return doc;
    } catch (e) {
      if (!isDuplicateKey(e) || attempt === 2) throw e;
    }
  }
  throw new DomainError('CONFLICT', 'Could not allocate a slug');
}

/** Owner PATCH. Changing businessEmail resets verification (LLD 4.6). Emits `restaurant.updated`. */
export async function updateRestaurant(ctx: AppContext, id: string, ownerUserId: string, patch: ProfileInput) {
  const current = await findOwned(ctx, id, ownerUserId);
  // verify newly referenced images before the transaction (storage I/O)
  for (const k of ['cover', 'logo'] as const) {
    const key = patch.images?.[k];
    if (key && key !== current.images?.[k]) {
      await verifyAttachment(ctx.storage, ctx.config, { prefix: restaurantPrefix(id), purpose: 'IMAGE', key });
    }
  }
  return withTransaction(ctx.conn, async (session) => {
    const doc = await findOwned(ctx, id, ownerUserId, session);
    const { businessEmail, ...rest } = patch;
    applyProfile(doc, rest);
    if (businessEmail !== undefined && businessEmail !== doc.businessEmail) {
      doc.businessEmail = businessEmail;
      doc.set('emailVerifiedAt', undefined);
      doc.set('emailVerification', undefined);
      const status = doc.status as RestaurantStatus;
      if (status !== 'DRAFT') {
        // not yet approved → back to the email gate; approved/suspended keep their status but re-verify
        if (status === 'APPROVAL_PENDING' || status === 'REJECTED') {
          await transitionRestaurant(ctx, session, doc, 'VERIFICATION_PENDING', { actor: 'RESTAURANT', actorId: ownerUserId, reason: 'business email changed' });
        }
        await issueVerification(ctx, session, doc);
      }
    }
    await doc.save({ session });
    await emitRestaurantUpdated(ctx.conn, session, doc);
    return doc;
  });
}

/** Fields required before submit (PRD R-1). `name` is set at creation. */
export function missingFields(doc: RestaurantHydrated, requiredDocuments: string[]): string[] {
  const missing: string[] = [];
  const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  if (blank(doc.businessName)) missing.push('businessName');
  if (blank(doc.name)) missing.push('name');
  if (blank(doc.description)) missing.push('description');
  if (!doc.cuisines?.length) missing.push('cuisines');
  if (blank(doc.phone)) missing.push('phone');
  if (blank(doc.businessEmail)) missing.push('businessEmail');
  if (!doc.address?.line1 || !doc.address?.city || !doc.address?.pincode) missing.push('address');
  if (doc.location?.coordinates?.length !== 2) missing.push('location');
  if (!doc.hours?.length) missing.push('hours');
  if (!doc.settlement?.accountNumberEnc) missing.push('settlement');
  const have = new Set((doc.documents ?? []).map((d) => d.type));
  for (const t of requiredDocuments) if (!have.has(t)) missing.push(`documents.${t}`);
  return missing;
}

/**
 * Submit: DRAFT → VERIFICATION_PENDING (+ verification email); REJECTED → APPROVAL_PENDING when the
 * email is still verified, else VERIFICATION_PENDING. Any other status → 409.
 */
export async function submitRestaurant(ctx: AppContext, id: string, ownerUserId: string) {
  return withTransaction(ctx.conn, async (session) => {
    const doc = await findOwned(ctx, id, ownerUserId, session);
    const from = doc.status as RestaurantStatus;
    if (from !== 'DRAFT' && from !== 'REJECTED') {
      throw new DomainError('RESTAURANT_INVALID_TRANSITION', `Cannot submit a restaurant in status ${from}`, undefined, { from, actor: 'RESTAURANT' });
    }
    const missing = missingFields(doc, ctx.config.REQUIRED_DOCUMENT_TYPES);
    if (missing.length) {
      throw new DomainError('VALIDATION_FAILED', `Complete these fields before submitting: ${missing.join(', ')}`, 422, { missing });
    }
    const by = { actor: 'RESTAURANT' as const, actorId: ownerUserId };
    if (from === 'REJECTED' && doc.emailVerifiedAt) {
      await transitionRestaurant(ctx, session, doc, 'APPROVAL_PENDING', by);
    } else {
      await transitionRestaurant(ctx, session, doc, 'VERIFICATION_PENDING', by);
      await issueVerification(ctx, session, doc);
    }
    await emitRestaurantSubmitted(ctx.conn, session, doc);
    await doc.save({ session });
    return doc;
  });
}

export async function setSettlement(
  ctx: AppContext,
  id: string,
  ownerUserId: string,
  input: { accountHolder: string; accountNumber: string; ifsc: string },
  ip?: string,
) {
  return withTransaction(ctx.conn, async (session) => {
    const doc = await findOwned(ctx, id, ownerUserId, session);
    const last4 = input.accountNumber.slice(-4);
    doc.set('settlement', {
      accountHolder: input.accountHolder,
      accountNumberEnc: encryptField(input.accountNumber, ctx.config.FIELD_ENCRYPTION_KEY),
      ifsc: input.ifsc,
      last4,
      updatedAt: ctx.now(),
    });
    await doc.save({ session });
    await auditEvent(ctx.conn, session, {
      service: 'marketplace',
      actorId: ownerUserId,
      actorRole: 'RESTAURANT_OWNER',
      action: 'restaurant.settlement_updated',
      targetType: 'restaurant',
      targetId: id,
      summary: `Settlement account set (****${last4}, ${input.ifsc})`,
      ip,
    });
    return { accountHolder: input.accountHolder, ifsc: input.ifsc, last4 };
  });
}

export async function setHours(ctx: AppContext, id: string, ownerUserId: string, hours: HoursSlot[]) {
  const doc = await findOwned(ctx, id, ownerUserId);
  doc.set('hours', hours);
  await doc.save();
  return doc;
}

export async function setPause(ctx: AppContext, id: string, ownerUserId: string, minutes: number | null) {
  const doc = await findOwned(ctx, id, ownerUserId);
  doc.set('pausedUntil', minutes === null ? undefined : new Date(ctx.now().getTime() + minutes * 60_000));
  await doc.save();
  return doc;
}

/** Attach a verified KYC document (replaces an earlier one of the same type). */
export async function attachDocument(ctx: AppContext, id: string, ownerUserId: string, input: { type: string; key: string }) {
  await findOwned(ctx, id, ownerUserId);
  await verifyAttachment(ctx.storage, ctx.config, { prefix: restaurantPrefix(id), purpose: 'DOCUMENT', key: input.key });
  const doc = await findOwned(ctx, id, ownerUserId);
  const kept = doc.documents.filter((d) => d.type !== input.type);
  doc.set('documents', [...kept.map((d) => d.toObject()), { type: input.type, key: input.key, verified: false, uploadedAt: ctx.now() }]);
  await doc.save();
  const added = doc.documents.find((d) => d.type === input.type && d.key === input.key)!;
  return { id: String(added._id), type: added.type, key: added.key, verified: !!added.verified, uploadedAt: added.uploadedAt?.toISOString() ?? null };
}
