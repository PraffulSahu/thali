/**
 * `buildApp(deps)` — Express app for the marketplace (used by `index.ts` and supertest).
 * Routes come from the module list in `routes/index.ts`; pass `modules` to override (tests/Task 9).
 */
import express from 'express';
import { createApp, createOpsRouter, mongoHealthCheck, parseExternalImageHosts, redisHealthCheck, resolveImageUrl } from '@thali/service-kit';
import type { AppContext, MarketplaceDeps, RouteModule } from './context.js';
import { handlerModules } from './events/handlers.js';
import { getModels } from './models/index.js';
import { buildOpenApi } from './openapi.js';
import { routeModules } from './routes/index.js';

export function createContext(deps: MarketplaceDeps): AppContext {
  const imageHosts = parseExternalImageHosts(deps.config.EXTERNAL_IMAGE_HOSTS);
  return {
    ...deps,
    models: getModels(deps.conn),
    now: deps.now ?? (() => new Date()),
    imageHosts,
    imageUrl: (ref) => resolveImageUrl(deps.storage, ref, imageHosts),
  };
}

export function buildApp(deps: MarketplaceDeps, modules: RouteModule[] = routeModules) {
  const ctx = createContext(deps);
  return createApp({
    config: deps.config,
    logger: deps.logger,
    openapi: buildOpenApi(modules),
    redis: deps.redis,
    auth: deps.auth,
    healthChecks: { mongo: mongoHealthCheck(deps.conn), redis: redisHealthCheck(deps.redis) },
    routes(app) {
      app.use(
        createOpsRouter({
          conn: deps.conn,
          redis: deps.redis,
          config: deps.config,
          streams: [...new Set(handlerModules.flatMap((m) => m.streams))],
        }),
      );
      const router = express.Router();
      for (const m of modules) m.register(router, ctx);
      app.use(router);
    },
  });
}
