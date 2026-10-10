/** API views of restaurants (no token hashes, no encrypted settlement data). */
import type { HydratedDocument } from 'mongoose';
import type { RestaurantDoc } from '../models/restaurant.js';
import { toLatLng } from './serviceability.js';

export type RestaurantHydrated = HydratedDocument<RestaurantDoc>;
export type RestaurantLean = RestaurantDoc & { _id: unknown; createdAt?: Date; updatedAt?: Date };

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

export function ratingOf(r: { ratingSum?: number | null; ratingCount?: number | null }) {
  const count = r.ratingCount ?? 0;
  if (count < 5) return null; // never show a rating from fewer than 5 real ratings
  return { average: Math.round(((r.ratingSum ?? 0) / count) * 10) / 10, count };
}

/** Image ref → public URL (`ctx.imageUrl`, MKT-10 `resolveImageUrl`). */
export type ImageUrlFn = (ref: string | null | undefined) => string | null;

/** `address` view incl. MKT-5 `locality` (omitted when unset). */
export function addressView(a: RestaurantLean['address']) {
  if (!a?.line1) return null;
  return { line1: a.line1, ...(a.line2 ? { line2: a.line2 } : {}), ...(a.locality ? { locality: a.locality } : {}), city: a.city!, pincode: a.pincode! };
}

/** Owner / admin view of a restaurant. */
export function restaurantView(input: RestaurantHydrated | RestaurantLean, imageUrl: ImageUrlFn) {
  const r = ('toObject' in input && typeof input.toObject === 'function' ? input.toObject() : input) as RestaurantLean;
  return {
    id: String(r._id),
    ownerUserId: r.ownerUserId,
    status: r.status,
    statusReason: r.statusReason ?? null,
    statusHistory: (r.statusHistory ?? []).map((h) => ({
      from: h.from,
      to: h.to,
      actorId: h.actorId,
      reason: h.reason ?? null,
      at: iso(h.at),
    })),
    businessName: r.businessName ?? null,
    name: r.name,
    slug: r.slug,
    description: r.description ?? null,
    cuisines: r.cuisines ?? [],
    phone: r.phone ?? null,
    businessEmail: r.businessEmail ?? null,
    emailVerified: !!r.emailVerifiedAt,
    emailVerifiedAt: iso(r.emailVerifiedAt),
    emailVerification: r.emailVerification && !r.emailVerification.usedAt
      ? { sentAt: iso(r.emailVerification.sentAt), expiresAt: iso(r.emailVerification.expiresAt) }
      : null,
    address: addressView(r.address),
    location: r.location?.coordinates?.length === 2 ? toLatLng(r.location) : null,
    deliveryRadiusKm: r.deliveryRadiusKm ?? 6,
    hours: (r.hours ?? []).map((s) => ({ day: s.day, open: s.open, close: s.close })),
    timezone: r.timezone ?? 'Asia/Kolkata',
    pausedUntil: iso(r.pausedUntil),
    images: {
      cover: r.images?.cover ?? null,
      logo: r.images?.logo ?? null,
      coverUrl: imageUrl(r.images?.cover),
      logoUrl: imageUrl(r.images?.logo),
    },
    documents: (r.documents ?? []).map((d) => ({
      id: String((d as { _id?: unknown })._id),
      type: d.type,
      key: d.key,
      verified: !!d.verified,
      uploadedAt: iso(d.uploadedAt),
    })),
    settlement: r.settlement?.last4 ? { accountHolder: r.settlement.accountHolder, ifsc: r.settlement.ifsc, last4: r.settlement.last4 } : null,
    pureVeg: r.pureVeg === true,
    /** Menu signal for the owner UI ("your menu is all veg — declare pure veg?"); never shown as a claim. */
    menuAllVeg: !!r.menuStats?.itemCount && r.menuStats.nonVegCount === 0,
    packagingFeePaise: r.packagingFeePaise ?? 0,
    avgPrepMinutes: r.avgPrepMinutes ?? 20,
    commissionBps: r.commissionBps ?? 1800,
    rating: ratingOf(r),
    isDemo: !!r.isDemo,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}
export type RestaurantView = ReturnType<typeof restaurantView>;
