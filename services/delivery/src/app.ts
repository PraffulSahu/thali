/** `buildApp(deps)` — the delivery Express app (used by index.ts and supertest). */
import type { Express } from 'express';
import { createApp, mongoHealthCheck, rateLimit, redisHealthCheck, type AuthVerifier } from '@thali/service-kit';
import { createContext, type ContextDeps, type DeliveryContext } from './context.js';
import { openapi } from './openapi.js';
import { adminDeliveryRouter } from './routes/admin-delivery.js';
import { deliveriesRouter } from './routes/deliveries.js';
import { internalRouter } from './routes/internal.js';
import { partnerRouter } from './routes/partner.js';
import { trackingRouter } from './routes/tracking.js';

export type AppDeps = (ContextDeps | DeliveryContext) & { auth?: AuthVerifier };

const isContext = (d: AppDeps): d is DeliveryContext & { auth?: AuthVerifier } => 'models' in d && 'simulator' in d;

export function buildApp(deps: AppDeps): Express {
  const ctx = isContext(deps) ? deps : createContext(deps);
  return createApp({
    config: ctx.config,
    logger: ctx.logger,
    openapi,
    redis: ctx.redis,
    auth: deps.auth,
    healthChecks: { mongo: mongoHealthCheck(ctx.conn), redis: redisHealthCheck(ctx.redis) },
    routes(app) {
      // LLD 5.4: location ping 1 / 3 s per partner, shared by both ping routes. Not a security
      // control (realtime is best-effort anyway), so it fails open if Redis is down.
      const locationLimiter = rateLimit({
        redis: ctx.redis,
        name: 'partner-location',
        keyFn: (req) => req.auth?.userId ?? null,
        points: 1,
        durationSec: ctx.config.LOCATION_PING_INTERVAL_SEC,
        failOpen: true,
        message: 'Location updates are limited to one every few seconds',
      });
      app.use(internalRouter(ctx));
      app.use('/api/v1/partner', partnerRouter(ctx, locationLimiter));
      app.use('/api/v1/deliveries', trackingRouter(ctx));
      app.use('/api/v1/deliveries', deliveriesRouter(ctx, locationLimiter));
      app.use('/api/v1/admin/delivery', adminDeliveryRouter(ctx));
    },
  });
}
