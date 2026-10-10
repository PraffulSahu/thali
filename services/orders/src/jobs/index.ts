/**
 * Orders periodic jobs. Task 12: append `acceptanceTimeoutJob` (sweeper b) to `jobModules`.
 */
import { startScheduler, type SchedulerHandle } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { checkoutExpiryJob } from './checkout-expiry.js';
import { acceptanceTimeoutJob } from './acceptance-timeout.js';
import { contactBackfillJob } from './contact-backfill.js';
import type { JobModule } from './types.js';

export const jobModules: JobModule[] = [checkoutExpiryJob, acceptanceTimeoutJob, contactBackfillJob];

export function startOrdersJobs(ctx: OrdersContext, modules: JobModule[] = jobModules): SchedulerHandle[] {
  return modules.map((job) =>
    startScheduler({
      redis: ctx.redis,
      logger: ctx.logger,
      name: job.name,
      intervalMs: job.intervalMs(ctx.config),
      run: (runCtx) => job.run(ctx, runCtx),
    }),
  );
}

export type { JobModule };
