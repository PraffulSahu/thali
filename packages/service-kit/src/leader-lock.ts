/**
 * Redis leader lock (single active holder per name), used by `startScheduler` and the outbox relay.
 *
 * Key `<REDIS_KEY_PREFIX>lock:<name>`, value = the holder's instance id.
 *  - acquire: `SET key <instanceId> NX PX <ttlMs>`
 *  - renew:   compare-and-set PEXPIRE (Lua) — only if the value is still our instance id
 *  - release: compare-and-delete (Lua) — never deletes another instance's lock
 *
 * Like every TTL lock, a process frozen for longer than `ttlMs` (GC pause, SIGSTOP) can lose the
 * lock while still believing it holds it; callers must keep work idempotent (outbox consumers
 * dedupe via inbox, sweepers use conditional updates).
 */
import type { Redis } from 'ioredis';
import { redisKey } from './redis.js';

const RENEW_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export interface LeaderLock {
  /** Full Redis key (`<prefix>lock:<name>`). */
  readonly key: string;
  readonly instanceId: string;
  readonly ttlMs: number;
  /** Last known state (updated by `tryHold` / `release`). */
  isLeader(): boolean;
  /** Renew if held, otherwise try to acquire. Resolves to whether we hold the lock now. Never throws (Redis errors → `false`). */
  tryHold(): Promise<boolean>;
  /** Delete the lock if we still hold it. */
  release(): Promise<void>;
}

export interface LeaderLockOptions {
  ttlMs: number;
  instanceId: string;
  /** Overrides the client's registered key prefix. */
  keyPrefix?: string;
}

export function createLeaderLock(redis: Redis, name: string, opts: LeaderLockOptions): LeaderLock {
  const key = redisKey(redis, `lock:${name}`, opts.keyPrefix);
  const { instanceId, ttlMs } = opts;
  let held = false;

  return {
    key,
    instanceId,
    ttlMs,
    isLeader: () => held,
    async tryHold() {
      try {
        if (held) {
          const renewed = (await redis.eval(RENEW_LUA, 1, key, instanceId, String(ttlMs))) as number;
          if (renewed === 1) return true;
          held = false;
        }
        const ok = await redis.set(key, instanceId, 'PX', ttlMs, 'NX');
        held = ok === 'OK';
        return held;
      } catch {
        held = false;
        return false;
      }
    },
    async release() {
      held = false;
      try {
        await redis.eval(RELEASE_LUA, 1, key, instanceId);
      } catch {
        // lock expires on its own
      }
    },
  };
}
