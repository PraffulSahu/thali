/**
 * Identity configuration (LLD §12): BaseConfig + identity-specific env.
 */
import { z } from 'zod';
import { tryNormalizePhone } from '@thali/contracts';
import { ConfigError, envBool, envList, loadConfig, parseExternalImageHosts, type BaseConfig } from '@thali/service-kit';

const optionalString = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const optionalUrl = () => z.preprocess((v) => (v === '' ? undefined : v), z.url().optional());
const intEnv = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

export const DEFAULT_DEMO_PHONE_PREFIXES = '+91900,+91910,+91920,+91930';

export const identityConfigShape = {
  SERVICE_NAME: z.literal('identity').default('identity'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),

  /** Ed25519 PKCS#8 PEM. Required in production; demo/sandbox auto-generate into `signing_keys`. */
  JWT_PRIVATE_KEY_PEM: optionalString(),
  /** Optional SPKI PEM; if set it must match the private key. */
  JWT_PUBLIC_KEY_PEM: optionalString(),
  /** Optional explicit `kid` for the env key (default: RFC 7638 thumbprint). */
  JWT_KID: optionalString(),
  ACCESS_TOKEN_TTL_SEC: intEnv(900, 60),

  /** HMAC key for OTP code hashes. */
  OTP_PEPPER: z.string().min(16),
  OTP_TTL_SEC: intEnv(300, 30),
  OTP_RESEND_COOLDOWN_SEC: intEnv(30),
  OTP_MAX_PER_HOUR: intEnv(5, 1),
  OTP_MAX_PER_IP_PER_HOUR: intEnv(20, 1),
  OTP_MAX_ATTEMPTS: intEnv(5, 1),
  DEMO_OTP_ENABLED: envBool(false),
  /** CSV of phones (any accepted format) for which demo code 123456 works (demo mode only). */
  DEMO_PHONES: envList(),
  /**
   * CSV of E.164 prefixes whose phones also get the demo code (demo mode only, with DEMO_OTP_ENABLED).
   * Default covers the generated Bengaluru seed: consumers +91910…, owners +91920…, partners +91930…
   * (and the hand-written +91900… demo users). Unset → that default in demo mode, none elsewhere.
   * Ignored outside APP_MODE=demo (and refused in production by the DEMO_* guard).
   */
  DEMO_PHONE_PREFIXES: optionalString(),

  /** base64 of 32 bytes (AES-256-GCM for TOTP secrets and generated signing keys). */
  FIELD_ENCRYPTION_KEY: z.string().refine((s) => Buffer.from(s, 'base64').length === 32, 'must be base64 of 32 bytes'),

  SESSION_DAYS: intEnv(30, 1),
  ADMIN_SESSION_HOURS: intEnv(12, 1),
  REFRESH_REUSE_GRACE_SEC: intEnv(10),
  /** Refresh cookie `Secure` flag. Default: true unless APP_MODE=demo (demo is served over plain http). */
  COOKIE_SECURE: z.preprocess((v) => (v === '' ? undefined : v), z.stringbool({ truthy: ['true', '1'], falsy: ['false', '0'] }).optional()),
  /** Origins allowed on cookie endpoints (refresh/logout). Default: CORS_ORIGINS + origin of PUBLIC_WEB_URL. */
  CSRF_ALLOWED_ORIGINS: envList(),

  ADMIN_LOGIN_MAX_PER_WINDOW: intEnv(10, 1),
  ADMIN_LOGIN_WINDOW_SEC: intEnv(900, 1),
  ADMIN_MAX_FAILED_ATTEMPTS: intEnv(5, 1),
  ADMIN_LOCK_MINUTES: intEnv(15, 1),
  TOTP_ISSUER: z.string().default('Thali'),
  /** IDN-1 forgot-password: requests per email per ADMIN_LOGIN_WINDOW_SEC (per-IP uses ADMIN_LOGIN_MAX_PER_WINDOW). */
  ADMIN_RESET_MAX_PER_EMAIL: intEnv(3, 1),

  /** IDN-3 avatars: public-bucket S3 storage (same variables as marketplace). */
  STORAGE_PROVIDER: z.literal('s3').default('s3'),
  S3_ENDPOINT: optionalUrl(),
  /** Browser-reachable endpoint for presigned URLs (compose: http://localhost:9000 while S3_ENDPOINT=http://minio:9000). */
  S3_PUBLIC_ENDPOINT: optionalUrl(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: optionalString(),
  S3_SECRET_ACCESS_KEY: optionalString(),
  S3_PUBLIC_BUCKET: z.string().default('thali-public'),
  S3_PUBLIC_BASE_URL: optionalUrl(),
  /** Hosts whose absolute https image refs (seed/admin only) are served as-is; default per service-kit, `none` = []. */
  EXTERNAL_IMAGE_HOSTS: optionalString(),

  NOTIFICATIONS_URL: z.url().default('http://localhost:4006'),
  ORDERS_URL: z.url().default('http://localhost:4003'),
};

type RawIdentityConfig = BaseConfig & z.infer<z.ZodObject<typeof identityConfigShape>>;
export type IdentityConfig = Omit<
  RawIdentityConfig,
  'COOKIE_SECURE' | 'DEMO_PHONES' | 'DEMO_PHONE_PREFIXES' | 'CSRF_ALLOWED_ORIGINS' | 'EXTERNAL_IMAGE_HOSTS'
> & {
  COOKIE_SECURE: boolean;
  /** Normalized E.164. */
  DEMO_PHONES: string[];
  /** E.164 prefixes (`+` and 3-14 digits). */
  DEMO_PHONE_PREFIXES: string[];
  CSRF_ALLOWED_ORIGINS: string[];
  /** Parsed allowlist for `resolveImageUrl`. */
  EXTERNAL_IMAGE_HOSTS: string[];
};

export function loadIdentityConfig(env: Record<string, string | undefined> = process.env): IdentityConfig {
  const raw = loadConfig(identityConfigShape, env);
  const issues: string[] = [];
  if (raw.APP_MODE === 'production' && !raw.JWT_PRIVATE_KEY_PEM) {
    issues.push('JWT_PRIVATE_KEY_PEM: required when APP_MODE=production');
  }
  if (raw.APP_MODE === 'production' && raw.COOKIE_SECURE === false) {
    issues.push('COOKIE_SECURE: must not be false when APP_MODE=production (refresh cookie must be Secure)');
  }
  const demoPhones: string[] = [];
  for (const p of raw.DEMO_PHONES) {
    const n = tryNormalizePhone(p);
    if (!n) issues.push(`DEMO_PHONES: invalid phone "${p}"`);
    else demoPhones.push(n);
  }
  const demoPrefixes: string[] = [];
  const prefixCsv = raw.DEMO_PHONE_PREFIXES ?? (raw.APP_MODE === 'demo' ? DEFAULT_DEMO_PHONE_PREFIXES : '');
  for (const p of prefixCsv.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (!/^\+\d{3,14}$/.test(p)) issues.push(`DEMO_PHONE_PREFIXES: invalid prefix "${p}" (use E.164 digits, e.g. +91910)`);
    else demoPrefixes.push(p);
  }
  let externalImageHosts: string[] = [];
  try {
    externalImageHosts = parseExternalImageHosts(raw.EXTERNAL_IMAGE_HOSTS);
  } catch (e) {
    issues.push((e as Error).message);
  }
  if (issues.length) throw new ConfigError(issues);

  const origins = new Set<string>(raw.CSRF_ALLOWED_ORIGINS.length ? raw.CSRF_ALLOWED_ORIGINS : raw.CORS_ORIGINS);
  if (!raw.CSRF_ALLOWED_ORIGINS.length && raw.PUBLIC_WEB_URL) origins.add(new URL(raw.PUBLIC_WEB_URL).origin);

  return {
    ...raw,
    COOKIE_SECURE: raw.COOKIE_SECURE ?? raw.APP_MODE !== 'demo',
    DEMO_PHONES: demoPhones,
    DEMO_PHONE_PREFIXES: demoPrefixes,
    EXTERNAL_IMAGE_HOSTS: externalImageHosts,
    CSRF_ALLOWED_ORIGINS: [...origins].map((o) => o.replace(/\/+$/, '')),
  };
}

/** Demo OTP (123456) applies only in demo mode, with the flag on, for a listed phone or a phone with a demo prefix. */
export function demoOtpAllowed(
  config: Pick<IdentityConfig, 'APP_MODE' | 'DEMO_OTP_ENABLED' | 'DEMO_PHONES'> & Partial<Pick<IdentityConfig, 'DEMO_PHONE_PREFIXES'>>,
  phone: string,
): boolean {
  if (config.APP_MODE !== 'demo' || !config.DEMO_OTP_ENABLED) return false;
  return config.DEMO_PHONES.includes(phone) || (config.DEMO_PHONE_PREFIXES ?? []).some((p) => phone.startsWith(p));
}

/** Web origin used in links sent by email (admin password reset). */
export function webBaseUrl(config: Pick<IdentityConfig, 'PUBLIC_WEB_URL'>): string {
  return (config.PUBLIC_WEB_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
}
