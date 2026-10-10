/**
 * Redis client with a unique key prefix per test file. Use `prefix` for both `REDIS_KEY_PREFIX`
 * and `EVENT_STREAM_PREFIX` so parallel test files never see each other's keys/streams.
 */
import { randomBytes } from 'node:crypto';
import { createRedis, type Redis } from '../redis.js';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';

export interface TestRedis {
  /** Client with `prefix` registered (kit helpers prefix keys automatically). */
  redis: Redis;
  /** e.g. `test:3f9a1c2b7d4e:` */
  prefix: string;
  url: string;
  /** Delete every key under `prefix` and quit the client. */
  cleanup(): Promise<void>;
}

export async function createTestRedis(): Promise<TestRedis> {
  const prefix = `test:${randomBytes(6).toString('hex')}:`;
  const redis = createRedis(TEST_REDIS_URL, { keyPrefix: prefix });
  await redis.ping();
  return {
    redis,
    prefix,
    url: TEST_REDIS_URL,
    async cleanup() {
      try {
        let cursor = '0';
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
          cursor = next;
          if (keys.length) await redis.unlink(...keys);
        } while (cursor !== '0');
      } finally {
        await redis.quit();
      }
    },
  };
}
