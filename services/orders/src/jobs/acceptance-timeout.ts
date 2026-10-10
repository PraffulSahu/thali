/**
 * Sweeper (b) of LLD §8 — every ACCEPT_TIMEOUT_INTERVAL_MS (15 s), leader-locked by the service-kit
 * scheduler: PLACED children whose `acceptBy` passed are REJECTED by SYSTEM with reason
 * RESTAURANT_TIMEOUT through `transitionChild` (refund for the full child requested via
 * `order.rejected`). Each child is its own transaction; `onlyFrom: ['PLACED']` makes a child the
 * restaurant just accepted a no-op.
 *
 * A child whose rejection keeps failing is backed off (`timeoutRetryAt` = now + 30 s·2^(n−1), capped
 * at 15 min; `timeoutFailures` = n) so a poisoned child can never starve the rest of the batch.
 */
import { withTransaction } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { RESTAURANT_TIMEOUT } from '../domain/derive.js';
import { transitionChild } from '../domain/lifecycle.js';
import type { JobModule } from './types.js';

const BATCH = 100;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;

export function timeoutBackoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

export async function runAcceptanceTimeout(
  ctx: OrdersContext,
  opts: { signal?: AbortSignal; batch?: number } = {},
): Promise<{ rejected: number; skipped: number; failed: number }> {
  const counts = { rejected: 0, skipped: 0, failed: 0 };
  const now = new Date();
  const due = await ctx.models.ChildOrder.find(
    { status: 'PLACED', acceptBy: { $lt: now }, $or: [{ timeoutRetryAt: null }, { timeoutRetryAt: { $lte: now } }] },
    { _id: 1, timeoutFailures: 1 },
  )
    .sort({ acceptBy: 1 })
    .limit(opts.batch ?? BATCH)
    .lean();
  for (const d of due) {
    if (opts.signal?.aborted) break;
    try {
      const child = await withTransaction(ctx.conn, (session) =>
        transitionChild(ctx, session, String(d._id), 'REJECTED', { actor: 'SYSTEM', reason: RESTAURANT_TIMEOUT, onlyFrom: ['PLACED'] }),
      );
      if (child) counts.rejected++;
      else counts.skipped++;
    } catch (err) {
      counts.failed++;
      const failures = (d.timeoutFailures ?? 0) + 1;
      const retryAt = new Date(Date.now() + timeoutBackoffMs(failures));
      ctx.logger.error({ err, childOrderId: String(d._id), failures, retryAt }, 'acceptance timeout failed; backing off');
      await ctx.models.ChildOrder.updateOne({ _id: d._id, status: 'PLACED' }, { $set: { timeoutRetryAt: retryAt, timeoutFailures: failures } }).catch((e) =>
        ctx.logger.error({ err: e, childOrderId: String(d._id) }, 'could not record acceptance timeout backoff'),
      );
    }
  }
  if (due.length) ctx.logger.info({ counts }, 'acceptance timeout sweep');
  return counts;
}

export const acceptanceTimeoutJob: JobModule = {
  name: 'orders:acceptance-timeout',
  intervalMs: (config) => config.ACCEPT_TIMEOUT_INTERVAL_MS,
  run: async (ctx, { signal }) => {
    await runAcceptanceTimeout(ctx, { signal });
  },
};
