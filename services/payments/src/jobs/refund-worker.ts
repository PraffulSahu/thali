/** Refund worker: sends due refunds to the provider and reconciles PROCESSING ones (single leader). */
import { startScheduler, type SchedulerHandle } from '@thali/service-kit';
import type { PaymentsContext } from '../context.js';
import { processDueRefunds, reconcileProcessingRefunds } from '../domain/refunds.js';

export function startRefundWorker(ctx: PaymentsContext): SchedulerHandle {
  return startScheduler({
    redis: ctx.redis,
    logger: ctx.logger,
    name: 'payments:refund-worker',
    intervalMs: ctx.config.REFUND_WORKER_INTERVAL_MS,
    lockTtlMs: Math.max(ctx.config.REFUND_WORKER_INTERVAL_MS * 3, ctx.config.PAYMENT_PROVIDER_TIMEOUT_MS * 2),
    run: async ({ signal }) => {
      await processDueRefunds(ctx, signal);
      await reconcileProcessingRefunds(ctx, signal);
    },
  });
}
