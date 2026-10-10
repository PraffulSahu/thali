/**
 * `GET /api/v1/admin/health` (ADMIN + MFA) — live fan-out to every service's `GET /internal/health/details`
 * with a gateway-issued service token (service-kit `internalClient`: correct here, unlike for proxying).
 * Each call has its own timeout (default 3 s) and no retries. An unreachable / slow / rejecting service is
 * reported `down` with the error; nothing is ever filled in on its behalf.
 *
 * GW-1: every service also gets `degradedReasons`, a one-line `summary` and `providers` (category →
 * `up | failing`), computed from the details by `explainHealth`. `down` means only "the service did not
 * answer"; a failing third-party provider (SMTP, SMS, payment, maps) makes a reachable service `degraded`
 * with the provider's last scrubbed error message, never `down`.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import { internalClient, type InternalClient, type Redis } from '@thali/service-kit';
import type { GatewayConfig } from './config.js';
import { UPSTREAM_SERVICES, type UpstreamService } from './routes-map.js';

export const ProviderStatusSchema = z.enum(['up', 'failing']);

/** Degraded thresholds (GW-1). */
export const HEALTH_THRESHOLDS = {
  /** Total provider errors in the last hour (any providers) that make a service degraded. */
  providerErrorsPerHour: 5,
  /** A provider category with this many errors in the last hour is failing… */
  providerFailingPerHour: 5,
  /**
   * …or with at least `providerRecentMinErrors` errors whose latest is within `providerRecentMs`
   * (a single blip is never "failing"). Health details only expose hourly counts + the latest error
   * time, so "≥ 2 in the last 10 min" is approximated as "≥ 2 in the last hour, the latest ≤ 10 min ago".
   */
  providerRecentMinErrors: 2,
  providerRecentMs: 10 * 60_000,
  /** Per consumed stream, entries behind (strictly greater). */
  consumerLag: 100,
  /** Oldest unpublished outbox event, seconds (strictly greater). */
  outboxOldestAgeSec: 60,
} as const;

/** Provider name (as recorded by `recordProviderError`) → category shown in the UI. Unknown names are kept as-is. */
export const PROVIDER_CATEGORY: Readonly<Record<string, string>> = {
  resend: 'email',
  mailpit: 'email',
  smtp: 'email',
  ses: 'email',
  twilio: 'sms',
  msg91: 'sms',
  razorpay: 'payment',
  google: 'maps',
  'google-geocode': 'maps',
  'google-places': 'maps',
  'google-routes': 'maps',
  'google-distance': 'maps',
};

/** Categories always listed per service (as `up` when nothing failed). */
function expectedProviders(service: string, geoProvider: string): string[] {
  if (service === 'notifications') return ['email', 'sms'];
  if (service === 'payments') return ['payment'];
  if ((service === 'marketplace' || service === 'delivery') && geoProvider === 'google') return ['maps'];
  return [];
}

export interface HealthExplanation {
  status: 'up' | 'degraded';
  degradedReasons: string[];
  summary: string;
  providers: Record<string, z.infer<typeof ProviderStatusSchema>>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** GW-1: derive status, reasons, summary and provider states from a service's `/internal/health/details`. */
export function explainHealth(service: string, d: Record<string, unknown>, opts: { now?: number; geoProvider?: string } = {}): HealthExplanation {
  const now = opts.now ?? Date.now();
  const reasons: string[] = [];
  if (d.mongo === 'down') reasons.push('database unreachable');
  if (d.redis === 'down') reasons.push('redis unreachable');

  // providers, grouped by category
  const counts = (d.providerErrorsByProvider && typeof d.providerErrorsByProvider === 'object' ? d.providerErrorsByProvider : {}) as Record<string, unknown>;
  const lasts = (d.lastProviderErrors && typeof d.lastProviderErrors === 'object' ? d.lastProviderErrors : {}) as Record<string, { message?: unknown; at?: unknown } | null>;
  const cats = new Map<string, { errors: number; lastAt: number | null; message: string | null }>();
  const cat = (name: string) => {
    const key = PROVIDER_CATEGORY[name] ?? name;
    let c = cats.get(key);
    if (!c) cats.set(key, (c = { errors: 0, lastAt: null, message: null }));
    return c;
  };
  for (const name of expectedProviders(service, opts.geoProvider ?? 'demo')) cats.set(name, { errors: 0, lastAt: null, message: null });
  for (const [name, n] of Object.entries(counts)) cat(name).errors += num(n) ?? 0;
  for (const [name, e] of Object.entries(lasts)) {
    const at = e && typeof e.at === 'string' ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(at)) continue;
    const c = cat(name);
    if (c.lastAt === null || at > c.lastAt) {
      c.lastAt = at;
      c.message = typeof e!.message === 'string' && e!.message ? e!.message : null;
    }
  }
  const providers: HealthExplanation['providers'] = {};
  let providerReason = false;
  for (const [name, c] of cats) {
    const failing =
      c.errors >= HEALTH_THRESHOLDS.providerFailingPerHour ||
      (c.errors >= HEALTH_THRESHOLDS.providerRecentMinErrors && c.lastAt !== null && now - c.lastAt <= HEALTH_THRESHOLDS.providerRecentMs);
    providers[name] = failing ? 'failing' : 'up';
    if (failing) {
      providerReason = true;
      const count = c.errors > 0 ? ` (${c.errors} error${c.errors === 1 ? '' : 's'} in the last hour)` : '';
      reasons.push(`${name} provider failing${count}${c.message ? `: ${c.message}` : ''}`);
    }
  }
  const totalErrors = num(d.providerErrorsLastHour) ?? 0;
  if (!providerReason && totalErrors >= HEALTH_THRESHOLDS.providerErrorsPerHour) reasons.push(`${totalErrors} provider errors in the last hour`);

  const lag = (d.consumerLag && typeof d.consumerLag === 'object' ? d.consumerLag : {}) as Record<string, unknown>;
  for (const [stream, v] of Object.entries(lag)) {
    const n = num(v);
    if (n !== null && n > HEALTH_THRESHOLDS.consumerLag) reasons.push(`event backlog: ${stream} ${n} behind`);
  }
  const outboxAge = num(d.outboxOldestAgeSec);
  if (outboxAge !== null && outboxAge > HEALTH_THRESHOLDS.outboxOldestAgeSec) reasons.push(`outbox: oldest unpublished event ${Math.round(outboxAge)}s old`);
  const dead = num(d.deadLetters);
  if (dead !== null && dead > 0) reasons.push(`${dead} dead letter${dead === 1 ? '' : 's'} awaiting replay`);

  return { status: reasons.length ? 'degraded' : 'up', degradedReasons: reasons, summary: summarize(reasons), providers };
}

function summarize(reasons: string[]): string {
  if (!reasons.length) return 'All checks passing';
  // Short form for provider reasons in the one-liner: "Email provider failing: <message>".
  const short = reasons.map((r) => r.replace(/^(\S+ provider failing) \(\d+ errors? in the last hour\)/, '$1'));
  const shown = short.slice(0, 3).join('; ');
  return capitalize(short.length > 3 ? `${shown}; +${short.length - 3} more` : shown);
}

export const ServiceHealthSchema = z
  .object({
    status: z.enum(['up', 'degraded', 'down']),
    latencyMs: z.number(),
    /** Verbatim `/internal/health/details` payload of the service (present unless `down`). */
    details: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
    /** GW-1: why the service is degraded (empty when up; empty when down — see `error`). */
    degradedReasons: z.array(z.string()),
    /** GW-1: one line for the admin health row. */
    summary: z.string(),
    /** GW-1: provider category (email, sms, payment, maps, or the raw provider name) → up | failing. Empty when down. */
    providers: z.record(z.string(), ProviderStatusSchema),
  })
  .meta({ id: 'ServiceHealth' });

export const HealthReportSchema = z
  .object({
    checkedAt: z.string(),
    overall: z.enum(['up', 'degraded', 'down']),
    gateway: z.object({ status: z.enum(['up', 'degraded']), mode: z.string(), redis: z.enum(['up', 'down']) }),
    services: z.record(z.string(), ServiceHealthSchema),
  })
  .meta({ id: 'HealthReport' });
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;
export type HealthReport = z.infer<typeof HealthReportSchema>;

export function upstreamUrls(config: GatewayConfig): Record<UpstreamService, string> {
  return {
    identity: config.IDENTITY_URL,
    marketplace: config.MARKETPLACE_URL,
    orders: config.ORDERS_URL,
    payments: config.PAYMENTS_URL,
    delivery: config.DELIVERY_URL,
    notifications: config.NOTIFICATIONS_URL,
  };
}

const downHealth = (latencyMs: number, error: string, errorCode: string): ServiceHealth => ({
  status: 'down',
  latencyMs,
  error,
  errorCode,
  degradedReasons: [],
  summary: `Unreachable: ${error}`,
  providers: {},
});

async function probe(client: InternalClient, service: UpstreamService, requestId: string, geoProvider: string): Promise<ServiceHealth> {
  const started = Date.now();
  try {
    const details = await client.get<unknown>('/internal/health/details', { requestId });
    const latencyMs = Date.now() - started;
    if (details === null || typeof details !== 'object' || Array.isArray(details)) {
      return downHealth(latencyMs, `${service} returned no health details`, 'UPSTREAM_ERROR');
    }
    const d = details as Record<string, unknown>;
    return { ...explainHealth(service, d, { geoProvider }), latencyMs, details: d };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof DomainError) return downHealth(latencyMs, err.message, err.code);
    return downHealth(latencyMs, err instanceof Error ? err.message : 'unknown error', 'UPSTREAM_ERROR');
  }
}

export function overallStatus(statuses: ServiceHealth['status'][]): HealthReport['overall'] {
  if (statuses.every((s) => s === 'up')) return 'up';
  if (statuses.every((s) => s === 'down')) return 'down';
  return 'degraded';
}

export function healthHandler(config: GatewayConfig, redis?: Redis): RequestHandler {
  const urls = upstreamUrls(config);
  const clients = Object.fromEntries(
    UPSTREAM_SERVICES.map((svc) => [
      svc,
      internalClient(svc, urls[svc], {
        from: 'gateway',
        secret: config.INTERNAL_SERVICE_SECRET,
        timeoutMs: config.HEALTH_TIMEOUT_MS,
        retries: 0,
      }),
    ]),
  ) as Record<UpstreamService, InternalClient>;

  return async (req, res) => {
    const requestId = String(req.id);
    const [results, redisUp] = await Promise.all([
      Promise.all(UPSTREAM_SERVICES.map(async (svc) => [svc, await probe(clients[svc], svc, requestId, config.GEO_PROVIDER)] as const)),
      redis
        ? redis.ping().then(
            () => true,
            () => false,
          )
        : Promise.resolve(false),
    ]);
    const services = Object.fromEntries(results) as Record<string, ServiceHealth>;
    const report: HealthReport = {
      checkedAt: new Date().toISOString(),
      overall: overallStatus(results.map(([, h]) => h.status)),
      gateway: { status: redisUp ? 'up' : 'degraded', mode: config.APP_MODE, redis: redisUp ? 'up' : 'down' },
      services,
    };
    res.setHeader('cache-control', 'no-store');
    res.json(report);
  };
}
