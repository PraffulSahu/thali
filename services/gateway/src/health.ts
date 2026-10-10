/**
 * `GET /api/v1/admin/health` (ADMIN + MFA) — live fan-out to every service's `GET /internal/health/details`
 * with a gateway-issued service token (service-kit `internalClient`: correct here, unlike for proxying).
 * Each call has its own timeout (default 3 s) and no retries. An unreachable / slow / rejecting service is
 * reported `down` with the error; nothing is ever filled in on its behalf.
 */
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import { internalClient, type InternalClient, type Redis } from '@thali/service-kit';
import type { GatewayConfig } from './config.js';
import { UPSTREAM_SERVICES, type UpstreamService } from './routes-map.js';

export const ServiceHealthSchema = z
  .object({
    status: z.enum(['up', 'degraded', 'down']),
    latencyMs: z.number(),
    /** Verbatim `/internal/health/details` payload of the service (present unless `down`). */
    details: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
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

async function probe(client: InternalClient, service: UpstreamService, requestId: string): Promise<ServiceHealth> {
  const started = Date.now();
  try {
    const details = await client.get<unknown>('/internal/health/details', { requestId });
    const latencyMs = Date.now() - started;
    if (details === null || typeof details !== 'object' || Array.isArray(details)) {
      return { status: 'down', latencyMs, error: `${service} returned no health details`, errorCode: 'UPSTREAM_ERROR' };
    }
    const d = details as Record<string, unknown>;
    const degraded = d.mongo === 'down' || d.redis === 'down';
    return { status: degraded ? 'degraded' : 'up', latencyMs, details: d };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof DomainError) return { status: 'down', latencyMs, error: err.message, errorCode: err.code };
    return { status: 'down', latencyMs, error: err instanceof Error ? err.message : 'unknown error', errorCode: 'UPSTREAM_ERROR' };
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
      Promise.all(UPSTREAM_SERVICES.map(async (svc) => [svc, await probe(clients[svc], svc, requestId)] as const)),
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
