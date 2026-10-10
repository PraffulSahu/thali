/**
 * Delivery service configuration (LLD 7 dispatch/batching policy, LLD 12 delivery env).
 */
import { z } from 'zod';
import { envOptionalUrl, loadConfig } from '@thali/service-kit';

const num = (def: number) => z.coerce.number().positive().default(def);
const int = (def: number) => z.coerce.number().int().positive().default(def);

/** CSV of positive km values, e.g. `3,5,8`; the last value repeats for later rounds. */
const kmList = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s, ctx) => {
      const values = s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map(Number);
      if (!values.length || values.some((v) => !Number.isFinite(v) || v <= 0)) {
        ctx.addIssue({ code: 'custom', message: 'expected a CSV of positive numbers, e.g. 3,5,8' });
        return z.NEVER;
      }
      return values;
    });

export const deliveryConfigShape = {
  SERVICE_NAME: z.literal('delivery').default('delivery'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4005),

  // LLD 7 policy
  MAX_ACTIVE_DELIVERIES: int(2),
  OFFER_TTL_SEC: int(45),
  OFFERS_PER_ROUND: int(3),
  DISPATCH_RADIUS_KM: kmList('3,5,8'),
  MAX_DISPATCH_ROUNDS: int(5),
  BATCH_PICKUP_RADIUS_KM: num(1.5),
  BATCH_DROP_RADIUS_KM: num(3),
  BATCH_MAX_EXTRA_MINUTES: num(12),
  LOCATION_STALE_SEC: int(60),
  AVG_SPEED_KMPH: num(20),
  ROAD_FACTOR: num(1.3),
  /** LLD 7: candidates must have pinged within this window. */
  DISPATCH_LOCATION_MAX_AGE_SEC: int(120),
  DISPATCH_INTERVAL_MS: int(5000),
  /** LLD 5.4: location ping 1 per 3 s per partner. */
  LOCATION_PING_INTERVAL_SEC: int(3),
  /** LLD 4.5: wrong handover-code attempts before lock. */
  CODE_MAX_ATTEMPTS: int(5),

  // providers
  GEO_PROVIDER: z.enum(['google', 'demo']).default('demo'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  /** Browser-reachable endpoint for presigned URLs (compose: http://localhost:9000 while S3_ENDPOINT=http://minio:9000). */
  S3_PUBLIC_ENDPOINT: envOptionalUrl(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BUCKET: z.string().default('thali-public'),
  S3_PRIVATE_BUCKET: z.string().default('thali-private'),
  S3_PUBLIC_BASE_URL: envOptionalUrl(),
  /** KYC upload cap (bytes). */
  PARTNER_DOC_MAX_BYTES: int(5 * 1024 * 1024),

  // other services
  IDENTITY_URL: z.string().url().default('http://localhost:4001'),

  // demo simulator (APP_MODE=demo only)
  SIMULATOR_STEP_MS: int(2000),
};

export type DeliveryConfig = ReturnType<typeof parseDeliveryConfig>;

export function parseDeliveryConfig(env: Record<string, string | undefined> = process.env) {
  return loadConfig(deliveryConfigShape, env);
}
