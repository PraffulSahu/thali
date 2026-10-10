/** Gateway boot: config -> logger -> redis -> app -> listen -> graceful shutdown. */
import { createLogger, createRedis, gracefulShutdown } from '@thali/service-kit';
import { buildApp } from './app.js';
import { loadGatewayConfig } from './config.js';

const config = loadGatewayConfig();
const logger = createLogger('gateway', { level: config.LOG_LEVEL });
const redis = createRedis(config.REDIS_URL, { keyPrefix: config.REDIS_KEY_PREFIX });
redis.on('error', (err) => logger.warn({ err }, 'redis error'));

const app = buildApp({ config, logger, redis });
const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, mode: config.APP_MODE, trustProxy: config.TRUST_PROXY }, 'gateway listening');
});
// Longer than typical load-balancer idle timeouts (ALB 60 s) so the LB never reuses a socket we just closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

gracefulShutdown({
  server,
  logger,
  closers: [async () => void (await redis.quit())],
});
