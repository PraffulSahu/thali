/**
 * OpenAPI 3.1 helpers on top of @asteasolutions/zod-to-openapi (v8, zod v4).
 *
 * `createOpenApi(service)` returns `{ registry, route(def), document() }`:
 *  - `route()` accepts Express-style paths (`/orders/:id` → `/orders/{id}`), a `security` shorthand
 *    (`'bearer' | 'internal' | 'none'`), and adds standard error responses (ErrorEnvelope schema):
 *    500 always; 400 when the route has request params/query/body/headers; 401+403 when secured;
 *    429 when `rateLimited`; `Idempotency-Key` header + 400/409 codes when `idempotent`; plus one
 *    response per status for every code in `errors`.
 *  - kit routes (`/health/live`, `/health/ready`, `/openapi.json`, `/internal/routes`) are
 *    pre-registered so OpenAPI coverage of `GET /internal/routes` is complete.
 *
 * Importing this module calls `extendZodWithOpenApi(z)`, so `.openapi(...)` is available on zod
 * schemas created AFTER the import. Schemas created earlier (e.g. everything in @thali/contracts)
 * lack `.openapi()` because zod v4 copies prototype methods at construction — name/describe those
 * with zod's native `.meta({ id: 'Name', description, example })`, which zod-to-openapi v8 reads.
 */
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type ResponseConfig,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ERROR_STATUS, ErrorEnvelopeSchema, IdempotencyKeySchema, type ErrorCode } from '@thali/contracts';

extendZodWithOpenApi(z);

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

export const BEARER_SCHEME = 'bearerAuth';
export const SERVICE_TOKEN_SCHEME = 'serviceToken';

export interface KitRouteConfig extends Omit<RouteConfig, 'security' | 'path'> {
  /** Express-style or OpenAPI-style path. */
  path: string;
  /** Default `'none'` (public). */
  security?: 'bearer' | 'internal' | 'none';
  /** Extra documented error codes (grouped by their HTTP status). */
  errors?: ErrorCode[];
  rateLimited?: boolean;
  /** Documents the `Idempotency-Key` header (required) and its error codes. */
  idempotent?: boolean;
}

export interface OpenApi {
  readonly serviceName: string;
  readonly registry: OpenAPIRegistry;
  route(def: KitRouteConfig): void;
  document(): OpenApiDocument;
}

export interface CreateOpenApiOptions {
  title?: string;
  version?: string;
  description?: string;
  servers?: { url: string; description?: string }[];
}

/** `/orders/:id` → `/orders/{id}`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)\??/g, '{$1}');
}

const json = (schema: z.ZodType) => ({ 'application/json': { schema } });

export function createOpenApi(serviceName: string, opts: CreateOpenApiOptions = {}): OpenApi {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', BEARER_SCHEME, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'User access token (EdDSA JWT from identity)',
  });
  registry.registerComponent('securitySchemes', SERVICE_TOKEN_SCHEME, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Internal service token (HS256, iss=<caller>, aud=<callee>, 60 s)',
  });
  // `.meta({ id })` rather than `registry.register()`: zod v4 copies prototype methods at
  // construction, so schemas created before `extendZodWithOpenApi` (all of @thali/contracts) have
  // no `.openapi()`; zod-to-openapi v8 reads `id` from zod's global registry instead.
  const ErrorEnvelope = ErrorEnvelopeSchema.meta({ id: 'ErrorEnvelope' });

  const errorResponse = (codes: ErrorCode[]): ResponseConfig => ({
    description: `Error: ${codes.join(' | ')}`,
    content: json(ErrorEnvelope),
  });

  function route(def: KitRouteConfig): void {
    const { security = 'none', errors = [], rateLimited, idempotent, path, responses, request, ...rest } = def;
    const byStatus = new Map<number, Set<ErrorCode>>();
    const add = (code: ErrorCode) => {
      const status = ERROR_STATUS[code];
      if (!byStatus.has(status)) byStatus.set(status, new Set());
      byStatus.get(status)!.add(code);
    };

    let req = request;
    if (idempotent) {
      const idemHeader = z.object({ 'idempotency-key': IdempotencyKeySchema });
      const existing = req?.headers;
      const headers = existing instanceof z.ZodObject ? existing.extend(idemHeader.shape) : idemHeader;
      req = { ...req, headers };
      add('IDEMPOTENCY_KEY_REQUIRED');
      add('IDEMPOTENCY_CONFLICT');
      add('IDEMPOTENCY_IN_PROGRESS');
    }
    if (req && (req.body || req.params || req.query || req.headers)) add('VALIDATION_FAILED');
    if (security !== 'none') {
      add('UNAUTHENTICATED');
      add('FORBIDDEN');
    }
    if (security === 'bearer') add('SESSION_REVOKED');
    if (rateLimited) add('RATE_LIMITED');
    errors.forEach(add);
    add('INTERNAL_ERROR');

    const allResponses: RouteConfig['responses'] = { ...responses };
    for (const [status, codes] of byStatus) {
      if (allResponses[String(status)]) continue;
      const res = errorResponse([...codes]);
      if (status === 429) res.headers = z.object({ 'Retry-After': z.string().describe('Seconds until retry') });
      allResponses[String(status)] = res;
    }

    registry.registerPath({
      ...rest,
      method: def.method,
      path: toOpenApiPath(path),
      ...(req ? { request: req } : {}),
      security:
        security === 'bearer' ? [{ [BEARER_SCHEME]: [] }] : security === 'internal' ? [{ [SERVICE_TOKEN_SCHEME]: [] }] : [],
      responses: allResponses,
    });
  }

  // kit routes (mounted by createApp)
  route({
    method: 'get',
    path: '/health/live',
    tags: ['health'],
    summary: 'Liveness probe',
    responses: { 200: { description: 'Process is up', content: json(z.object({ status: z.literal('ok') })) } },
  });
  const Ready = z.object({ status: z.enum(['ok', 'unavailable']), checks: z.record(z.string(), z.enum(['up', 'down'])) });
  route({
    method: 'get',
    path: '/health/ready',
    tags: ['health'],
    summary: 'Readiness probe (dependency checks)',
    responses: {
      200: { description: 'Ready', content: json(Ready) },
      503: { description: 'A dependency is down', content: json(Ready) },
    },
  });
  route({
    method: 'get',
    path: '/openapi.json',
    tags: ['meta'],
    summary: 'This OpenAPI document',
    responses: { 200: { description: 'OpenAPI 3.1 document', content: json(z.record(z.string(), z.unknown())) } },
  });
  route({
    method: 'get',
    path: '/internal/routes',
    tags: ['internal'],
    summary: 'Registered Express routes (OpenAPI coverage checks)',
    security: 'internal',
    responses: {
      200: { description: 'Routes', content: json(z.array(z.object({ method: z.string(), path: z.string() }))) },
    },
  });

  return {
    serviceName,
    registry,
    route,
    document() {
      return new OpenApiGeneratorV31(registry.definitions).generateDocument({
        openapi: '3.1.0',
        info: {
          title: opts.title ?? `Thali ${serviceName} API`,
          version: opts.version ?? '1.0.0',
          ...(opts.description ? { description: opts.description } : {}),
        },
        ...(opts.servers ? { servers: opts.servers } : {}),
      });
    },
  };
}
