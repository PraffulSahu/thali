/**
 * Identity configuration (LLD §12): BaseConfig + identity-specific env.
 */
import { z } from 'zod';
import { tryNormalizePhone } from '@thali/contracts';
import { ConfigError, envBool, envList, loadConfig, type BaseConfig } from '@thali/service-kit';

const optionalString = () => z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const intEnv = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

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

  NOTIFICATIONS_URL: z.url().default('http://localhost:4006'),
  ORDERS_URL: z.url().default('http://localhost:4003'),
};

type RawIdentityConfig = BaseConfig & z.infer<z.ZodObject<typeof identityConfigShape>>;
export type IdentityConfig = Omit<RawIdentityConfig, 'COOKIE_SECURE' | 'DEMO_PHONES' | 'CSRF_ALLOWED_ORIGINS'> & {
  COOKIE_SECURE: boolean;
  /** Normalized E.164. */
  DEMO_PHONES: string[];
  CSRF_ALLOWED_ORIGINS: string[];
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
  if (issues.length) throw new ConfigError(issues);

  const origins = new Set<string>(raw.CSRF_ALLOWED_ORIGINS.length ? raw.CSRF_ALLOWED_ORIGINS : raw.CORS_ORIGINS);
  if (!raw.CSRF_ALLOWED_ORIGINS.length && raw.PUBLIC_WEB_URL) origins.add(new URL(raw.PUBLIC_WEB_URL).origin);

  return {
    ...raw,
    COOKIE_SECURE: raw.COOKIE_SECURE ?? raw.APP_MODE !== 'demo',
    DEMO_PHONES: demoPhones,
    CSRF_ALLOWED_ORIGINS: [...origins].map((o) => o.replace(/\/+$/, '')),
  };
}

/** Demo OTP (123456) applies only in demo mode, with the flag on, for a listed phone. */
export function demoOtpAllowed(config: Pick<IdentityConfig, 'APP_MODE' | 'DEMO_OTP_ENABLED' | 'DEMO_PHONES'>, phone: string): boolean {
  return config.APP_MODE === 'demo' && config.DEMO_OTP_ENABLED && config.DEMO_PHONES.includes(phone);
}
