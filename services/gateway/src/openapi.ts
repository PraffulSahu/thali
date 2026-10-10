/** OpenAPI registry for the gateway's own routes (proxied routes are documented by their services). */
import { z } from 'zod';
import { createOpenApi, type OpenApi } from '@thali/service-kit';
import { HealthReportSchema } from './health.js';
import { MetaSchema } from './meta.js';

export function createGatewayOpenApi(): OpenApi {
  const api = createOpenApi('gateway', {
    title: 'Thali Gateway API',
    description:
      'Gateway-owned routes. Everything else under /api/v1 is proxied to the owning service (see the service specs in /api/docs).',
  });

  api.route({
    method: 'get',
    path: '/api/v1/meta',
    tags: ['gateway'],
    summary: 'Platform mode, brand, city and provider labels (live | sandbox | demo)',
    security: 'none',
    rateLimited: true,
    responses: { 200: { description: 'Platform facts', content: { 'application/json': { schema: MetaSchema } } } },
  });

  api.route({
    method: 'get',
    path: '/api/v1/admin/health',
    tags: ['gateway', 'admin'],
    summary: 'Live health of every service (ADMIN + MFA)',
    description:
      "Fans out to each service's GET /internal/health/details (3 s timeout each). Unreachable services are reported `down` with the error. " +
      'Reachable services are `degraded` (with `degradedReasons` and a one-line `summary`) when mongo/redis is down, a provider is failing ' +
      '(≥ 5 errors in the last hour, or ≥ 2 with the latest in the last 10 min — a single blip is not failing; shown in `providers` with its last scrubbed message), total provider errors ≥ 5/h, ' +
      'any consumer lag > 100, the oldest outbox event > 60 s, or dead letters > 0. A failing provider never makes a service `down`.',
    security: 'bearer',
    errors: ['MFA_REQUIRED'],
    rateLimited: true,
    responses: { 200: { description: 'Aggregated health', content: { 'application/json': { schema: HealthReportSchema } } } },
  });

  api.route({
    method: 'get',
    path: '/api/docs',
    tags: ['gateway'],
    summary: 'Aggregated Swagger UI (only when DOCS_ENABLED=true; 404 otherwise)',
    security: 'none',
    responses: { 301: { description: 'Redirects to /api/docs/' }, 404: { description: 'Docs disabled' } },
  });

  api.route({
    method: 'get',
    path: '/api/docs/specs/:file',
    tags: ['gateway'],
    summary: 'OpenAPI spec of a service (<service>.json), proxied from the service /openapi.json',
    security: 'none',
    request: { params: z.object({ file: z.string().describe('e.g. identity.json, orders.json, gateway.json') }) },
    errors: ['NOT_FOUND', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_TIMEOUT'],
    responses: { 200: { description: 'OpenAPI 3.1 document', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } } },
  });

  return api;
}
