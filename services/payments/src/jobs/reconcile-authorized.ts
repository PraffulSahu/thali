/** Reconcile job: captures AUTHORIZED payments past the threshold and recovers missed webhooks. */
import { startScheduler, type SchedulerHandle } from '@thali/service-kit';
import type { PaymentsContext } from '../context.js';
import { reconcileStaleIntents } from '../domain/reconcile.js';

export function startReconcileJob(ctx: PaymentsContext): SchedulerHandle {
  return startScheduler({
    redis: ctx.redis,
    logger: ctx.logger,
    name: 'payments:reconcile-intents',
    intervalMs: ctx.config.RECONCILE_INTERVAL_MS,
    run: async ({ signal }) => {
      await reconcileStaleIntents(ctx, signal);
    },
  });
}
