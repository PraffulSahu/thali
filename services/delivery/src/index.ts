/**
 * Delivery service boot: config → logger → mongo → redis → models/event collections → app →
 * relay + consumer (events.orders) + dispatcher → listen → graceful shutdown.
 */
import {
  connectMongo,
  createGeoProvider,
  createLogger,
  createRedis,
  createStorageProvider,
  gracefulShutdown,
  initEventCollections,
  startConsumer,
  startRelay,
} from '@thali/service-kit';
import { buildApp } from './app.js';
import { parseDeliveryConfig } from './config.js';
import { createContext, createIdentityClient } from './context.js';
import { CONSUMED_STREAMS, createEventHandlers } from './events/handlers.js';
import { startCodeBackfill } from './jobs/code-backfill.js';
import { startDispatcher } from './jobs/dispatcher.js';
import { initDeliveryModels } from './models/index.js';

async function main() {
  const config = parseDeliveryConfig();
  const logger = createLogger(config.SERVICE_NAME, { level: config.LOG_LEVEL });
  const conn = await connectMongo(config.MONGO_URI, 'thali_delivery');
  const redis = createRedis(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX });
  await initEventCollections(conn);
  await initDeliveryModels(conn);

  const ctx = createContext({
    config,
    logger,
    conn,
    redis,
    identity: createIdentityClient(config),
    storage: createStorageProvider(config),
    geo: createGeoProvider(config, { redis, logger }),
  });
  const app = buildApp(ctx);

  const relay = startRelay({ conn, redis, logger, service: 'delivery', streamPrefix: config.EVENT_STREAM_PREFIX });
  const consumer = startConsumer({
    conn,
    redis,
    logger,
    service: 'delivery',
    streamPrefix: config.EVENT_STREAM_PREFIX,
    streams: CONSUMED_STREAMS,
    handlers: createEventHandlers(ctx),
  });
  const dispatcher = startDispatcher(ctx);
  const codeBackfill = startCodeBackfill(ctx);

  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, mode: config.APP_MODE }, 'delivery listening'));
  gracefulShutdown({
    server,
    logger,
    closers: [
      () => ctx.simulator.stopAll(),
      () => dispatcher.stop(),
      () => codeBackfill.stop(),
      () => consumer.stop(),
      () => relay.stop(),
      async () => void (await redis.quit()),
      () => conn.close(),
    ],
  });
}

main().catch((err) => {
  console.error('delivery failed to start', err);
  process.exit(1);
});
