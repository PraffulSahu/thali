/** `buildApp(deps)`: the Express app for supertest and for `index.ts`. */
import type { Express } from 'express';
import type { Connection } from 'mongoose';
import type { Logger } from 'pino';
import { createApp, createOpsRouter, mongoHealthCheck, redisHealthCheck, type AuthVerifier, type Redis } from '@thali/service-kit';
import type { NotificationsConfig } from './config.js';
import type { Dispatcher } from './domain/dispatcher.js';
import type { RecipientDirectory } from './domain/recipients.js';
import type { NotificationModel } from './models/notification.js';
import type { ProviderCallbackModel } from './models/provider-callback.js';
import { openapi } from './openapi.js';
import type { FailMode } from './providers/fail-mode.js';
import type { RealtimeHub } from './realtime/hub.js';
import { adminRouter, createLocalDeadLetterSource, type DeadLetterSource } from './routes/admin.js';
import { internalRouter } from './routes/internal.js';
import { notificationsRouter } from './routes/notifications.js';
import { realtimeRouter } from './routes/realtime.js';
import { webhooksRouter } from './routes/webhooks.js';

/** Streams this service consumes (for consumer-lag health). */
export const CONSUMED_STREAMS = ['events.identity', 'events.marketplace', 'events.orders', 'events.payments', 'events.delivery'];

export interface AppDeps {
  config: NotificationsConfig;
  logger: Logger;
  conn: Connection;
  redis: Redis;
  models: { Notification: NotificationModel; ProviderCallback: ProviderCallbackModel };
  dispatcher: Dispatcher;
  directory: RecipientDirectory;
  hub: RealtimeHub;
  failMode: FailMode;
  /** Peer services' dead-letter endpoints (this service's own DLQ is added automatically). */
  deadLetterSources: DeadLetterSource[];
  /** Test override for the JWT verifier (default: JWKS from `JWKS_URL`). */
  auth?: AuthVerifier;
  now?: () => Date;
}

export function buildApp(deps: AppDeps): Express {
  const { config, logger, conn, redis, models, dispatcher, directory, hub, failMode } = deps;
  const now = deps.now ?? (() => new Date());
  const deadLetterSources = [...deps.deadLetterSources, createLocalDeadLetterSource(conn, redis, config.EVENT_STREAM_PREFIX)];

  return createApp({
    config,
    logger,
    openapi,
    redis,
    auth: deps.auth,
    healthChecks: { mongo: mongoHealthCheck(conn), redis: redisHealthCheck(redis) },
    routes(app) {
      app.use(createOpsRouter({ conn, redis, config, streams: CONSUMED_STREAMS, allowed: ['gateway', 'notifications'] }));
      app.use('/internal/notifications', internalRouter({ dispatcher, directory }));
      app.use('/api/v1/webhooks', webhooksRouter({ config, logger, dispatcher, ProviderCallback: models.ProviderCallback, now }));
      app.use('/api/v1/realtime', realtimeRouter({ redis, hub }));
      app.use('/api/v1/notifications', notificationsRouter({ Notification: models.Notification, now }));
      app.use('/api/v1/admin/notifications', adminRouter({ config, conn, Notification: models.Notification, dispatcher, failMode, deadLetterSources, now }));
    },
  });
}
