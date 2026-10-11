/**
 * Gateway configuration (LLD 12). Extends the service-kit BaseConfig; the gateway has no database,
 * so `MONGO_URI` is optional here.
 *
 * TRUST_PROXY (Express `trust proxy`) decides which `X-Forwarded-For` hop is "the client IP", which in
 * turn keys the per-IP rate limits and is forwarded upstream:
 *   - behind exactly one load balancer / nginx hop (docker compose `web` nginx, ALB in prod): `1`
 *   - local dev, gateway reached directly from the same machine: `loopback` (default)
 *   - directly exposed to the internet (no proxy): `false`
 * Never use `true` on an internet-facing gateway: clients could then spoof their IP by sending their own
 * `X-Forwarded-For` and sidestep the limits.
 */
import { z } from 'zod';
import { envBool, envTrustProxy, loadConfig, type BaseConfig } from '@thali/service-kit';

const upstreamUrl = (port: number) => z.url().default(`http://localhost:${port}`);

export const GatewayConfigShape = {
  SERVICE_NAME: z.literal('gateway').default('gateway'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** The gateway owns no database. */
  MONGO_URI: z.string().default(''),
  TRUST_PROXY: envTrustProxy('loopback'),

  IDENTITY_URL: upstreamUrl(4001),
  MARKETPLACE_URL: upstreamUrl(4002),
  ORDERS_URL: upstreamUrl(4003),
  PAYMENTS_URL: upstreamUrl(4004),
  DELIVERY_URL: upstreamUrl(4005),
  NOTIFICATIONS_URL: upstreamUrl(4006),

  /** Idle timeout for proxied upstream requests (not applied to SSE streams). */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(50).max(120_000).default(15_000),
  /** Per-service timeout for the admin health fan-out. */
  HEALTH_TIMEOUT_MS: z.coerce.number().int().min(50).max(30_000).default(3_000),

  /** LLD 5.4: gateway global 300/min/IP, discovery 60/min/IP, OTP 10/min/IP. */
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_DISCOVERY_PER_MIN: z.coerce.number().int().min(1).default(60),
  /**
   * Address search (MKT-1 `/discovery/places[/:id]`, `/discovery/reverse`): typing fires one request per pause and
   * several people often share one NAT IP, so it has its own larger bucket instead of eating discovery's 60.
   */
  RATE_LIMIT_PLACES_PER_MIN: z.coerce.number().int().min(1).default(180),
  RATE_LIMIT_OTP_PER_MIN: z.coerce.number().int().min(1).default(10),
  /** Admin forgot/reset password (IDN-1), per IP, fail-closed like OTP. Identity applies its own stricter limits too. */
  RATE_LIMIT_ADMIN_PASSWORD_PER_MIN: z.coerce.number().int().min(1).default(10),

  /** Inputs for `/api/v1/meta`: must mirror what the services run with. */
  BRAND_NAME: z.string().min(1).default('Thali'),
  PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']).default('mock'),
  SMS_PROVIDER: z.enum(['twilio', 'mock']).default('mock'),
  EMAIL_PROVIDER: z.enum(['resend', 'mailpit', 'mock']).default('mock'),
  GEO_PROVIDER: z.enum(['google', 'demo']).default('demo'),
  STORAGE_PROVIDER: z.enum(['s3']).default('s3'),
  /** GW-3: city shown by the SPA (`/api/v1/meta.city`). */
  CITY_NAME: z.string().trim().min(1).max(60).default('Bengaluru'),
  CITY_PILOT: envBool(true),
};

export type GatewayConfig = BaseConfig & z.infer<z.ZodObject<typeof GatewayConfigShape>>;

/** Parse + validate env (production guard from service-kit applies, e.g. mock providers are refused). */
export function loadGatewayConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const cfg = loadConfig(GatewayConfigShape, env) as GatewayConfig;
  // Access tokens are verified against identity's JWKS unless a URL is given explicitly.
  return { ...cfg, JWKS_URL: cfg.JWKS_URL ?? `${cfg.IDENTITY_URL.replace(/\/+$/, '')}/.well-known/jwks.json` };
}
