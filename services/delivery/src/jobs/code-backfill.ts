/**
 * DLV-4 idempotent startup migration: order codes on delivery jobs created before `order.accepted`
 * carried `childOrderCode` / `checkoutCode`. Leader-locked through the scheduler (first tick at boot,
 * later ticks are a cheap indexed no-op that also pick up jobs from an older orders producer).
 *
 * For each job with `childOrderCode: null` and `codesCheckedAt: null` it calls orders
 * `GET /internal/orders/child/:childOrderId`:
 *  - found   → `childOrderCode = code`, `checkoutCode = checkoutCode` when orders provides it (the binding
 *              shape has no checkout code today; child codes are independent random codes, so it is never
 *              derived), `codesCheckedAt = now`;
 *  - 404     → `codesCheckedAt = now` only (never asked again);
 *  - orders unavailable / any other error → stop this run; the rest is retried on the next tick / start.
 * Writes are conditional on the code still being missing, so a concurrent order.accepted always wins.
 */
import { startScheduler, type SchedulerHandle } from '@thali/service-kit';
import type { DeliveryContext } from '../context.js';
import type { JobLean } from '../models/delivery-job.js';

const BATCH = 200;
export const CODE_BACKFILL_INTERVAL_MS = 5 * 60_000;

export interface CodeBackfillResult {
  updated: number;
  notFound: number;
  /** true when orders failed and the run stopped early (retried later). */
  interrupted: boolean;
}

export async function runCodeBackfill(ctx: DeliveryContext, opts: { signal?: AbortSignal; batch?: number } = {}): Promise<CodeBackfillResult> {
  const batch = opts.batch ?? BATCH;
  const missing = { childOrderCode: null, codesCheckedAt: null };
  const out: CodeBackfillResult = { updated: 0, notFound: 0, interrupted: false };
  let after: unknown = null;
  for (;;) {
    if (opts.signal?.aborted) break;
    const rows = await ctx.models.Job.find({ ...missing, ...(after ? { _id: { $gt: after } } : {}) }, { _id: 1, childOrderId: 1 })
      .sort({ _id: 1 })
      .limit(batch)
      .lean<Pick<JobLean, '_id' | 'childOrderId'>[]>();
    if (!rows.length) break;
    after = rows[rows.length - 1]!._id;
    for (const r of rows) {
      if (opts.signal?.aborted) break;
      let child;
      try {
        child = await ctx.orders.getChild(r.childOrderId);
      } catch (err) {
        ctx.logger.warn({ err, childOrderId: r.childOrderId }, 'order-code backfill: orders unavailable; retrying later');
        out.interrupted = true;
        break;
      }
      const now = ctx.now();
      const set: Record<string, unknown> = { codesCheckedAt: now };
      if (child?.code) {
        set.childOrderCode = child.code;
        if (child.checkoutCode) set.checkoutCode = child.checkoutCode;
      }
      const res = await ctx.models.Job.updateOne({ _id: r._id, ...missing }, { $set: set }, { timestamps: false });
      if (child?.code) out.updated += res.modifiedCount;
      else out.notFound += res.modifiedCount;
    }
    if (out.interrupted || rows.length < batch) break;
  }
  if (out.updated || out.notFound || out.interrupted) ctx.logger.info({ result: out }, 'order-code backfill');
  return out;
}

export function startCodeBackfill(ctx: DeliveryContext): SchedulerHandle {
  return startScheduler({
    redis: ctx.redis,
    logger: ctx.logger,
    name: 'delivery:order-code-backfill',
    intervalMs: CODE_BACKFILL_INTERVAL_MS,
    run: async ({ signal }) => {
      await runCodeBackfill(ctx, { signal });
    },
  });
}
