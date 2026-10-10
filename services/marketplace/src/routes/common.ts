/** Shared request/response schemas and helpers for marketplace route modules. */
import type { Request } from 'express';
import { z } from 'zod';
import { HoursSlotSchema, ObjectIdSchema, PaiseSchema, RestaurantAddressSchema, RestaurantStatusSchema } from '@thali/contracts';

export const API = '/api/v1';

export const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

export function userIdOf(req: Request): string {
  return req.auth!.userId;
}

export const RestaurantIdParams = z.object({ id: z.string().min(1).max(64) });

export const LatLngQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

/** `"a, b"` → `['a','b']`; empty/absent → undefined (pipe into a typed array schema). */
export const splitCsv = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

export const boolQuery = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

export const ReasonBody = z.object({ reason: z.string().trim().min(1).max(500) });
export const OptionalReasonBody = z.object({ reason: z.string().trim().min(1).max(500).optional() });

export const GeoPointView = z.object({ lat: z.number(), lng: z.number() });

export const RatingView = z.object({ average: z.number(), count: z.number().int() }).nullable().meta({
  id: 'RestaurantRating',
  description: 'Null when the restaurant has fewer than 5 real ratings (show "New").',
});

export const RestaurantView = z
  .object({
    id: ObjectIdSchema,
    ownerUserId: z.string(),
    status: RestaurantStatusSchema,
    statusReason: z.string().nullable(),
    statusHistory: z.array(z.object({ from: z.string(), to: z.string(), actorId: z.string(), reason: z.string().nullable(), at: z.string() })),
    businessName: z.string().nullable(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    cuisines: z.array(z.string()),
    phone: z.string().nullable(),
    businessEmail: z.string().nullable(),
    emailVerified: z.boolean(),
    emailVerifiedAt: z.string().nullable(),
    emailVerification: z.object({ sentAt: z.string().nullable(), expiresAt: z.string().nullable() }).nullable(),
    address: RestaurantAddressSchema.nullable(),
    location: GeoPointView.nullable(),
    deliveryRadiusKm: z.number(),
    hours: z.array(HoursSlotSchema),
    timezone: z.string(),
    pausedUntil: z.string().nullable(),
    images: z.object({ cover: z.string().nullable(), logo: z.string().nullable(), coverUrl: z.string().nullable(), logoUrl: z.string().nullable() }),
    documents: z.array(z.object({ id: z.string(), type: z.string(), key: z.string(), verified: z.boolean(), uploadedAt: z.string().nullable() })),
    settlement: z.object({ accountHolder: z.string(), ifsc: z.string(), last4: z.string() }).nullable(),
    packagingFeePaise: PaiseSchema,
    avgPrepMinutes: z.number(),
    commissionBps: z.number(),
    rating: RatingView,
    isDemo: z.boolean(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: 'OwnerRestaurant' });

export const PresignView = z
  .object({
    key: z.string(),
    bucket: z.enum(['public', 'private']),
    upload: z.object({ url: z.string(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()), expiresAt: z.string(), maxBytes: z.number() }),
  })
  .meta({ id: 'PresignedUpload' });

export const UploadBody = z.object({
  contentType: z.string().min(3).max(100),
  /** client-declared exact size; signed into the URL (≤ type max) */
  sizeBytes: z.number().int().positive(),
});
