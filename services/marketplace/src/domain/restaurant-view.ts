/** API views of restaurants (no token hashes, no encrypted settlement data). */
import type { HydratedDocument } from 'mongoose';
import type { StorageProvider } from '@thali/service-kit';
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

/** Owner / admin view of a restaurant. */
export function restaurantView(input: RestaurantHydrated | RestaurantLean, storage: StorageProvider) {
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
    address: r.address ? { line1: r.address.line1, ...(r.address.line2 ? { line2: r.address.line2 } : {}), city: r.address.city, pincode: r.address.pincode } : null,
    location: r.location?.coordinates?.length === 2 ? toLatLng(r.location) : null,
    deliveryRadiusKm: r.deliveryRadiusKm ?? 6,
    hours: (r.hours ?? []).map((s) => ({ day: s.day, open: s.open, close: s.close })),
    timezone: r.timezone ?? 'Asia/Kolkata',
    pausedUntil: iso(r.pausedUntil),
    images: {
      cover: r.images?.cover ?? null,
      logo: r.images?.logo ?? null,
      coverUrl: r.images?.cover ? storage.publicUrl(r.images.cover) : null,
      logoUrl: r.images?.logo ? storage.publicUrl(r.images.logo) : null,
    },
    documents: (r.documents ?? []).map((d) => ({
      id: String((d as { _id?: unknown })._id),
      type: d.type,
      key: d.key,
      verified: !!d.verified,
      uploadedAt: iso(d.uploadedAt),
    })),
    settlement: r.settlement?.last4 ? { accountHolder: r.settlement.accountHolder, ifsc: r.settlement.ifsc, last4: r.settlement.last4 } : null,
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
