/**
 * Idempotent startup migration (leader-locked like the sweepers; the scheduler's first tick runs it
 * at boot, later ticks are a cheap indexed no-op that also catch rows written by an older instance
 * during a rolling deploy):
 *  - ORD-7: `child_orders.customerContact.phoneLast4` from the stored masked phone (`+91******3210`
 *    → `3210`; null when no digits are known, so the row is never picked again).
 *
 * Writes use `updateOne` with the "still missing" condition in the filter, so a concurrent writer
 * (new checkout) always wins and re-runs never change anything. `timestamps: false` keeps
 * `updatedAt` untouched (this is a data fix, not a business change).
 */
import type { OrdersContext } from '../context.js';
import { phoneLast4 } from '../domain/codes.js';
import type { JobModule } from './types.js';

const BATCH = 500;
export const CONTACT_BACKFILL_INTERVAL_MS = 5 * 60_000;

export interface ContactBackfillCounts {
  children: number;
}

async function backfillChildren(ctx: OrdersContext, batch: number, signal?: AbortSignal): Promise<number> {
  const missing = { 'customerContact.phoneLast4': { $exists: false } };
  let updated = 0;
  for (;;) {
    if (signal?.aborted) break;
    const rows = await ctx.models.ChildOrder.find(missing, { _id: 1, 'customerContact.phoneMasked': 1 }).limit(batch).lean();
    if (!rows.length) break;
    const res = await ctx.models.ChildOrder.bulkWrite(
      rows.map((r) => ({
        updateOne: {
          filter: { _id: r._id, ...missing },
          update: { $set: { 'customerContact.phoneLast4': phoneLast4(r.customerContact?.phoneMasked) } },
          timestamps: false,
        },
      })),
      { ordered: false },
    );
    updated += res.modifiedCount;
    if (rows.length < batch) break;
  }
  return updated;
}

export async function runContactBackfill(ctx: OrdersContext, opts: { signal?: AbortSignal; batch?: number } = {}): Promise<ContactBackfillCounts> {
  const batch = opts.batch ?? BATCH;
  const counts: ContactBackfillCounts = { children: await backfillChildren(ctx, batch, opts.signal) };
  if (counts.children) ctx.logger.info({ counts }, 'contact backfill');
  return counts;
}

export const contactBackfillJob: JobModule = {
  name: 'orders:contact-backfill',
  intervalMs: () => CONTACT_BACKFILL_INTERVAL_MS,
  run: async (ctx, { signal }) => {
    await runContactBackfill(ctx, { signal });
  },
};
