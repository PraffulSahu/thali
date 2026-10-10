/**
 * Discovery listing cache epoch (MKT-13). Cached listings expire after `DISCOVERY_CACHE_TTL_SEC`
 * anyway; writes that change what a listing shows (approval, pause, hours, profile, menu, scoped
 * coupons) also bump the epoch, which is part of every cache key, so the next request rebuilds.
 * All Redis errors are swallowed (the cache is an optimisation, never a dependency).
 */
import { redisKey, type Redis } from '@thali/service-kit';

const EPOCH_KEY = 'disc:epoch';

export async function discoveryEpoch(redis: Redis): Promise<string> {
  return (await redis.get(redisKey(redis, EPOCH_KEY))) ?? '0';
}

export async function bumpDiscoveryEpoch(redis: Redis): Promise<void> {
  try {
    await redis.incr(redisKey(redis, EPOCH_KEY));
  } catch {
    /* fail open: TTL still bounds staleness */
  }
}
