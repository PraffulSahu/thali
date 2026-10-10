/**
 * Sweeper (b) of LLD §8 — every ACCEPT_TIMEOUT_INTERVAL_MS (15 s), leader-locked: PLACED children
 * whose `acceptBy` passed are REJECTED by SYSTEM with reason RESTAURANT_TIMEOUT through
 * `transitionChild` (refund for the full child requested via `order.rejected`). Each child is its
 * own transaction; `onlyFrom: ['PLACED']` makes a child the restaurant just accepted a no-op.
 */
import { withTransaction } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { RESTAURANT_TIMEOUT } from '../domain/derive.js';
import { transitionChild } from '../domain/lifecycle.js';
import type { JobModule } from './types.js';

const BATCH = 100;

export async function runAcceptanceTimeout(ctx: OrdersContext, opts: { signal?: AbortSignal } = {}): Promise<{ rejected: number; skipped: number; failed: number }> {
  const counts = { rejected: 0, skipped: 0, failed: 0 };
  const due = await ctx.models.ChildOrder.find({ status: 'PLACED', acceptBy: { $lt: new Date() } }, { _id: 1 })
    .sort({ acceptBy: 1 })
    .limit(BATCH)
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
      ctx.logger.error({ err, childOrderId: String(d._id) }, 'acceptance timeout failed');
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
