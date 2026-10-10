/**
 * Orders service boot: config → logger → mongo → redis → app → relay + consumers + schedulers →
 * listen → graceful shutdown.
 */
import { connectMongo, createLogger, createRedis, gracefulShutdown, startRelay } from '@thali/service-kit';
import { buildApp } from './app.js';
import { createIdentityClient } from './clients/identity.js';
import { createMarketplaceClient } from './clients/marketplace.js';
import { createPaymentsClient } from './clients/payments.js';
import { loadOrdersConfig } from './config.js';
import { createOrdersContext, type AppDeps } from './context.js';
import { startOrdersConsumers } from './events/index.js';
import { startOrdersJobs } from './jobs/index.js';
import { initOrdersDb } from './models/index.js';

async function main() {
  const config = loadOrdersConfig();
  const logger = createLogger(config.SERVICE_NAME, { level: config.LOG_LEVEL });
  const conn = await connectMongo(config.MONGO_URI, 'thali_orders');
  const redis = createRedis(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX });
  await initOrdersDb(conn);

  const deps: AppDeps = {
    config,
    logger,
    conn,
    redis,
    clients: {
      marketplace: createMarketplaceClient(config),
      payments: createPaymentsClient(config),
      identity: createIdentityClient(config),
    },
  };
  const app = buildApp(deps);
  const ctx = createOrdersContext(deps);

  const relay = startRelay({ conn, redis, logger, service: 'orders', streamPrefix: config.EVENT_STREAM_PREFIX });
  const consumers = startOrdersConsumers(ctx);
  const jobs = startOrdersJobs(ctx);

  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, mode: config.APP_MODE }, 'orders listening'));
  gracefulShutdown({
    server,
    logger,
    closers: [
      ...consumers.map((c) => () => c.stop()),
      ...jobs.map((j) => () => j.stop()),
      () => relay.stop(),
      async () => void (await redis.quit()),
      () => conn.close(),
    ],
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('orders failed to start', err);
  process.exit(1);
});
