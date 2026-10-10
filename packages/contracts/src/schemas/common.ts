import { z } from 'zod';
import { CURRENCY, enumValues } from '../enums.js';
import { ERROR_STATUS } from '../errors.js';
import { normalizePhone } from '../phone.js';

/** Mongo ObjectId as a 24-char hex string (external id format, LLD 1.1). */
export const ObjectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

/** ISO-8601 UTC timestamp string (`...Z`). */
export const IsoDateTimeSchema = z.iso.datetime();

/** Integer, non-negative paise. */
export const PaiseSchema = z.number().int().nonnegative();

/** `{ amountPaise, currency: 'INR' }`; currency defaults to INR. */
export const MoneySchema = z.object({
  amountPaise: PaiseSchema,
  currency: z.literal(CURRENCY).default(CURRENCY),
});
export type Money = z.infer<typeof MoneySchema>;

/** Basis points (500 = 5%). */
export const BpsSchema = z.number().int().min(0).max(10_000);

/**
 * Phone: accepts any input `normalizePhone` accepts and outputs E.164 (`+919876543210`).
 * Non-mobile / invalid -> zod issue `Enter a valid mobile number`.
 */
export const PhoneSchema = z.string().transform((value, ctx) => {
  try {
    return normalizePhone(value);
  } catch {
    ctx.issues.push({ code: 'custom', message: 'Enter a valid mobile number', input: value });
    return z.NEVER;
  }
});

/** API/web shape for a coordinate. */
export const GeoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPointSchema>;

/** GeoJSON Point as stored in Mongo / carried in events: `coordinates = [lng, lat]`. */
export const GeoJsonPointSchema = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
});
export type GeoJsonPoint = z.infer<typeof GeoJsonPointSchema>;

export function toGeoJsonPoint(p: GeoPoint): GeoJsonPoint {
  return { type: 'Point', coordinates: [p.lng, p.lat] };
}
export function fromGeoJsonPoint(g: GeoJsonPoint): GeoPoint {
  return { lat: g.coordinates[1], lng: g.coordinates[0] };
}

/** `Idempotency-Key` header: 8-128 chars `[A-Za-z0-9_-]` (LLD 1.4). */
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'Invalid Idempotency-Key');

/** Cursor pagination query (LLD 1.3): `?limit=20&cursor=<opaque>`. */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/** `{ items, nextCursor }` page wrapper for any item schema. */
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
export type Paginated<T> = { items: T[]; nextCursor: string | null };

/** Error envelope (LLD 1.2). `code` is any known ErrorCode. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(Object.keys(ERROR_STATUS) as [keyof typeof ERROR_STATUS, ...(keyof typeof ERROR_STATUS)[]]),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Build `z.enum` from a const enum object (e.g. `zEnum(ChildOrderStatus)`). */
export function zEnum<T extends Record<string, string>>(o: T) {
  return z.enum(enumValues(o));
}
