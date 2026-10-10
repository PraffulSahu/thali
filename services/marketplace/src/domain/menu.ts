/**
 * Menu management (PRD R-3): categories, items with customization groups (stable sub-ids so carts can
 * reference groupId/optionIds), availability and optional tracked stock. `reservedQty` belongs to the
 * reservation flow (Task 9); owners can never set stock below what is currently reserved.
 */
import { DomainError } from '@thali/contracts';
import { withTransaction } from '@thali/service-kit';
import { Types } from 'mongoose';
import type { AppContext } from '../context.js';
import type { MenuItemDoc } from '../models/menu-item.js';
import { findOwned, restaurantPrefix } from './onboarding.js';
import { verifyAttachment } from './uploads.js';

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
    imageUrl: i.imageKey ? ctx.storage.publicUrl(i.imageKey) : null,
    available: !!i.available,
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
  await findOwned(ctx, rid, userId);
  await assertCategory(ctx, rid, input.categoryId);
  await assertImage(ctx, rid, input.imageKey);
  const doc = await ctx.models.MenuItem.create({
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
  });
  return itemOwnerView(ctx, doc.toObject() as ItemLean);
}

export async function updateItem(ctx: AppContext, rid: string, userId: string, itemId: string, input: ItemInput) {
  await findOwned(ctx, rid, userId);
  const _id = oid(itemId);
  const before = await ctx.models.MenuItem.findOne({ _id, restaurantId: rid }).lean<ItemLean>();
  if (!before) throw notFound();
  if (input.categoryId) await assertCategory(ctx, rid, input.categoryId);
  await assertImage(ctx, rid, input.imageKey, before.imageKey); // storage I/O stays outside the txn
  const { customizationGroups, imageKey, stockQty, ...rest } = input;
  const updated = await withTransaction(ctx.conn, async (session) => {
    const doc = await ctx.models.MenuItem.findOne({ _id, restaurantId: rid }).session(session);
    if (!doc) throw notFound();
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
    return ctx.models.MenuItem.findById(_id).session(session).lean<ItemLean>();
  });
  return itemOwnerView(ctx, updated!);
}

export async function deleteItem(ctx: AppContext, rid: string, userId: string, itemId: string) {
  await findOwned(ctx, rid, userId);
  const r = await ctx.models.MenuItem.deleteOne({ _id: oid(itemId), restaurantId: rid });
  if (!r.deletedCount) throw notFound();
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
  const updated = await ctx.models.MenuItem.findOneAndUpdate(filter, { $set, $inc: { __v: 1 } }, { new: true }).lean<ItemLean>();
  if (!updated) {
    const existing = await ctx.models.MenuItem.findOne({ _id, restaurantId: rid }).lean<ItemLean>();
    if (!existing) throw notFound();
    throw new DomainError('CONFLICT', `stockQty cannot be below the reserved quantity (${existing.reservedQty})`);
  }
  return itemOwnerView(ctx, updated);
}
