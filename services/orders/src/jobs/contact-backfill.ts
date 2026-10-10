/**
 * Idempotent startup migration (leader-locked like the sweepers; the scheduler's first tick runs it
 * at boot, later ticks are a cheap indexed no-op that also catch rows written by an older instance
 * during a rolling deploy):
 *  - ORD-7: `child_orders.customerContact.phoneLast4` from the stored masked phone (`+91******3210`
 *    → `3210`; null when no digits are known, so the row is never picked again).
 *  - ORD-1: `checkout_groups.customerContact {name, phoneMasked, phoneLast4}` copied from the group's
 *    first child snapshot (a group without children gets `{name:'Customer', phoneMasked:'', phoneLast4:null}`).
 *  - ORD-3: `checkout_groups.restaurantSetKey = '*'` where missing (queries already treat absence as
 *    `'*'`). AWAITING_PAYMENT groups are skipped until they settle, so the new unique partial index
 *    can never be hit by the backfill itself.
 *
 * Writes use `updateOne` with the "still missing" condition in the filter, so a concurrent writer
 * (new checkout) always wins and re-runs never change anything. `timestamps: false` keeps
 * `updatedAt` untouched (this is a data fix, not a business change).
 */
import type { OrdersContext } from '../context.js';
import { phoneLast4 } from '../domain/codes.js';
import type { ChildOrder } from '../models/child-order.js';
import type { JobModule } from './types.js';

const BATCH = 500;
export const CONTACT_BACKFILL_INTERVAL_MS = 5 * 60_000;

export interface ContactBackfillCounts {
  children: number;
  groups: number;
  setKeys: number;
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

async function backfillGroups(ctx: OrdersContext, batch: number, signal?: AbortSignal): Promise<number> {
  const missing = { $or: [{ customerContact: { $exists: false } }, { customerContact: null }, { 'customerContact.phoneLast4': { $exists: false } }] };
  let updated = 0;
  let after: unknown = null;
  for (;;) {
    if (signal?.aborted) break;
    const rows = await ctx.models.CheckoutGroup.find({ ...missing, ...(after ? { _id: { $gt: after } } : {}) }, { _id: 1 })
      .sort({ _id: 1 })
      .limit(batch)
      .lean();
    if (!rows.length) break;
    after = rows[rows.length - 1]!._id;
    const kids = await ctx.models.ChildOrder.find({ checkoutGroupId: { $in: rows.map((r) => r._id) } }, { checkoutGroupId: 1, customerContact: 1 })
      .sort({ _id: 1 })
      .lean<Pick<ChildOrder, '_id' | 'checkoutGroupId' | 'customerContact'>[]>();
    const firstByGroup = new Map<string, ChildOrder['customerContact']>();
    for (const k of kids) if (!firstByGroup.has(String(k.checkoutGroupId))) firstByGroup.set(String(k.checkoutGroupId), k.customerContact);
    const res = await ctx.models.CheckoutGroup.bulkWrite(
      rows.map((r) => {
        const c = firstByGroup.get(String(r._id));
        const contact = {
          name: c?.name || 'Customer',
          phoneMasked: c?.phoneMasked ?? '',
          phoneLast4: c?.phoneLast4 ?? phoneLast4(c?.phoneMasked),
        };
        return { updateOne: { filter: { _id: r._id, ...missing }, update: { $set: { customerContact: contact } }, timestamps: false } };
      }),
      { ordered: false },
    );
    updated += res.modifiedCount;
    if (rows.length < batch) break;
  }
  return updated;
}

async function backfillSetKeys(ctx: OrdersContext): Promise<number> {
  const res = await ctx.models.CheckoutGroup.updateMany(
    { restaurantSetKey: { $exists: false }, status: { $ne: 'AWAITING_PAYMENT' } },
    { $set: { restaurantSetKey: '*' } },
    { timestamps: false },
  );
  return res.modifiedCount;
}

export async function runContactBackfill(ctx: OrdersContext, opts: { signal?: AbortSignal; batch?: number } = {}): Promise<ContactBackfillCounts> {
  const batch = opts.batch ?? BATCH;
  // children first: groups copy the child snapshot incl. its phoneLast4
  const children = await backfillChildren(ctx, batch, opts.signal);
  const groups = await backfillGroups(ctx, batch, opts.signal);
  const setKeys = opts.signal?.aborted ? 0 : await backfillSetKeys(ctx);
  const counts: ContactBackfillCounts = { children, groups, setKeys };
  if (children || groups || setKeys) ctx.logger.info({ counts }, 'contact backfill');
  return counts;
}

export const contactBackfillJob: JobModule = {
  name: 'orders:contact-backfill',
  intervalMs: () => CONTACT_BACKFILL_INTERVAL_MS,
  run: async (ctx, { signal }) => {
    await runContactBackfill(ctx, { signal });
  },
};
