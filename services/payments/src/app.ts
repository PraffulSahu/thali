/**
 * `buildApp(deps)` — the payments Express app (used by index.ts and supertest).
 * The kit's global JSON parser is disabled (`bodyParser: false`) because createApp offers no pre-JSON
 * hook: the webhook router (express.raw) is mounted first, then JSON/urlencoded parsing for everything else.
 */
import express, { type Express } from 'express';
import { createApp, createOpsRouter, mongoHealthCheck, redisHealthCheck, type AuthVerifier } from '@thali/service-kit';
import { createContext, type CreateContextDeps, type PaymentsContext } from './context.js';
import { CONSUMED_STREAMS } from './events/handlers.js';
import { openapi } from './openapi.js';
import { adminFinanceRouter } from './routes/admin-finance.js';
import { demoPayRouter } from './routes/demo-pay.js';
import { financeRouter } from './routes/finance.js';
import { internalRouter } from './routes/internal.js';
import { paymentsRouter } from './routes/payments.js';
import { webhookRouter } from './routes/webhooks.js';

export type BuildAppDeps = ({ ctx: PaymentsContext } | CreateContextDeps) & { auth?: AuthVerifier };

export function buildApp(deps: BuildAppDeps): Express {
  const ctx = 'ctx' in deps ? deps.ctx : createContext(deps);
  const { config, logger, conn, redis } = ctx;
  return createApp({
    config,
    logger,
    openapi,
    redis,
    ...(deps.auth ? { auth: deps.auth } : {}),
    bodyParser: false,
    healthChecks: { mongo: mongoHealthCheck(conn), redis: redisHealthCheck(redis) },
    routes(app) {
      app.use(webhookRouter(ctx)); // raw body — must precede any JSON parser
      app.use(express.json({ limit: '1mb' }));
      app.use(express.urlencoded({ extended: false, limit: '1mb' }));
      app.use(createOpsRouter({ conn, redis, config, streams: CONSUMED_STREAMS }));
      app.use(internalRouter(ctx));
      app.use(paymentsRouter(ctx));
      if (config.PAYMENT_PROVIDER === 'mock') app.use(demoPayRouter(ctx));
      app.use(financeRouter(ctx));
      app.use(adminFinanceRouter(ctx));
    },
  });
}
