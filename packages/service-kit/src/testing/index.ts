/**
 * @thali/service-kit/testing — helpers for service tests (real Mongo replica set + Redis from
 * docker-compose.infra.yml; unique DB names / key prefixes so packages can test in parallel).
 */
export { createTestDb, TEST_MONGO_URI, type TestDb } from './testDb.js';
export { createTestRedis, TEST_REDIS_URL, type TestRedis } from './testRedis.js';
export { generateTestKeys, type TestKeys, type TestTokenClaims } from './keys.js';
export { createTestConfig, testLogger, TEST_INTERNAL_SERVICE_SECRET } from './config.js';
export { waitFor, type WaitForOptions } from './wait.js';
