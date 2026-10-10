/**
 * Leader-locked periodic job (sweepers: checkout expiry, acceptance timeouts, offer expiry, refund
 * reconciliation, notification retries, ...). ADR-003 / HLD 8.
 *
 * Every `intervalMs` each instance ticks:
 *  1. hold the lock `<REDIS_KEY_PREFIX>lock:<name>` — `SET <key> <instanceId> NX PX <intervalMs*3>`,
 *     or compare-and-set renew if already held (renewal keeps happening while a slow `run` is in
 *     progress, so the lock does not lapse under it);
 *  2. if this instance holds the lock and its previous `run` has finished, start `run`.
 * So at most one `run` executes at a time across all instances, and at most one per interval.
 * Errors thrown by `run` are logged, never propagated. `stop()` stops ticking, waits for the
 * current run, then releases the lock (a standby takes over on its next tick).
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { createLeaderLock } from './leader-lock.js';

export interface SchedulerRunContext {
  /** Aborted when `stop()` is called — long runs should check it between batches. */
  signal: AbortSignal;
  /** Whether this instance still holds the lock (re-checked every tick). */
  isLeader(): boolean;
}

export interface StartSchedulerOptions {
  redis: Redis;
  /** Lock name; key is `<REDIS_KEY_PREFIX>lock:<name>`. Unique per job, shared by all instances of it. */
  name: string;
  intervalMs: number;
  run: (ctx: SchedulerRunContext) => Promise<void>;
  logger: Logger;
  /** Lock TTL. Default `intervalMs * 3`. */
  lockTtlMs?: number;
  /** Default random UUID. */
  instanceId?: string;
}

export interface SchedulerHandle {
  readonly name: string;
  readonly instanceId: string;
  isLeader(): boolean;
  stop(): Promise<void>;
}

export function startScheduler(opts: StartSchedulerOptions): SchedulerHandle {
  const { redis, name, intervalMs, run, logger } = opts;
  if (!(intervalMs > 0)) throw new Error('startScheduler: intervalMs must be > 0');
  const instanceId = opts.instanceId ?? randomUUID();
  const lock = createLeaderLock(redis, name, { ttlMs: opts.lockTtlMs ?? intervalMs * 3, instanceId });
  const abort = new AbortController();
  const log = logger.child({ scheduler: name, instanceId });

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> = Promise.resolve();
  let running: Promise<void> | null = null;

  async function tick(): Promise<void> {
    const leader = await lock.tryHold();
    if (stopped || !leader || running) return;
    running = (async () => {
      try {
        await run({ signal: abort.signal, isLeader: () => lock.isLeader() && !stopped });
      } catch (err) {
        log.error({ err }, 'scheduled run failed');
      }
    })().finally(() => {
      running = null;
    });
  }

  function loop(): void {
    ticking = tick()
      .catch((err) => log.error({ err }, 'scheduler tick failed'))
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, intervalMs);
      });
  }
  loop();

  return {
    name,
    instanceId,
    isLeader: () => lock.isLeader(),
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      abort.abort();
      await ticking;
      if (running) await running;
      await lock.release();
    },
  };
}
