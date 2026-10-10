/**
 * `buildApp(deps)` — the identity Express app (used by index.ts and supertest).
 * Identity verifies its own access tokens with its in-memory public key (no JWKS round-trip),
 * plus the shared Redis revocation check.
 */
import type { Express } from 'express';
import { createApp, createAuthVerifier, createOpsRouter, mongoHealthCheck, redisHealthCheck, resolveImageUrl } from '@thali/service-kit';
import type { AppDeps, Ctx } from './deps.js';
import { AUDIT_STREAMS } from './events/handlers.js';
import { models } from './models/index.js';
import { createIdentityOpenApi } from './openapi.js';
import { adminAuthRouter } from './routes/admin-auth.js';
import { adminUsersRouter } from './routes/admin-users.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { internalRouter } from './routes/internal.js';
import { jwksRouter } from './routes/jwks.js';
import { meRouter } from './routes/me.js';

export type { AppDeps } from './deps.js';

export function buildApp(deps: AppDeps): Express {
  const hosts = deps.config.EXTERNAL_IMAGE_HOSTS;
  const ctx: Ctx = { ...deps, m: models(deps.conn), imageUrl: (ref) => resolveImageUrl(deps.storage, ref, hosts) };
  return createApp({
    config: deps.config,
    logger: deps.logger,
    openapi: createIdentityOpenApi(),
    redis: deps.redis,
    auth: createAuthVerifier({ jwks: deps.keys.jwks(), redis: deps.redis }),
    healthChecks: { mongo: mongoHealthCheck(deps.conn), redis: redisHealthCheck(deps.redis) },
    routes(app) {
      app.use(jwksRouter(ctx));
      app.use('/api/v1/auth/admin', adminAuthRouter(ctx));
      app.use('/api/v1/auth', authRouter(ctx));
      app.use('/api/v1/me', meRouter(ctx));
      app.use('/api/v1/admin/audit-logs', auditRouter(ctx));
      app.use('/api/v1/admin', adminUsersRouter(ctx));
      app.use('/internal', internalRouter(ctx));
      app.use(createOpsRouter({ conn: deps.conn, redis: deps.redis, config: deps.config, streams: AUDIT_STREAMS }));
    },
  });
}
