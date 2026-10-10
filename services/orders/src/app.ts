/**
 * `buildApp(deps)` — the orders Express app (used by `index.ts` and supertest). Mounts the
 * service-kit ops router (`/internal/health/details`, dead letters) and every route module from
 * `routes/index.ts`; the OpenAPI document is built from the same module list.
 */
import type { Express } from 'express';
import { createApp, createOpsRouter, mongoHealthCheck, redisHealthCheck } from '@thali/service-kit';
import { createOrdersContext, type AppDeps } from './context.js';
import { consumedStreams } from './events/index.js';
import { buildOpenApi } from './openapi.js';
import { routeModules, type RouteModule } from './routes/index.js';

export function buildApp(deps: AppDeps, modules: RouteModule[] = routeModules): Express {
  const ctx = createOrdersContext(deps);
  return createApp({
    config: deps.config,
    logger: deps.logger,
    redis: deps.redis,
    ...(deps.auth ? { auth: deps.auth } : {}),
    openapi: buildOpenApi(modules),
    healthChecks: { mongo: mongoHealthCheck(deps.conn), redis: redisHealthCheck(deps.redis) },
    routes(app) {
      app.use(createOpsRouter({ conn: deps.conn, redis: deps.redis, config: deps.config, streams: consumedStreams() }));
      for (const m of modules) m.register(app, ctx);
    },
  });
}
