/**
 * Denormalised per-restaurant menu statistics (MKT-13): `restaurants.menuStats`. Discovery reads
 * these instead of running a `$group` over every candidate's items on each request.
 *
 *  - `itemCount`          all items (any availability)
 *  - `availableItemCount` items with `available: true` (owner toggle; tracked stock does not count —
 *                         the price band must not flicker when one dish sells out)
 *  - `nonVegCount`        items that are non-veg OR carry a non-veg option, any availability (veg
 *                         classification must not depend on what is toggled on right now)
 *  - `avgItemPricePaise`  rounded average base price of the available items (null when none)
 *  - `priceBand`          `priceBandOf(avgItemPricePaise)` (null when no available items)
 *
 * Maintained in the SAME transaction as every menu write (`domain/menu.ts`); bulk loaders (seed)
 * call `recomputeMenuStats(conn)` once after inserting. Discovery self-heals restaurants that have
 * no `menuStats` yet (data written before this field existed).
 */
import { Types, type ClientSession, type Connection } from 'mongoose';
import { menuItemModel } from '../models/menu-item.js';
import { restaurantModel } from '../models/restaurant.js';

export interface MenuStats {
  itemCount: number;
  availableItemCount: number;
  nonVegCount: number;
  avgItemPricePaise: number | null;
  priceBand: 1 | 2 | 3 | null;
  updatedAt: Date;
}

/** Cost-for-one band from the average available item price: 1 < ₹200 ≤ 2 ≤ ₹400 < 3. */
export function priceBandOf(avgPaise: number): 1 | 2 | 3 {
  if (avgPaise < 20000) return 1;
  if (avgPaise <= 40000) return 2;
  return 3;
}

export const emptyMenuStats = (at: Date): MenuStats => ({ itemCount: 0, availableItemCount: 0, nonVegCount: 0, avgItemPricePaise: null, priceBand: null, updatedAt: at });

interface StatItem {
  isVeg: boolean;
  available?: boolean | null;
  pricePaise: number;
  customizationGroups?: { options?: { isVeg: boolean }[] | null }[] | null;
}

export const itemHasNonVeg = (i: Pick<StatItem, 'isVeg' | 'customizationGroups'>) =>
  !i.isVeg || (i.customizationGroups ?? []).some((g) => (g.options ?? []).some((o) => o.isVeg === false));

/** Same numbers as the aggregate, from items already in memory (restaurant page). */
export function menuStatsFromItems(items: readonly StatItem[], at: Date): MenuStats {
  const available = items.filter((i) => !!i.available);
  const avg = available.length ? Math.round(available.reduce((s, i) => s + i.pricePaise, 0) / available.length) : null;
  return {
    itemCount: items.length,
    availableItemCount: available.length,
    nonVegCount: items.filter(itemHasNonVeg).length,
    avgItemPricePaise: avg,
    priceBand: avg === null ? null : priceBandOf(avg),
    updatedAt: at,
  };
}

const toOid = (id: string | Types.ObjectId) => (typeof id === 'string' ? new Types.ObjectId(id) : id);

/** Aggregate stats for the given restaurants (all restaurants with items when `ids` is undefined). */
export async function computeMenuStats(conn: Connection, ids?: readonly (string | Types.ObjectId)[], session?: ClientSession, at = new Date()): Promise<Map<string, MenuStats>> {
  const match = ids ? { restaurantId: { $in: ids.map(toOid) } } : {};
  const agg = menuItemModel(conn).aggregate<{ _id: Types.ObjectId; n: number; avail: number; nonVeg: number; sumAvail: number }>([
    { $match: match },
    {
      $project: {
        restaurantId: 1,
        available: { $cond: [{ $eq: ['$available', true] }, 1, 0] },
        pricePaise: 1,
        nonVeg: {
          $cond: [
            {
              $or: [
                { $eq: ['$isVeg', false] },
                { $in: [false, { $reduce: { input: { $ifNull: ['$customizationGroups.options.isVeg', []] }, initialValue: [], in: { $concatArrays: ['$$value', '$$this'] } } }] },
              ],
            },
            1,
            0,
          ],
        },
      },
    },
    {
      $group: {
        _id: '$restaurantId',
        n: { $sum: 1 },
        avail: { $sum: '$available' },
        nonVeg: { $sum: '$nonVeg' },
        sumAvail: { $sum: { $multiply: ['$available', '$pricePaise'] } },
      },
    },
  ]);
  if (session) agg.session(session);
  const rows = await agg;
  const out = new Map<string, MenuStats>();
  for (const r of rows) {
    const avg = r.avail ? Math.round(r.sumAvail / r.avail) : null;
    out.set(String(r._id), {
      itemCount: r.n,
      availableItemCount: r.avail,
      nonVegCount: r.nonVeg,
      avgItemPricePaise: avg,
      priceBand: avg === null ? null : priceBandOf(avg),
      updatedAt: at,
    });
  }
  return out;
}

/**
 * Recompute and store `menuStats`. With `restaurantId` (one or many): only those restaurants. Without:
 * every restaurant (restaurants with no items get zero stats) — call this after bulk menu inserts.
 * Pass `session` to run inside the caller's transaction. Returns the number of restaurants updated.
 */
export async function recomputeMenuStats(
  conn: Connection,
  restaurantId?: string | Types.ObjectId | readonly (string | Types.ObjectId)[],
  session?: ClientSession,
): Promise<number> {
  const at = new Date();
  const ids = restaurantId === undefined ? undefined : (Array.isArray(restaurantId) ? restaurantId : [restaurantId]).map((x) => toOid(x as string | Types.ObjectId));
  const stats = await computeMenuStats(conn, ids, session, at);
  const Restaurant = restaurantModel(conn);
  const targets = ids ?? (await Restaurant.find({}, { _id: 1 }, session ? { session } : {}).lean<{ _id: Types.ObjectId }[]>()).map((r) => r._id);
  if (!targets.length) return 0;
  let n = 0;
  for (let i = 0; i < targets.length; i += 1000) {
    const ops = targets.slice(i, i + 1000).map((id) => ({
      updateOne: { filter: { _id: id }, update: { $set: { menuStats: stats.get(String(id)) ?? emptyMenuStats(at) } } },
    }));
    const r = await Restaurant.bulkWrite(ops, { ordered: false, ...(session ? { session } : {}) });
    n += r.matchedCount;
  }
  return n;
}
