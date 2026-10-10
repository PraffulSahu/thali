/**
 * Delivery worker: every `NOTIF_POLL_MS` the scheduler leader recovers stuck SENDING rows and dispatches every
 * QUEUED / retry-due notification. (The post-commit `kick()` makes the common case immediate; this is the
 * safety net and the retry clock.)
 */
import type { Logger } from 'pino';
import { startScheduler, type Redis, type SchedulerHandle } from '@thali/service-kit';
import type { Dispatcher } from '../domain/dispatcher.js';

export function startRetryWorker(opts: { redis: Redis; dispatcher: Dispatcher; logger: Logger; intervalMs: number }): SchedulerHandle {
  return startScheduler({
    redis: opts.redis,
    logger: opts.logger,
    name: 'notifications:dispatch',
    intervalMs: opts.intervalMs,
    run: async ({ signal }) => {
      for (let i = 0; i < 20 && !signal.aborted; i++) {
        const n = await opts.dispatcher.dispatchDue(50);
        if (n < 50) break;
      }
    },
  });
}
