/**
 * Test config + silent logger.
 */
import type { Logger } from 'pino';
import type { BaseConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { TEST_MONGO_URI } from './testDb.js';
import { TEST_REDIS_URL } from './testRedis.js';

export const TEST_INTERNAL_SERVICE_SECRET = 'test-internal-service-secret-0123456789abcdef';

/** A valid demo-mode BaseConfig (merge service fields / overrides as needed). */
export function createTestConfig<T extends object = object>(overrides: Partial<BaseConfig> & T = {} as T): BaseConfig & T {
  return {
    SERVICE_NAME: 'orders',
    PORT: 0,
    APP_MODE: 'demo',
    MONGO_URI: TEST_MONGO_URI,
    REDIS_URL: TEST_REDIS_URL,
    INTERNAL_SERVICE_SECRET: TEST_INTERNAL_SERVICE_SECRET,
    JWKS_URL: undefined,
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: [],
    DOCS_ENABLED: false,
    TRUST_PROXY: 'loopback',
    PUBLIC_WEB_URL: undefined,
    PUBLIC_API_URL: undefined,
    EVENT_STREAM_PREFIX: '',
    REDIS_KEY_PREFIX: 'thali:',
    ...overrides,
  } as BaseConfig & T;
}

/** Logger that discards output (set `TEST_LOG_LEVEL=debug` to see logs). */
export function testLogger(service = 'test'): Logger {
  return createLogger(service, { level: process.env.TEST_LOG_LEVEL ?? 'silent' });
}
