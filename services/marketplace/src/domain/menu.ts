/**
 * Menu management (PRD R-3): categories, items with customization groups (stable sub-ids so carts can
 * reference groupId/optionIds), availability and optional tracked stock. `reservedQty` belongs to the
 * reservation flow (Task 9); owners can never set stock below what is currently reserved.
 */
import { DomainError } from '@thali/contracts';
import { withTransaction } from '@thali/service-kit';
import { Types, type ClientSession } from 'mongoose';
import type { AppContext } from '../context.js';
import type { MenuItemDoc } from '../models/menu-item.js';
import { bumpDiscoveryEpoch } from './discovery-cache.js';
import { recomputeMenuStats } from './menu-stats.js';
import { findOwned, restaurantPrefix } from './onboarding.js';
import { verifyAttachment } from './uploads.js';

/** MKT-9: at most this many "Recommended" items per restaurant. */
export const MAX_FEATURED_ITEMS = 6;

export interface OptionInput { id?: string; name: string; pricePaise: number; isVeg: boolean; available?: boolean }
export interface GroupInput { id?: string; name: string; minSelect: number; maxSelect: number; options: OptionInput[] }
export interface ItemInput {
  categoryId?: string;
  name?: string;
  description?: string;
  pricePaise?: number;
  isVeg?: boolean;
  imageKey?: string | null;
  available?: boolean;
  trackStock?: boolean;
  stockQty?: number;
  customizationGroups?: GroupInput[];
  tags?: string[];
  featured?: boolean;
}

type ItemLean = MenuItemDoc & { _id: Types.ObjectId; createdAt?: Date; updatedAt?: Date };

const notFound = (what = 'Menu item') => new DomainError('NOT_FOUND', `${what} not found`);
const oid = (id: string, what?: string) => {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw notFound(what);
  return new Types.ObjectId(id);
};

export function itemOwnerView(ctx: AppContext, i: ItemLean) {
  return {
    id: String(i._id),
    restaurantId: String(i.restaurantId),
    categoryId: String(i.categoryId),
    name: i.name,
    description: i.description ?? '',
    pricePaise: i.pricePaise,
    isVeg: i.isVeg,
    imageKey: i.imageKey ?? null,
    imageUrl: ctx.imageUrl(i.imageKey),
    available: !!i.available,
    featured: !!i.featured,
    trackStock: !!i.trackStock,
    stockQty: i.stockQty ?? 0,
    reservedQty: i.reservedQty ?? 0,
    availableQty: i.trackStock ? Math.max(0, (i.stockQty ?? 0) - (i.reservedQty ?? 0)) : null,
    customizationGroups: (i.customizationGroups ?? []).map((g) => ({
      id: String((g as { _id?: unknown })._id),
      name: g.name,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      options: (g.options ?? []).map((o) => ({
        id: String((o as { _id?: unknown })._id),
        name: o.name,
        pricePaise: o.pricePaise,
        isVeg: o.isVeg,
        available: o.available !== false,
      })),
    })),
    tags: i.tags ?? [],
    updatedAt: i.updatedAt ? new Date(i.updatedAt).toISOString() : null,
  };
}

export function categoryView(c: { _id: unknown; restaurantId: unknown; name: string; sortOrder?: number | null; active?: boolean | null }) {
  return { id: String(c._id), restaurantId: String(c.restaurantId), name: c.name, sortOrder: c.sortOrder ?? 0, active: c.active !== false };
}

const toGroups = (groups: GroupInput[]) =>
  groups.map((g) => ({
    _id: g.id ? new Types.ObjectId(g.id) : new Types.ObjectId(),
    name: g.name,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    options: g.options.map((o) => ({
      _id: o.id ? new Types.ObjectId(o.id) : new Types.ObjectId(),
      name: o.name,
      pricePaise: o.pricePaise,
      isVeg: o.isVeg,
      available: o.available ?? true,
    })),
  }));

/** MKT-4: a pure-veg restaurant cannot carry a non-veg item or option. */
function assertPureVeg(pureVeg: boolean | null | undefined, item: { id?: string; isVeg?: boolean; customizationGroups?: { options: { id?: string; isVeg: boolean }[] }[] }) {
  if (pureVeg !== true) return;
  if (item.isVeg === false) {
    throw new DomainError('PURE_VEG_VIOLATION', 'This is a pure-veg restaurant: non-veg items are not allowed', undefined, item.id ? { itemId: item.id } : {});
  }
  for (const g of item.customizationGroups ?? []) {
    const bad = g.options.find((o) => o.isVeg === false);
    if (bad) {
      throw new DomainError('PURE_VEG_VIOLATION', 'This is a pure-veg restaurant: non-veg options are not allowed', undefined, {
        ...(item.id ? { itemId: item.id } : {}),
        ...(bad.id ? { optionId: bad.id } : {}),
      });
    }
  }
}

/** MKT-9: featured cap, checked inside the write transaction. */
async function assertFeaturedCap(ctx: AppContext, session: ClientSession, rid: string, exceptItemId?: Types.ObjectId) {
  const filter: Record<string, unknown> = { restaurantId: new Types.ObjectId(rid), featured: true };
  if (exceptItemId) filter._id = { $ne: exceptItemId };
  const n = await ctx.models.MenuItem.countDocuments(filter).session(session);
  if (n >= MAX_FEATURED_ITEMS) {
    throw new DomainError('VALIDATION_FAILED', `At most ${MAX_FEATURED_ITEMS} items can be recommended`, 422, {
      issues: [{ path: 'body.featured', message: `At most ${MAX_FEATURED_ITEMS} recommended items per restaurant` }],
    });
  }
}

/** Every menu write ends here: stats in the same transaction (MKT-13). */
const syncStats = (ctx: AppContext, rid: string, session: ClientSession) => recomputeMenuStats(ctx.conn, rid, session);

// ---- categories ----
export async function listCategories(ctx: AppContext, rid: string, userId: string) {
  await findOwned(ctx, rid, userId);
  const rows = await ctx.models.MenuCategory.find({ restaurantId: rid }).sort({ sortOrder: 1, _id: 1 }).lean();
  return rows.map(categoryView);
}

export async function createCategory(ctx: AppContext, rid: string, userId: string, input: { name: string; sortOrder?: number; active?: boolean }) {
  await findOwned(ctx, rid, userId);
  const c = await ctx.models.MenuCategory.create({ restaurantId: rid, name: input.name, sortOrder: input.sortOrder ?? 0, active: input.active ?? true });
  return categoryView(c);
}

export async function updateCategory(ctx: AppContext, rid: string, userId: string, categoryId: string, input: { name?: string; sortOrder?: number; active?: boolean }) {
  await findOwned(ctx, rid, userId);
  const c = await ctx.models.MenuCategory.findOneAndUpdate({ _id: oid(categoryId, 'Category'), restaurantId: rid }, { $set: input }, { new: true }).lean();
  if (!c) throw notFound('Category');
  return categoryView(c);
}

export async function deleteCategory(ctx: AppContext, rid: string, userId: string, categoryId: string) {
  await findOwned(ctx, rid, userId);
  const id = oid(categoryId, 'Category');
  const c = await ctx.models.MenuCategory.findOne({ _id: id, restaurantId: rid }).lean();
  if (!c) throw notFound('Category');
  if (await ctx.models.MenuItem.exists({ categoryId: id, restaurantId: rid })) {
    throw new DomainError('CONFLICT', 'Move or delete the items in this category first');
  }
  await ctx.models.MenuCategory.deleteOne({ _id: id, restaurantId: rid });
}

// ---- items ----
async function assertCategory(ctx: AppContext, rid: string, categoryId: string) {
  const ok = await ctx.models.MenuCategory.exists({ _id: oid(categoryId, 'Category'), restaurantId: rid });
  if (!ok) throw notFound('Category');
}

async function assertImage(ctx: AppContext, rid: string, key: string | null | undefined, current?: string | null) {
  if (key && key !== current) await verifyAttachment(ctx.storage, ctx.config, { prefix: restaurantPrefix(rid), purpose: 'IMAGE', key });
}

export async function listItems(ctx: AppContext, rid: string, userId: string, categoryId?: string) {
  await findOwned(ctx, rid, userId);
  const filter: Record<string, unknown> = { restaurantId: rid };
  if (categoryId) filter.categoryId = oid(categoryId, 'Category');
  const rows = await ctx.models.MenuItem.find(filter).sort({ categoryId: 1, name: 1 }).lean<ItemLean[]>();
  return rows.map((i) => itemOwnerView(ctx, i));
}

export async function getItem(ctx: AppContext, rid: string, userId: string, itemId: string) {
  await findOwned(ctx, rid, userId);
  const i = await ctx.models.MenuItem.findOne({ _id: oid(itemId), restaurantId: rid }).lean<ItemLean>();
  if (!i) throw notFound();
  return itemOwnerView(ctx, i);
}

export async function createItem(ctx: AppContext, rid: string, userId: string, input: ItemInput & { categoryId: string; name: string; pricePaise: number; isVeg: boolean }) {
  const restaurant = await findOwned(ctx, rid, userId);
  assertPureVeg(restaurant.pureVeg, input);
  await assertCategory(ctx, rid, input.categoryId);
  await assertImage(ctx, rid, input.imageKey);
  const created = await withTransaction(ctx.conn, async (session) => {
    // re-check under the transaction: a concurrent pureVeg=true commit makes this retry and fail here
    assertPureVeg((await findOwned(ctx, rid, userId, session)).pureVeg, input);
    if (input.featured) await assertFeaturedCap(ctx, session, rid);
    const [doc] = await ctx.models.MenuItem.create([{
    restaurantId: rid,
    categoryId: input.categoryId,
    name: input.name,
    description: input.description ?? '',
    pricePaise: input.pricePaise,
    isVeg: input.isVeg,
    ...(input.imageKey ? { imageKey: input.imageKey } : {}),
    available: input.available ?? true,
    trackStock: input.trackStock ?? false,
    stockQty: input.stockQty ?? 0,
    reservedQty: 0,
    customizationGroups: toGroups(input.customizationGroups ?? []),
    tags: input.tags ?? [],
    featured: input.featured ?? false,
    }], { session });
    await syncStats(ctx, rid, session);
    return doc!;
  });
  await bumpDiscoveryEpoch(ctx.redis);
  return itemOwnerView(ctx, created.toObject() as ItemLean);
}

export async function updateItem(ctx: AppContext, rid: string, userId: string, itemId: string, input: ItemInput) {
  const restaurant = await findOwned(ctx, rid, userId);
  const _id = oid(itemId);
  const before = await ctx.models.MenuItem.findOne({ _id, restaurantId: rid }).lean<ItemLean>();
  if (!before) throw notFound();
  assertPureVeg(restaurant.pureVeg, {
    id: itemId,
    isVeg: input.isVeg ?? before.isVeg,
    customizationGroups: input.customizationGroups ?? (before.customizationGroups ?? []).map((g) => ({ options: (g.options ?? []).map((o) => ({ id: String((o as { _id?: unknown })._id), isVeg: o.isVeg })) })),
  });
  if (input.categoryId) await assertCategory(ctx, rid, input.categoryId);
  await assertImage(ctx, rid, input.imageKey, before.imageKey); // storage I/O stays outside the txn
  const { customizationGroups, imageKey, stockQty, ...rest } = input;
  const updated = await withTransaction(ctx.conn, async (session) => {
    const doc = await ctx.models.MenuItem.findOne({ _id, restaurantId: rid }).session(session);
    if (!doc) throw notFound();
    assertPureVeg((await findOwned(ctx, rid, userId, session)).pureVeg, {
      id: itemId,
      isVeg: input.isVeg ?? doc.isVeg,
      customizationGroups: input.customizationGroups ?? (doc.customizationGroups ?? []).map((g) => ({ options: (g.options ?? []).map((o) => ({ id: String(o._id), isVeg: o.isVeg })) })),
    });
    if (rest.featured && !doc.featured) await assertFeaturedCap(ctx, session, rid, _id);
    doc.set(rest);
    if (imageKey === null) doc.set('imageKey', undefined);
    else if (imageKey !== undefined) doc.set('imageKey', imageKey);
    if (customizationGroups) doc.set('customizationGroups', toGroups(customizationGroups));
    await doc.save({ session }); // OCC: concurrent owner edit → 409 CONCURRENT_MODIFICATION
    if (stockQty !== undefined) {
      // floor enforced at write time against the live reservedQty (reservations $inc it concurrently)
      const r = await ctx.models.MenuItem.updateOne(
        { _id, restaurantId: rid, $expr: { $gte: [stockQty, '$reservedQty'] } },
        { $set: { stockQty }, $inc: { __v: 1 } },
        { session },
      );
      if (!r.matchedCount) {
        const live = await ctx.models.MenuItem.findById(_id).session(session).lean<ItemLean>();
        throw new DomainError('CONFLICT', `stockQty cannot be below the reserved quantity (${live?.reservedQty ?? 0})`);
      }
    }
    await syncStats(ctx, rid, session);
    return ctx.models.MenuItem.findById(_id).session(session).lean<ItemLean>();
  });
  await bumpDiscoveryEpoch(ctx.redis);
  return itemOwnerView(ctx, updated!);
}

export async function deleteItem(ctx: AppContext, rid: string, userId: string, itemId: string) {
  await findOwned(ctx, rid, userId);
  const _id = oid(itemId);
  await withTransaction(ctx.conn, async (session) => {
    const r = await ctx.models.MenuItem.deleteOne({ _id, restaurantId: rid }, { session });
    if (!r.deletedCount) throw notFound();
    await syncStats(ctx, rid, session);
  });
  await bumpDiscoveryEpoch(ctx.redis);
}

/**
 * Availability toggle / stock set. Setting `stockQty` turns tracking on; the update is conditional on
 * `reservedQty <= stockQty` so it cannot race a reservation into negative availability.
 */
export async function setAvailability(
  ctx: AppContext,
  rid: string,
  userId: string,
  itemId: string,
  input: { available?: boolean; stockQty?: number; trackStock?: boolean },
) {
  await findOwned(ctx, rid, userId);
  const _id = oid(itemId);
  const $set: Record<string, unknown> = {};
  if (input.available !== undefined) $set.available = input.available;
  if (input.trackStock !== undefined) $set.trackStock = input.trackStock;
  if (input.stockQty !== undefined) {
    $set.stockQty = input.stockQty;
    if (input.trackStock === undefined) $set.trackStock = true;
  }
  const filter: Record<string, unknown> = { _id, restaurantId: rid };
  if (input.stockQty !== undefined) filter.$expr = { $gte: [input.stockQty, '$reservedQty'] };
  const updated = await withTransaction(ctx.conn, async (session) => {
    const doc = await ctx.models.MenuItem.findOneAndUpdate(filter, { $set, $inc: { __v: 1 } }, { new: true, session }).lean<ItemLean>();
    if (!doc) {
      const existing = await ctx.models.MenuItem.findOne({ _id, restaurantId: rid }).session(session).lean<ItemLean>();
      if (!existing) throw notFound();
      throw new DomainError('CONFLICT', `stockQty cannot be below the reserved quantity (${existing.reservedQty})`);
    }
    if (input.available !== undefined) await syncStats(ctx, rid, session);
    return doc;
  });
  await bumpDiscoveryEpoch(ctx.redis);
  return itemOwnerView(ctx, updated);
}
