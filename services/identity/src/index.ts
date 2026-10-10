/**
 * Identity service boot: config → logger → mongo → redis → collections/indexes → signing key →
 * app → outbox relay + audit consumer → listen → graceful shutdown.
 */
import { connectMongo, createLogger, createRedis, gracefulShutdown, startRelay } from '@thali/service-kit';
import { buildApp } from './app.js';
import { createNotificationsClient } from './clients/notifications.js';
import { createOrdersClient } from './clients/orders.js';
import { loadIdentityConfig } from './config.js';
import { initIdentityDb } from './db.js';
import { loadSigningKeys } from './domain/tokens.js';
import { startIdentityConsumer } from './events/handlers.js';

async function main(): Promise<void> {
  const config = loadIdentityConfig();
  const logger = createLogger('identity', { level: config.LOG_LEVEL });
  const conn = await connectMongo(config.MONGO_URI, 'thali_identity');
  const redis = createRedis(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX });
  await initIdentityDb(conn);
  const keys = await loadSigningKeys(conn, config);
  logger.info({ kid: keys.kid, mode: config.APP_MODE, cookieSecure: config.COOKIE_SECURE }, 'signing key loaded');

  const app = buildApp({
    config,
    logger,
    conn,
    redis,
    keys,
    notifications: createNotificationsClient(config),
    orders: createOrdersClient(config),
  });

  const relay = startRelay({ conn, redis, logger, service: 'identity', streamPrefix: config.EVENT_STREAM_PREFIX });
  const consumer = startIdentityConsumer({ conn, redis, logger, streamPrefix: config.EVENT_STREAM_PREFIX });

  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'identity listening'));
  gracefulShutdown({
    server,
    logger,
    closers: [
      () => consumer.stop(),
      () => relay.stop(),
      async () => void (await redis.quit()),
      () => conn.close(),
    ],
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('identity failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
