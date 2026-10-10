/**
 * Redis leader lock (single active holder per name), used by `startScheduler` and the outbox relay.
 *
 * Key `<REDIS_KEY_PREFIX>lock:<name>`, value = the holder's instance id.
 *  - hold (one atomic Lua script): if the value is our id → PEXPIRE (renew); if the key is absent →
 *    SET <id> PX <ttl> (acquire, same as `SET NX PX`); otherwise someone else holds it.
 *  - release: compare-and-delete (Lua) — never deletes another instance's lock.
 *  - A Redis error while we hold the lock does NOT drop leadership while our last confirmed hold is
 *    still within its TTL (nobody else can have the key yet); after that we assume it is lost.
 *
 * Like every TTL lock, a process frozen for longer than `ttlMs` (GC pause, SIGSTOP) can lose the
 * lock while still believing it holds it; callers must keep work idempotent (outbox consumers
 * dedupe via inbox, sweepers use conditional updates).
 */
import type { Redis } from 'ioredis';
import { redisKey } from './redis.js';

const HOLD_LUA = `local v = redis.call('get', KEYS[1])
if v == ARGV[1] then redis.call('pexpire', KEYS[1], ARGV[2]) return 1 end
if not v then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Safety margin subtracted from the TTL when deciding we still hold the lock despite a Redis error. */
const ERROR_GRACE_MARGIN_MS = 50;

export interface LeaderLock {
  /** Full Redis key (`<prefix>lock:<name>`). */
  readonly key: string;
  readonly instanceId: string;
  readonly ttlMs: number;
  /** Last known state (updated by `tryHold` / `release`). */
  isLeader(): boolean;
  /** Atomically renew-or-acquire. Resolves to whether we hold the lock now. Never throws. */
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
  /** Time the last successful hold was *sent* (conservative start of the TTL). */
  let confirmedAt = 0;

  return {
    key,
    instanceId,
    ttlMs,
    isLeader: () => held,
    async tryHold() {
      const sentAt = Date.now();
      try {
        const ok = (await redis.eval(HOLD_LUA, 1, key, instanceId, String(ttlMs))) as number;
        held = ok === 1;
        if (held) confirmedAt = sentAt;
      } catch {
        held = held && Date.now() - confirmedAt < ttlMs - ERROR_GRACE_MARGIN_MS;
      }
      return held;
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
