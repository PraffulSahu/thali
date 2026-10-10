/**
 * Reservation expiry sweeper. HELD reservations past `expiresAt + grace` (default 5 min) are never
 * released blindly — orders is asked first (`GET /internal/checkouts/:id/status`):
 *   AWAITING_PAYMENT                                  → extend the hold (payment may still land)
 *   PAID_PLACED | IN_PROGRESS | COMPLETED | PARTIALLY_COMPLETED | CANCELLED (all were placed) → commit
 *   PAYMENT_FAILED | EXPIRED | 404 (orphan hold)      → release
 *   orders unreachable / unknown status / action error → skip and back off (`nextCheckAt` = now +
 *                                                       RESERVATION_RECHECK_SEC) so stuck rows never
 *                                                       starve newer ones out of the batch
 * Also reconciles idle PENDING_PAYMENT memberships and marks lapsed ACTIVE memberships EXPIRED.
 * Runs under `startScheduler` (single leader).
 */
import type { AppContext } from '../context.js';
import { expireMemberships, sweepPendingMemberships, type PendingSweepResult } from '../domain/memberships.js';
import { commitInTxn, releaseInTxn } from '../domain/reservations.js';

const PLACED = new Set(['PAID_PLACED', 'IN_PROGRESS', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED']);
const DEAD = new Set(['PAYMENT_FAILED', 'EXPIRED']);

export interface SweepOptions {
  graceMs?: number;
  extendMs?: number;
  batch?: number;
  signal?: AbortSignal;
}

export interface SweepResult {
  extended: number;
  committed: number;
  released: number;
  skipped: number;
  membershipsExpired: number;
  pendingMemberships: PendingSweepResult;
}

export async function sweepExpiredReservations(ctx: AppContext, opts: SweepOptions = {}): Promise<SweepResult> {
  const graceMs = opts.graceMs ?? (ctx.config.RESERVATION_GRACE_SEC ?? 300) * 1000;
  const extendMs = opts.extendMs ?? (ctx.config.RESERVATION_EXTEND_SEC ?? 300) * 1000;
  const batch = opts.batch ?? 100;
  const out: SweepResult = { extended: 0, committed: 0, released: 0, skipped: 0, membershipsExpired: 0, pendingMemberships: { activated: 0, cancelled: 0, skipped: 0 } };
  const now = ctx.now();
  const recheckAt = () => new Date(ctx.now().getTime() + ctx.config.RESERVATION_RECHECK_SEC * 1000);
  const due = await ctx.models.StockReservation.find(
    {
      status: 'HELD',
      expiresAt: { $lt: new Date(now.getTime() - graceMs) },
      $or: [{ nextCheckAt: { $exists: false } }, { nextCheckAt: null }, { nextCheckAt: { $lte: now } }],
    },
    { checkoutId: 1 },
  )
    .sort({ expiresAt: 1 })
    .limit(batch)
    .lean<{ _id: unknown; checkoutId: string }[]>();

  const backOff = (id: unknown) => ctx.models.StockReservation.updateOne({ _id: id, status: 'HELD' }, { $set: { nextCheckAt: recheckAt() } });
  for (const r of due) {
    if (opts.signal?.aborted) break;
    let status: string;
    try {
      status = (await ctx.orders.getCheckoutStatus(r.checkoutId))?.status ?? 'NOT_FOUND';
    } catch (err) {
      ctx.logger.warn({ err, checkoutId: r.checkoutId }, 'reservation sweeper: orders status unavailable; will retry');
      await backOff(r._id);
      out.skipped++;
      continue;
    }
    try {
      if (status === 'AWAITING_PAYMENT') {
        const upd = await ctx.models.StockReservation.updateOne(
          { _id: r._id, status: 'HELD' },
          { $set: { expiresAt: new Date(ctx.now().getTime() + extendMs) }, $inc: { extensions: 1 } },
        );
        if (upd.modifiedCount) out.extended++;
      } else if (PLACED.has(status)) {
        if ((await commitInTxn(ctx, r.checkoutId)) === 'COMMITTED') out.committed++;
      } else if (DEAD.has(status) || status === 'NOT_FOUND') {
        if (await releaseInTxn(ctx, r.checkoutId, status === 'NOT_FOUND' ? 'ORPHANED' : status)) out.released++;
      } else {
        ctx.logger.warn({ checkoutId: r.checkoutId, status }, 'reservation sweeper: unknown checkout status; skipping');
        await backOff(r._id);
        out.skipped++;
      }
    } catch (err) {
      ctx.logger.error({ err, checkoutId: r.checkoutId }, 'reservation sweeper: action failed');
      await backOff(r._id).catch(() => undefined);
      out.skipped++;
    }
  }
  out.pendingMemberships = await sweepPendingMemberships(ctx, { batch, ...(opts.signal ? { signal: opts.signal } : {}) });
  out.membershipsExpired = await expireMemberships(ctx);
  return out;
}
