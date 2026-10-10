/**
 * Aggregated Swagger UI at `/api/docs` (only when `DOCS_ENABLED=true`; otherwise nothing is mounted and
 * the paths 404). `/api/docs/specs/<svc>.json` proxies each service's `/openapi.json` (internal and
 * health paths removed: they are not reachable through the gateway); the explorer dropdown lists them all.
 */
import type { Express, RequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';
import { DomainError } from '@thali/contracts';
import type { OpenApi } from '@thali/service-kit';
import type { GatewayConfig } from './config.js';
import { upstreamUrls } from './health.js';
import { UPSTREAM_SERVICES, type UpstreamService } from './routes-map.js';

const SPEC_TIMEOUT_MS = 3000;
const HIDDEN_PATH = /^\/(internal|health)(\/|$)|^\/openapi\.json$/;

export const DOC_SERVICES = [...UPSTREAM_SERVICES, 'gateway'] as const;
export const specUrl = (name: string) => `/api/docs/specs/${name}.json`;

/** Swagger UI needs inline script + styles for its bootstrap; scope that CSP relaxation to the docs only. */
const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

async function fetchSpec(service: UpstreamService, baseUrl: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/openapi.json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(SPEC_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = (err as { name?: string }).name === 'TimeoutError';
    throw timeout
      ? new DomainError('UPSTREAM_TIMEOUT', `${service} did not serve its OpenAPI spec in time`, undefined, { service })
      : new DomainError('UPSTREAM_UNAVAILABLE', `${service} is unreachable`, undefined, { service });
  }
  if (!res.ok) throw new DomainError('UPSTREAM_ERROR', `${service} answered ${res.status} for /openapi.json`, undefined, { service });
  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    throw new DomainError('UPSTREAM_ERROR', `${service} returned an invalid OpenAPI document`, undefined, { service });
  }
  if (doc === null || typeof doc !== 'object') {
    throw new DomainError('UPSTREAM_ERROR', `${service} returned an invalid OpenAPI document`, undefined, { service });
  }
  const spec = doc as { paths?: Record<string, unknown> };
  if (spec.paths) {
    spec.paths = Object.fromEntries(Object.entries(spec.paths).filter(([p]) => !HIDDEN_PATH.test(p)));
  }
  return spec as Record<string, unknown>;
}

export function registerDocs(app: Express, config: GatewayConfig, gatewaySpec: OpenApi): void {
  if (!config.DOCS_ENABLED) return;
  const urls = upstreamUrls(config);
  const names = new Set<string>(DOC_SERVICES);

  const csp: RequestHandler = (_req, res, next) => {
    res.setHeader('content-security-policy', DOCS_CSP);
    next();
  };

  app.get('/api/docs/specs/:file', async (req, res) => {
    const m = /^([a-z]+)\.json$/.exec(String(req.params.file));
    const name = m?.[1];
    if (!name || !names.has(name)) throw new DomainError('NOT_FOUND', 'Unknown API spec');
    const spec = name === 'gateway' ? gatewaySpec.document() : await fetchSpec(name as UpstreamService, urls[name as UpstreamService]);
    res.setHeader('cache-control', 'no-store');
    res.json(spec);
  });

  const specList = DOC_SERVICES.map((name) => ({ url: specUrl(name), name }));
  const uiOptions = {
    customSiteTitle: `${config.BRAND_NAME} API`,
    swaggerOptions: { urls: specList, 'urls.primaryName': 'identity', persistAuthorization: true },
    // Also expose the list to page scripts / makes the page self-describing.
    customJsStr: `window.THALI_API_SPECS = ${JSON.stringify(specList)};`,
  };
  const html = swaggerUi.generateHTML(undefined, uiOptions as never);

  app.get('/api/docs', (req, res, next) => {
    if (req.path.endsWith('/')) return next();
    res.redirect(301, '/api/docs/'); // relative asset URLs need the trailing slash
  });
  app.use('/api/docs', csp, swaggerUi.serveFiles(undefined, uiOptions as never), ((req, res, next) => {
    if (req.method !== 'GET' || req.path !== '/') return next();
    res.type('html').send(html);
  }) as RequestHandler);
}
