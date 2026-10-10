/** Boot: config -> logger -> mongo -> redis -> app -> relay/consumer/worker -> listen -> graceful shutdown. */
import {
  connectMongo,
  createLogger,
  createRedis,
  gracefulShutdown,
  initEventCollections,
  internalClient,
  recordProviderError,
  startConsumer,
  startRelay,
} from '@thali/service-kit';
import { buildApp, CONSUMED_STREAMS } from './app.js';
import { loadNotificationsConfig } from './config.js';
import { createDispatcher } from './domain/dispatcher.js';
import { createIdentityDirectory } from './domain/recipients.js';
import { createEventHandlers } from './events/handlers.js';
import { startRetryWorker } from './jobs/retry-worker.js';
import { notificationModel } from './models/notification.js';
import { providerCallbackModel } from './models/provider-callback.js';
import { createEmailProvider } from './providers/email.js';
import { createFailMode } from './providers/fail-mode.js';
import { createSmsProvider } from './providers/sms.js';
import { createRealtimeHub } from './realtime/hub.js';
import { createRealtimePublisher } from './realtime/publish.js';
import { createRemoteDeadLetterSources } from './routes/admin.js';

async function main() {
  const config = loadNotificationsConfig();
  const logger = createLogger(config.SERVICE_NAME, { level: config.LOG_LEVEL });
  const conn = await connectMongo(config.MONGO_URI, 'thali_notifications');
  const redis = createRedis(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX });

  await initEventCollections(conn);
  const models = { Notification: notificationModel(conn), ProviderCallback: providerCallbackModel(conn) };
  await Promise.all([models.Notification.init(), models.ProviderCallback.init()]);

  const failMode = createFailMode(redis);
  const sms = createSmsProvider(config, { logger, failMode });
  const email = createEmailProvider(config, { logger, failMode });
  const dispatcher = createDispatcher({
    models,
    sms,
    email,
    realtime: createRealtimePublisher(redis, logger),
    encryptionKey: config.FIELD_ENCRYPTION_KEY,
    maxAttempts: config.NOTIF_MAX_ATTEMPTS,
    retryBaseSec: config.NOTIF_RETRY_BASE_SEC,
    retryMaxSec: config.NOTIF_RETRY_MAX_SEC,
    sendingTimeoutSec: config.NOTIF_SENDING_TIMEOUT_SEC,
    statusCallbackUrl: config.TWILIO_STATUS_CALLBACK_URL ?? (config.PUBLIC_API_URL ? `${config.PUBLIC_API_URL.replace(/\/+$/, '')}/api/v1/webhooks/twilio/status` : undefined),
    logger,
    onProviderError: (provider) => void recordProviderError(redis, 'notifications', provider).catch(() => undefined),
  });

  const secret = config.INTERNAL_SERVICE_SECRET;
  const directory = createIdentityDirectory(internalClient('identity', config.IDENTITY_URL, { from: 'notifications', secret }));
  const ordersClient = internalClient('orders', config.ORDERS_URL, { from: 'notifications', secret });
  const orders = {
    async getChildOrder(id: string) {
      try {
        return await ordersClient.get<{ id: string; userId: string }>(`/internal/orders/child/${encodeURIComponent(id)}`);
      } catch (err) {
        if ((err as { upstreamStatus?: number }).upstreamStatus === 404) return null;
        throw err;
      }
    },
  };

  const hub = await createRealtimeHub({
    redis,
    logger,
    heartbeatMs: config.SSE_HEARTBEAT_MS,
    maxAgeMs: config.SSE_MAX_AGE_SEC * 1000,
    maxPerUser: config.SSE_MAX_STREAMS_PER_USER,
  });

  const app = buildApp({ config, logger, conn, redis, models, dispatcher, directory, hub, failMode, deadLetterSources: createRemoteDeadLetterSources(config) });

  const relay = startRelay({ conn, redis, logger, service: 'notifications', streamPrefix: config.EVENT_STREAM_PREFIX });
  const consumer = startConsumer({
    conn,
    redis,
    logger,
    service: 'notifications',
    streamPrefix: config.EVENT_STREAM_PREFIX,
    streams: CONSUMED_STREAMS,
    handlers: createEventHandlers({ dispatcher, directory, orders, logger }),
  });
  const worker = startRetryWorker({ redis, dispatcher, logger, intervalMs: config.NOTIF_POLL_MS });

  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, mode: config.APP_MODE, sms: sms.name, email: email.name }, 'notifications listening'));

  // SSE streams never end by themselves and would hold `server.close()` open until the hard timeout:
  // end them first, then run the normal ordered shutdown.
  const { shutdown } = gracefulShutdown({
    server,
    logger,
    signals: [],
    closers: [
      () => consumer.stop(),
      () => worker.stop(),
      () => relay.stop(),
      async () => void (await redis.quit()),
      () => conn.close(),
    ],
  });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      void hub.close().finally(() => shutdown(sig));
    });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal: notifications failed to start', err instanceof Error ? err.message : err);
  process.exit(1);
});
