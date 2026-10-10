/**
 * Payments service boot: config → logger → mongo → redis → app → relay/consumer/schedulers → listen → shutdown.
 */
import { connectMongo, createLogger, createRedis, gracefulShutdown, startConsumer, startRelay } from '@thali/service-kit';
import { buildApp } from './app.js';
import { loadPaymentsConfig } from './config.js';
import { createContext, initPayments } from './context.js';
import { CONSUMED_STREAMS, createEventHandlers } from './events/handlers.js';
import { startReconcileJob } from './jobs/reconcile-authorized.js';
import { startRefundWorker } from './jobs/refund-worker.js';

async function main(): Promise<void> {
  const config = loadPaymentsConfig();
  const logger = createLogger(config.SERVICE_NAME, { level: config.LOG_LEVEL });
  const conn = await connectMongo(config.MONGO_URI, 'thali_payments');
  const redis = createRedis(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX });
  const ctx = createContext({ config, logger, conn, redis });
  await initPayments(ctx);
  if (config.PAYMENT_PROVIDER === 'mock') logger.warn({ mode: config.APP_MODE }, 'PAYMENT_PROVIDER=mock: demo payments only (simulated)');

  const app = buildApp({ ctx });
  const relay = startRelay({ conn, redis, logger, service: 'payments', streamPrefix: config.EVENT_STREAM_PREFIX });
  const consumer = startConsumer({
    conn,
    redis,
    logger,
    service: 'payments',
    streamPrefix: config.EVENT_STREAM_PREFIX,
    streams: CONSUMED_STREAMS,
    handlers: createEventHandlers(ctx),
  });
  const refundWorker = startRefundWorker(ctx);
  const reconcileJob = startReconcileJob(ctx);

  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, provider: config.PAYMENT_PROVIDER }, 'payments listening'));
  gracefulShutdown({
    server,
    logger,
    closers: [
      () => consumer.stop(),
      () => refundWorker.stop(),
      () => reconcileJob.stop(),
      () => relay.stop(),
      async () => void (await redis.quit()),
      () => conn.close(),
    ],
  });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('payments failed to start', err);
  process.exit(1);
});
