/**
 * Marketplace configuration (LLD 12). Base vars come from service-kit `loadConfig`.
 */
import { z } from 'zod';
import { loadConfig, type BaseConfig } from '@thali/service-kit';

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 of exactly 32 bytes');

export const MarketplaceConfigShape = {
  SERVICE_NAME: z.literal('marketplace').default('marketplace'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4002),
  /** Mongo database name (LLD 3.2). */
  MONGO_DB_NAME: z.string().min(1).default('thali_marketplace'),
  PUBLIC_WEB_URL: z.url().default('http://localhost:5173'),
  PUBLIC_API_URL: z.url().default('http://localhost:8080'),

  GEO_PROVIDER: z.enum(['google', 'demo']).default('demo'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  ROAD_FACTOR: z.coerce.number().positive().default(1.3),
  AVG_SPEED_KMPH: z.coerce.number().positive().default(20),

  STORAGE_PROVIDER: z.literal('s3').default('s3'),
  S3_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BUCKET: z.string().default('thali-public'),
  S3_PRIVATE_BUCKET: z.string().default('thali-private'),
  S3_PUBLIC_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),

  /** AES-256-GCM key for settlement account numbers (base64, 32 bytes). */
  FIELD_ENCRYPTION_KEY: base64Key32,
  /** Document types required before submit (PRD R-1 "FSSAI, GST, PAN — configurable"). CSV; empty = none. */
  REQUIRED_DOCUMENT_TYPES: z
    .string()
    .default('FSSAI,GST,PAN')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
    ),
  /** Upper bound on any restaurant's delivery radius (candidate pre-filter for discovery). */
  MAX_DELIVERY_RADIUS_KM: z.coerce.number().positive().default(15),

  IDENTITY_URL: z.url().default('http://localhost:4001'),
  ORDERS_URL: z.url().default('http://localhost:4003'),
  PAYMENTS_URL: z.url().default('http://localhost:4004'),

  // Task 9: reservation expiry sweeper
  /** How long after `expiresAt` a HELD reservation is left alone before the sweeper asks orders. */
  RESERVATION_GRACE_SEC: z.coerce.number().int().min(0).default(300),
  /** Extension applied when orders reports the checkout still AWAITING_PAYMENT. */
  RESERVATION_EXTEND_SEC: z.coerce.number().int().min(30).default(300),
  RESERVATION_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
  INTERNAL_HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).default(3000),
};

export type MarketplaceConfig = BaseConfig & {
  [K in keyof typeof MarketplaceConfigShape]: z.output<(typeof MarketplaceConfigShape)[K]>;
};

export function loadMarketplaceConfig(env: Record<string, string | undefined> = process.env): MarketplaceConfig {
  return loadConfig(MarketplaceConfigShape, env) as MarketplaceConfig;
}
