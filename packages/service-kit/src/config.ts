/**
 * Environment configuration (LLD 2.3, 12).
 *
 * `loadConfig(shape, env)` validates the common `BaseConfig` plus a service-specific zod shape and
 * enforces the production guard: with `APP_MODE=production`, any `*_PROVIDER=mock` or truthy
 * `DEMO_*` variable (in the raw env *or* in the parsed result, so shape defaults count) is refused.
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

function productionViolations(env: Env, parsed: Record<string, unknown>): string[] {
  const offending = new Set<string>();
  for (const source of [env, parsed]) {
    for (const [k, v] of Object.entries(source)) {
      if (/_PROVIDER$/.test(k) && typeof v === 'string' && v.trim().toLowerCase() === 'mock') offending.add(k);
      if (/^DEMO_/.test(k) && isTruthyFlag(v)) offending.add(k);
    }
  }
  return [...offending].sort().map((k) => `${k}: not allowed when APP_MODE=production`);
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
