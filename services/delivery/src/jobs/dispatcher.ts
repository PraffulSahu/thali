/**
 * Dispatcher sweeper (LLD 7): every DISPATCH_INTERVAL_MS (5 s), leader-locked across instances —
 * expire offers past TTL, then advance every due job (next round, or exception after MAX rounds).
 */
import { startScheduler, type SchedulerHandle } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import { advanceDispatch, dueJobs, expireOffers } from '../domain/dispatch.js';

export interface TickResult {
  expired: number;
  advanced: number;
}

export async function runDispatchTick(ctx: DeliveryContext, signal?: AbortSignal): Promise<TickResult> {
  const expired = await expireOffers(ctx);
  let advanced = 0;
  for (const jobId of await dueJobs(ctx)) {
    if (signal?.aborted) break;
    try {
      const r = await advanceDispatch(ctx, jobId);
      if (r.kind !== 'skipped') advanced++;
    } catch (err) {
      ctx.logger.error({ err, jobId: jobId.toString() }, 'dispatch round failed');
    }
  }
  return { expired, advanced };
}

export function startDispatcher(ctx: DeliveryContext): SchedulerHandle {
  return startScheduler({
    redis: ctx.redis,
    logger: ctx.logger,
    name: 'delivery:dispatcher',
    intervalMs: ctx.config.DISPATCH_INTERVAL_MS,
    run: async ({ signal }) => {
      await runDispatchTick(ctx, signal);
    },
  });
}
