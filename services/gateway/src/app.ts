/**
 * `buildApp(deps)` — the gateway Express app (also used by supertest).
 *
 * Order after the service-kit preamble (request id, logging, helmet, CORS + preflight, kit health routes;
 * `bodyParser: false` so request streams reach the proxy untouched):
 *   exposed CORS headers -> rate limits -> /api/v1/meta -> /api/v1/admin/health -> /api/docs (if enabled)
 *   -> streaming proxy -> 404 envelope.
 */
import type { Express, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { createApp, rateLimit, requireAuth, type AuthVerifier, type Redis } from '@thali/service-kit';
import type { GatewayConfig } from './config.js';
import { registerDocs } from './docs.js';
import { healthHandler, upstreamUrls } from './health.js';
import { metaHandler } from './meta.js';
import { createGatewayOpenApi } from './openapi.js';
import { createProxy } from './proxy.js';

export interface GatewayDeps {
  config: GatewayConfig;
  logger: Logger;
  /**
   * Rate-limit store + token revocation check. `src/index.ts` always supplies it; it is only optional so
   * tests that do not exercise limits/auth can run without infrastructure (no Redis => no rate limiting).
   */
  redis?: Redis;
  /** Access-token verifier; default is built from `config.JWKS_URL` + `redis`. */
  auth?: AuthVerifier;
}

/** Headers browsers may read cross-origin (error handling / retry UX). */
const EXPOSED_HEADERS = 'x-request-id, retry-after, ratelimit-limit, ratelimit-remaining';

export function buildApp(deps: GatewayDeps): Express {
  const { config, logger, redis } = deps;
  const openapi = createGatewayOpenApi();
  const proxy = createProxy({ upstreams: upstreamUrls(config), timeoutMs: config.UPSTREAM_TIMEOUT_MS, logger });

  return createApp({
    // `/docs` of the kit would only show the gateway's own spec; the aggregate lives at /api/docs.
    // Without Redis/auth injected (tests) there is nothing to verify tokens with: leave JWKS unconfigured.
    config: { ...config, DOCS_ENABLED: false, ...(redis || deps.auth ? {} : { JWKS_URL: undefined }) },
    logger,
    openapi,
    redis,
    auth: deps.auth,
    bodyParser: false,
    trustProxy: config.TRUST_PROXY,
    routes(app) {
      const exposeHeaders: RequestHandler = (req, res, next) => {
        if (req.headers.origin) res.setHeader('access-control-expose-headers', EXPOSED_HEADERS);
        next();
      };
      app.use(exposeHeaders);

      if (redis) {
        const byIp = (req: { ip?: string }) => req.ip ?? 'unknown';
        // Coarse limits: availability matters more than strictness -> fail open.
        app.use(
          rateLimit({ redis, name: 'gw-global', keyFn: byIp, points: config.RATE_LIMIT_GLOBAL_PER_MIN, durationSec: 60, failOpen: true }),
        );
        app.use(
          '/api/v1/discovery',
          rateLimit({ redis, name: 'gw-discovery', keyFn: byIp, points: config.RATE_LIMIT_DISCOVERY_PER_MIN, durationSec: 60, failOpen: true }),
        );
        // OTP abuse protection is a security control -> default fail-closed.
        app.use(
          '/api/v1/auth/otp',
          rateLimit({ redis, name: 'gw-otp', keyFn: byIp, points: config.RATE_LIMIT_OTP_PER_MIN, durationSec: 60 }),
        );
      }

      app.get('/api/v1/meta', metaHandler(config));
      app.get('/api/v1/admin/health', requireAuth({ roles: ['ADMIN'], mfa: true }), healthHandler(config, redis));
      registerDocs(app, config, openapi);

      app.use(proxy);
    },
  });
}
