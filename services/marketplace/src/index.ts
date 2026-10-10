/**
 * Marketplace boot: config → logger → mongo → redis → indexes → providers → app → relay/consumers →
 * listen → graceful shutdown.
 */
import {
  connectMongo,
  createGeoProvider,
  createLogger,
  createRedis,
  createStorageProvider,
  gracefulShutdown,
  startConsumer,
  startRelay,
  startScheduler,
} from '@thali/service-kit';
import { buildApp, createContext } from './app.js';
import { createIdentityClient } from './clients/identity.js';
import { createOrdersClient } from './clients/orders.js';
import { createPaymentsClient } from './clients/payments.js';
import { loadMarketplaceConfig } from './config.js';
import type { MarketplaceDeps } from './context.js';
import { buildEventHandlers } from './events/handlers.js';
import { sweepExpiredReservations } from './jobs/reservation-expiry.js';
import { ensureMarketplaceIndexes } from './models/index.js';

async function main() {
  const config = loadMarketplaceConfig();
  const logger = createLogger(config.SERVICE_NAME, { level: config.LOG_LEVEL });
  if (!config.JWKS_URL) throw new Error('JWKS_URL is required (identity /.well-known/jwks.json)');

  const conn = await connectMongo(config.MONGO_URI, config.MONGO_DB_NAME);
  const redis = createRedis(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX });
  await ensureMarketplaceIndexes(conn);

  const deps: MarketplaceDeps = {
    config,
    logger,
    conn,
    redis,
    geo: createGeoProvider(config, { redis, logger }), // refuses demo geo in production
    storage: createStorageProvider(config),
    identity: createIdentityClient({ baseUrl: config.IDENTITY_URL, secret: config.INTERNAL_SERVICE_SECRET }),
    orders: createOrdersClient({ baseUrl: config.ORDERS_URL, secret: config.INTERNAL_SERVICE_SECRET, timeoutMs: config.INTERNAL_HTTP_TIMEOUT_MS }),
    payments: createPaymentsClient({ baseUrl: config.PAYMENTS_URL, secret: config.INTERNAL_SERVICE_SECRET, timeoutMs: config.PAYMENTS_HTTP_TIMEOUT_MS }),
  };
  const app = buildApp(deps);

  const relay = startRelay({ conn, redis, logger, service: 'marketplace', streamPrefix: config.EVENT_STREAM_PREFIX });
  const ctx = createContext(deps);
  const { handlers, streams } = buildEventHandlers(ctx);
  const consumer = streams.length
    ? startConsumer({ conn, redis, logger, service: 'marketplace', streamPrefix: config.EVENT_STREAM_PREFIX, streams, handlers })
    : null;

  const reservationSweeper = startScheduler({
    redis,
    logger,
    name: 'marketplace:reservation-expiry',
    intervalMs: config.RESERVATION_SWEEP_INTERVAL_MS,
    run: async ({ signal }) => {
      const out = await sweepExpiredReservations(ctx, { signal });
      const p = out.pendingMemberships;
      if (out.extended + out.committed + out.released + out.skipped + out.membershipsExpired + p.activated + p.cancelled + p.skipped > 0) logger.info(out, 'reservation sweep');
    },
  });

  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, mode: config.APP_MODE }, 'marketplace listening'));
  gracefulShutdown({
    server,
    logger,
    closers: [
      async () => consumer?.stop(),
      () => reservationSweeper.stop(),
      () => relay.stop(),
      async () => void (await redis.quit()),
      () => conn.close(),
    ],
  });
}

main().catch((err) => {
  console.error('marketplace failed to start', err);
  process.exit(1);
});
