/**
 * Redis client factory + key prefixing.
 *
 * Every Redis key the kit creates is `<REDIS_KEY_PREFIX><name>` (default prefix `thali:`). The prefix
 * is registered against the client by `createRedis(url, { keyPrefix })`, so kit helpers that take a
 * `redis` (rateLimit, revocation check, revokeSession, ...) pick it up automatically; an explicit
 * `keyPrefix` option on a helper overrides it. Keys are prefixed explicitly (ioredis' own
 * `keyPrefix` option is NOT used) so the same rule applies to pub/sub channels and streams.
 */
import { Redis, type RedisOptions } from 'ioredis';

export const DEFAULT_REDIS_KEY_PREFIX = 'thali:';
const prefixes = new WeakMap<Redis, string>();

export interface CreateRedisOptions {
  /** Usually `config.REDIS_KEY_PREFIX`. */
  keyPrefix?: string;
  /** Extra ioredis options (merged over the kit defaults). */
  redisOptions?: RedisOptions;
}

export type { Redis };

/** ioredis client; fails requests fast (2 retries) instead of queueing forever while Redis is down. */
export function createRedis(url: string, opts: CreateRedisOptions = {}): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: 2, ...opts.redisOptions });
  setKeyPrefix(redis, opts.keyPrefix ?? DEFAULT_REDIS_KEY_PREFIX);
  return redis;
}

/** Register the key prefix for a client created elsewhere. */
export function setKeyPrefix(redis: Redis, prefix: string): void {
  prefixes.set(redis, prefix);
}

/** Prefix registered for this client (default `thali:`). */
export function getKeyPrefix(redis: Redis): string {
  return prefixes.get(redis) ?? DEFAULT_REDIS_KEY_PREFIX;
}

/** `<prefix><name>` using the explicit prefix if given, else the client's registered prefix. */
export function redisKey(redis: Redis, name: string, explicitPrefix?: string): string {
  return `${explicitPrefix ?? getKeyPrefix(redis)}${name}`;
}
