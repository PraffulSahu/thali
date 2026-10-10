/**
 * Environment configuration (LLD 2.3, 12).
 *
 * `loadConfig(shape, env)` validates the common `BaseConfig` plus a service-specific zod shape and
 * enforces the production guard: with `APP_MODE=production`, any `*_PROVIDER=mock` or truthy
 * `DEMO_*` variable (in the raw env *or* in the parsed result, so shape defaults count) is refused, and
 * so is any value carrying the `.env.example` demo-placeholder marker (see `isDemoPlaceholder`).
 */
import { z } from 'zod';
import { AppMode, enumValues, ServiceName } from '@thali/contracts';

/** Thrown for invalid/missing configuration; `issues` lists `VAR: problem` strings. */
export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Env boolean: `true|false|1|0` (case-insensitive). */
export const envBool = (def: boolean) =>
  z.stringbool({ truthy: ['true', '1'], falsy: ['false', '0'] }).default(def);

/** Env CSV list: `"a, b"` → `['a','b']` (empty → `[]`). */
export const envList = () =>
  z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    );

/** Optional URL; a blank value (`JWKS_URL=` in a .env file) counts as unset. */
export const envOptionalUrl = () => z.preprocess((v) => (v === '' ? undefined : v), z.url().optional());

/**
 * Express `trust proxy` from env: `true|false` → boolean, digits → hop count, anything else → the
 * string as-is (e.g. `loopback`, `loopback, 10.0.0.0/8`).
 */
export const envTrustProxy = (def: string) =>
  z
    .string()
    .default(def)
    .transform((v): boolean | number | string => {
      const t = v.trim();
      if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
      if (/^\d+$/.test(t)) return Number(t);
      return t;
    });

export const BaseConfigShape = {
  SERVICE_NAME: z.enum(enumValues(ServiceName)),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_MODE: z.enum(enumValues(AppMode)).default('demo'),
  MONGO_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  INTERNAL_SERVICE_SECRET: z.string().min(16),
  /** Identity JWKS endpoint; optional so identity can inject its own key set instead. */
  JWKS_URL: envOptionalUrl(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: envList(),
  DOCS_ENABLED: envBool(false),
  /** Express `trust proxy`; set the real hop count behind nginx/ALB (e.g. `1`). Default `loopback`. */
  TRUST_PROXY: envTrustProxy('loopback'),
  PUBLIC_WEB_URL: envOptionalUrl(),
  PUBLIC_API_URL: envOptionalUrl(),
  /** Prefix for Redis Streams names (`<prefix>events.orders`); unique per test file. */
  EVENT_STREAM_PREFIX: z.string().default(''),
  /** Prefix for every Redis key the kit creates (revocation, rate limit, locks, pub/sub). */
  REDIS_KEY_PREFIX: z.string().default('thali:'),
};

const BaseConfigSchema = z.object(BaseConfigShape);
export type BaseConfig = z.infer<typeof BaseConfigSchema>;

type Env = Record<string, string | undefined>;

function isTruthyFlag(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim() !== '' && !['false', '0'].includes(v.trim().toLowerCase());
  return true;
}

/**
 * Every placeholder secret in `.env.example` carries this marker (plain values start with it; base64 keys
 * decode to bytes starting with it; connection URIs embed it as the password), so a copied example file can
 * never be deployed: production refuses any env value containing it. Real secrets: `scripts/gen-env.sh`.
 */
export const DEMO_SECRET_MARKER = 'thali-demo-';

/** True for a value built from a `.env.example` demo placeholder (raw, embedded, or base64-encoded). */
export function isDemoPlaceholder(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!t) return false;
  if (t.toLowerCase().includes(DEMO_SECRET_MARKER)) return true;
  if (t.length >= 16 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
    const decoded = Buffer.from(t, 'base64').toString('latin1').toLowerCase();
    if (decoded.startsWith(DEMO_SECRET_MARKER)) return true;
  }
  return false;
}

function productionViolations(env: Env, parsed: Record<string, unknown>): string[] {
  const offending = new Map<string, string>();
  for (const source of [env, parsed]) {
    for (const [k, v] of Object.entries(source)) {
      if (/_PROVIDER$/.test(k) && typeof v === 'string' && v.trim().toLowerCase() === 'mock') offending.set(k, 'not allowed when APP_MODE=production');
      if (/^DEMO_/.test(k) && isTruthyFlag(v)) offending.set(k, 'not allowed when APP_MODE=production');
      // The value itself is never echoed: it may be a (weak) secret.
      if (!offending.has(k) && isDemoPlaceholder(v)) {
        offending.set(k, 'is a .env.example demo placeholder; generate real secrets (scripts/gen-env.sh)');
      }
    }
  }
  return [...offending.keys()].sort().map((k) => `${k}: ${offending.get(k)}`);
}

/**
 * Validate `env` against BaseConfig + `shape`. Throws `ConfigError` naming every bad variable.
 * @example
 *   export const config = loadConfig({ PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']) });
 */
export function loadConfig<T extends z.ZodRawShape>(
  shape: T,
  env: Env = process.env,
): BaseConfig & z.infer<z.ZodObject<T>> {
  const schema = z.object({ ...BaseConfigShape, ...shape });
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
    );
  }
  const cfg = result.data as Record<string, unknown>;
  if (cfg.APP_MODE === 'production') {
    const issues = productionViolations(env, cfg);
    const secret = cfg.INTERNAL_SERVICE_SECRET as string;
    if (secret.length < 32) issues.push('INTERNAL_SERVICE_SECRET: must be at least 32 characters in production');
    if (issues.length) throw new ConfigError(issues);
  }
  return result.data as BaseConfig & z.infer<z.ZodObject<T>>;
}
