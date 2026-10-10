/**
 * Cart domain (LLD §3.3, §10 orders cart routes; Review Focus #5).
 *
 * - Line identity = `itemId + canonical(selections)`: same item with different customizations is a
 *   different line; identical selections (any order) merge quantities (max 20 per line).
 * - Adding/changing selections validates against the marketplace quote (single-restaurant quote
 *   without a drop point) and stores a display snapshot (name, price, add-ons).
 * - `cartVersion` is bumped on every change; checkout duplicate-submit protection keys on it.
 */
import mongoose, { Types, type ClientSession } from 'mongoose';
import {
  CART_MAX_QUANTITY,
  DomainError,
  fromGeoJsonPoint,
  toGeoJsonPoint,
  type Address,
  type CartItemInput,
  type CartItemUpdate,
  type Selection,
} from '@thali/contracts';
import { lineTotal } from '@thali/pricing';
import { withTransaction } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { Cart, CartDoc, CartLine } from '../models/cart.js';
import type { AddressSnapshot } from '../models/common.js';
import type { QuoteProblem, QuoteProblemCode, QuoteResponse } from '../clients/marketplace.js';
import { hashGuestToken, isWellFormedGuestToken } from './guest-token.js';

export const DELIVERY_NOTE = 'Delivered separately by restaurant';
export const DELIVERY_EXPLANATION =
  'Items from different restaurants are prepared and delivered separately, each by its own delivery partner.';

// ---------------------------------------------------------------------------------------------
// identity of a line

/** Drop empty groups, dedupe + sort option ids, sort groups by id. */
export function canonicalSelections(selections: readonly Selection[]): Selection[] {
  const byGroup = new Map<string, Set<string>>();
  for (const s of selections) {
    const set = byGroup.get(s.groupId) ?? new Set<string>();
    for (const o of s.optionIds) set.add(o);
    byGroup.set(s.groupId, set);
  }
  return [...byGroup.entries()]
    .filter(([, ids]) => ids.size > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([groupId, ids]) => ({ groupId, optionIds: [...ids].sort() }));
}

export function lineKeyOf(itemId: string, selections: readonly Selection[]): string {
  return `${itemId}|${canonicalSelections(selections)
    .map((s) => `${s.groupId}:${s.optionIds.join(',')}`)
    .join(';')}`;
}

// ---------------------------------------------------------------------------------------------
// owner resolution

export type CartOwner = { kind: 'USER'; userId: string } | { kind: 'GUEST'; tokenHash: string };

/** Bearer token → the user's cart; else `X-Guest-Cart` → guest cart; else 401. */
export function resolveCartOwner(req: { auth?: { userId: string }; header(name: string): string | undefined }): CartOwner {
  if (req.auth) return { kind: 'USER', userId: req.auth.userId };
  const token = req.header('x-guest-cart');
  if (token === undefined || token === '') {
    throw new DomainError('UNAUTHENTICATED', 'Sign in or send an X-Guest-Cart token');
  }
  if (!isWellFormedGuestToken(token)) throw new DomainError('NOT_FOUND', 'Guest cart not found');
  return { kind: 'GUEST', tokenHash: hashGuestToken(token) };
}

function ownerFilter(owner: CartOwner) {
  return owner.kind === 'USER' ? { userId: owner.userId, ownerType: 'USER' } : { guestTokenHash: owner.tokenHash, ownerType: 'GUEST' };
}

/** The owner's cart or null (user without a cart yet). Unknown/expired guest token → 404. */
export async function findCart(ctx: OrdersContext, owner: CartOwner, session?: ClientSession): Promise<CartDoc | null> {
  const cart = await ctx.models.Cart.findOne(ownerFilter(owner)).session(session ?? null);
  if (owner.kind === 'GUEST') {
    if (!cart || (cart.expiresAt && cart.expiresAt.getTime() < Date.now())) {
      throw new DomainError('NOT_FOUND', 'Guest cart not found or expired');
    }
  }
  return cart;
}

async function loadOrCreate(ctx: OrdersContext, owner: CartOwner, session?: ClientSession): Promise<CartDoc> {
  const existing = await findCart(ctx, owner, session);
  if (existing) return existing;
  if (owner.kind === 'GUEST') throw new DomainError('NOT_FOUND', 'Guest cart not found');
  try {
    await ctx.models.Cart.updateOne(
      { userId: owner.userId, ownerType: 'USER' },
      { $setOnInsert: { ownerType: 'USER', userId: owner.userId, items: [], cartVersion: 0 } },
      { upsert: true, ...(session ? { session } : {}) },
    );
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e; // concurrent first add: the other upsert won
  }
  const cart = await ctx.models.Cart.findOne({ userId: owner.userId, ownerType: 'USER' }).session(session ?? null);
  if (!cart) throw new DomainError('INTERNAL_ERROR', 'Cart could not be created');
  return cart;
}

/**
 * Read-modify-write with optimistic concurrency: `fn` mutates the doc and returns a result; if it
 * changed anything, `cartVersion` is bumped and saved. VersionError → reload and retry (3×).
 */
export async function mutateCart<T>(
  ctx: OrdersContext,
  owner: CartOwner,
  fn: (cart: CartDoc) => T,
): Promise<{ cart: CartDoc; result: T }> {
  for (let attempt = 0; ; attempt++) {
    const cart = await loadOrCreate(ctx, owner);
    const result = fn(cart);
    if (cart.isModified()) {
      cart.cartVersion += 1;
      try {
        await cart.save();
      } catch (e) {
        if (e instanceof mongoose.Error.VersionError && attempt < 3) continue;
        throw e;
      }
    }
    return { cart, result };
  }
}

// ---------------------------------------------------------------------------------------------
// quote validation for cart writes

const ITEM_LEVEL: QuoteProblemCode[] = ['INVALID_SELECTION', 'ITEM_UNAVAILABLE', 'OUT_OF_STOCK'];

/** Pick the most relevant problem code (order = priority). */
export function primaryProblemCode(problems: QuoteProblem[], priority: readonly QuoteProblemCode[]): QuoteProblemCode | null {
  for (const code of priority) if (problems.some((p) => p.code === code)) return code;
  return null;
}

export function problemError(code: QuoteProblemCode, problems: QuoteProblem[]): DomainError {
  const first = problems.find((p) => p.code === code);
  return new DomainError(code, first?.message || 'The cart cannot be checked out as is', 422, { problems });
}

interface ItemSnapshot {
  restaurantName: string;
  name: string;
  isVeg: boolean;
  unitPricePaise: number;
  addOns: { id: string; name: string; pricePaise: number }[];
}

async function quoteSingleItem(
  ctx: OrdersContext,
  restaurantId: string,
  itemId: string,
  quantity: number,
  selections: Selection[],
): Promise<ItemSnapshot> {
  let q: QuoteResponse;
  try {
    q = await ctx.clients.marketplace.quote({ items: [{ restaurantId, itemId, quantity, selections }] });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'NOT_FOUND') {
      throw new DomainError('ITEM_UNAVAILABLE', 'Item not found', 422, { problems: [{ code: 'ITEM_UNAVAILABLE', restaurantId, itemId }] });
    }
    throw e;
  }
  const r = q.restaurants.find((x) => x.restaurantId === restaurantId);
  const line = r?.lines.find((l) => l.itemId === itemId);
  const problems = [...q.problems];
  if (line && !line.available && !problems.some((p) => p.code === 'ITEM_UNAVAILABLE'))
    problems.push({ code: 'ITEM_UNAVAILABLE', restaurantId, itemId, message: `${line.name} is unavailable` });
  if (line && !line.stockOk && !problems.some((p) => p.code === 'OUT_OF_STOCK'))
    problems.push({ code: 'OUT_OF_STOCK', restaurantId, itemId, message: `${line.name} is out of stock` });
  const code = primaryProblemCode(problems, ITEM_LEVEL);
  if (code) throw problemError(code, problems.filter((p) => ITEM_LEVEL.includes(p.code)));
  if (!r || !line) {
    throw new DomainError('ITEM_UNAVAILABLE', 'Item not found', 422, { problems: [{ code: 'ITEM_UNAVAILABLE', restaurantId, itemId }] });
  }
  return { restaurantName: r.name, name: line.name, isVeg: line.isVeg, unitPricePaise: line.unitPricePaise, addOns: line.addOns };
}

const tooMany = () =>
  new DomainError('VALIDATION_FAILED', `At most ${CART_MAX_QUANTITY} of the same item per line`, 400, {
    issues: [{ path: 'body.quantity', code: 'too_big', message: `Max ${CART_MAX_QUANTITY}` }],
  });

// ---------------------------------------------------------------------------------------------
// commands

export async function addItem(ctx: OrdersContext, owner: CartOwner, input: CartItemInput): Promise<{ cart: CartDoc; lineId: string }> {
  const selections = canonicalSelections(input.selections);
  const key = lineKeyOf(input.itemId, selections);
  const current = await findCart(ctx, owner);
  const existingQty = current?.items.find((l) => l.lineKey === key)?.quantity ?? 0;
  if (existingQty + input.quantity > CART_MAX_QUANTITY) throw tooMany();
  const snap = await quoteSingleItem(ctx, input.restaurantId, input.itemId, existingQty + input.quantity, selections);

  const { cart, result } = await mutateCart(ctx, owner, (c) => {
    const existing = c.items.find((l) => l.lineKey === key);
    if (existing) {
      if (existing.quantity + input.quantity > CART_MAX_QUANTITY) throw tooMany();
      existing.quantity += input.quantity;
      Object.assign(existing, snap);
      if (input.note !== undefined) existing.note = input.note;
      return String(existing._id);
    }
    const line: CartLine = {
      _id: new Types.ObjectId(),
      restaurantId: input.restaurantId,
      itemId: input.itemId,
      quantity: input.quantity,
      selections,
      note: input.note ?? null,
      lineKey: key,
      addedAt: new Date(),
      ...snap,
    };
    c.items.push(line);
    return String(line._id);
  });
  return { cart, lineId: result };
}

export async function updateLine(ctx: OrdersContext, owner: CartOwner, lineId: string, patch: CartItemUpdate): Promise<CartDoc> {
  const current = await findCart(ctx, owner);
  const line = current?.items.find((l) => String(l._id) === lineId);
  if (!line) throw new DomainError('NOT_FOUND', 'Cart line not found');

  let snap: ItemSnapshot | null = null;
  let newSelections: Selection[] | null = null;
  if (patch.selections) {
    newSelections = canonicalSelections(patch.selections);
    snap = await quoteSingleItem(ctx, line.restaurantId, line.itemId, patch.quantity ?? line.quantity, newSelections);
  }

  const { cart } = await mutateCart(ctx, owner, (c) => {
    const l = c.items.find((x) => String(x._id) === lineId);
    if (!l) throw new DomainError('NOT_FOUND', 'Cart line not found');
    if (patch.quantity !== undefined) l.quantity = patch.quantity;
    if (patch.note !== undefined) l.note = patch.note;
    if (newSelections && snap) {
      const key = lineKeyOf(l.itemId, newSelections);
      const twin = c.items.find((x) => x.lineKey === key && String(x._id) !== lineId);
      if (twin) {
        // the edited line now equals another line: merge into it
        if (twin.quantity + l.quantity > CART_MAX_QUANTITY) throw tooMany();
        twin.quantity += l.quantity;
        Object.assign(twin, snap);
        c.items = c.items.filter((x) => String(x._id) !== lineId);
      } else {
        l.selections = newSelections;
        l.lineKey = key;
        Object.assign(l, snap);
      }
    }
  });
  return cart;
}

export async function removeLine(ctx: OrdersContext, owner: CartOwner, lineId: string): Promise<CartDoc> {
  const { cart } = await mutateCart(ctx, owner, (c) => {
    if (!c.items.some((x) => String(x._id) === lineId)) throw new DomainError('NOT_FOUND', 'Cart line not found');
    c.items = c.items.filter((x) => String(x._id) !== lineId);
  });
  return cart;
}

export async function clearCart(ctx: OrdersContext, owner: CartOwner): Promise<CartDoc> {
  const { cart } = await mutateCart(ctx, owner, (c) => {
    if (c.items.length) c.items = [];
    if (c.couponCode) c.couponCode = null;
  });
  return cart;
}

export function toAddressSnapshot(address: Address, addressId?: string | null): AddressSnapshot {
  return {
    ...(addressId ? { addressId } : {}),
    ...(address.label ? { label: address.label } : {}),
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    ...(address.landmark ? { landmark: address.landmark } : {}),
    city: address.city,
    pincode: address.pincode,
    location: toGeoJsonPoint(address.location),
  };
}

export async function setAddress(ctx: OrdersContext, owner: CartOwner, address: Address, addressId?: string): Promise<CartDoc> {
  const { cart } = await mutateCart(ctx, owner, (c) => {
    c.deliveryAddress = toAddressSnapshot(address, addressId);
    c.addressId = addressId ?? null;
  });
  return cart;
}

export async function setCoupon(ctx: OrdersContext, owner: CartOwner, couponCode: string | null): Promise<CartDoc> {
  const code = couponCode ? couponCode.trim().toUpperCase() : null;
  const { cart } = await mutateCart(ctx, owner, (c) => {
    if ((c.couponCode ?? null) !== code) c.couponCode = code;
  });
  return cart;
}

// ---------------------------------------------------------------------------------------------
// guest → user merge

/**
 * Merge a guest cart into the user's cart (same lineKey → quantities added, capped at 20) and delete
 * the guest cart, in one transaction. Idempotent: an unknown/already-merged token → `merged:false`.
 */
export async function mergeGuestCart(ctx: OrdersContext, userId: string, guestToken: string): Promise<{ merged: boolean; lineCount: number }> {
  const tokenHash = isWellFormedGuestToken(guestToken) ? hashGuestToken(guestToken) : null;
  return withTransaction(ctx.conn, async (session) => {
    const guest = tokenHash ? await ctx.models.Cart.findOne({ guestTokenHash: tokenHash, ownerType: 'GUEST' }).session(session) : null;
    if (!guest) {
      const mine = await ctx.models.Cart.findOne({ userId, ownerType: 'USER' }).session(session);
      return { merged: false, lineCount: mine?.items.length ?? 0 };
    }
    const user = await loadOrCreate(ctx, { kind: 'USER', userId }, session);
    for (const g of guest.items) {
      const existing = user.items.find((l) => l.lineKey === g.lineKey);
      if (existing) {
        existing.quantity = Math.min(CART_MAX_QUANTITY, existing.quantity + g.quantity);
      } else {
        user.items.push({
          _id: new Types.ObjectId(),
          restaurantId: g.restaurantId,
          restaurantName: g.restaurantName,
          itemId: g.itemId,
          name: g.name,
          isVeg: g.isVeg,
          unitPricePaise: g.unitPricePaise,
          quantity: Math.min(CART_MAX_QUANTITY, g.quantity),
          selections: g.selections.map((s) => ({ groupId: s.groupId, optionIds: [...s.optionIds] })),
          addOns: g.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise })),
          note: g.note ?? null,
          lineKey: g.lineKey,
          addedAt: g.addedAt ?? new Date(),
        });
      }
    }
    if (!user.deliveryAddress && guest.deliveryAddress) user.deliveryAddress = guest.deliveryAddress;
    if (!user.couponCode && guest.couponCode) user.couponCode = guest.couponCode;
    user.cartVersion += 1;
    await user.save({ session });
    await ctx.models.Cart.deleteOne({ _id: guest._id }, { session });
    return { merged: true, lineCount: user.items.length };
  });
}

// ---------------------------------------------------------------------------------------------
// view

export function addressView(a: AddressSnapshot | null | undefined) {
  if (!a || !a.location) return null;
  return {
    addressId: a.addressId ?? null,
    label: a.label ?? null,
    line1: a.line1,
    line2: a.line2 ?? null,
    landmark: a.landmark ?? null,
    city: a.city,
    pincode: a.pincode,
    location: fromGeoJsonPoint({ type: 'Point', coordinates: [a.location.coordinates[0]!, a.location.coordinates[1]!] }),
  };
}

export function lineView(l: CartLine) {
  const addOns = l.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise }));
  return {
    lineId: String(l._id),
    restaurantId: l.restaurantId,
    itemId: l.itemId,
    name: l.name,
    isVeg: l.isVeg,
    unitPricePaise: l.unitPricePaise,
    addOns,
    selections: l.selections.map((s) => ({ groupId: s.groupId, optionIds: [...s.optionIds] })),
    quantity: l.quantity,
    note: l.note ?? null,
    lineTotalPaise: lineTotal({ itemId: l.itemId, name: l.name, unitPricePaise: l.unitPricePaise, addOns, quantity: l.quantity }),
  };
}

/** Group lines by restaurant (first-added order) with per-restaurant subtotals. */
export function cartView(cart: Pick<Cart, '_id' | 'ownerType' | 'items' | 'cartVersion' | 'deliveryAddress' | 'couponCode' | 'expiresAt'> | null, ownerType: 'USER' | 'GUEST') {
  const groups: {
    restaurantId: string;
    restaurantName: string;
    lines: ReturnType<typeof lineView>[];
    subtotalPaise: number;
    itemCount: number;
    delivery: { mode: 'SEPARATE'; note: string };
  }[] = [];
  for (const l of cart?.items ?? []) {
    let g = groups.find((x) => x.restaurantId === l.restaurantId);
    if (!g) {
      g = { restaurantId: l.restaurantId, restaurantName: l.restaurantName, lines: [], subtotalPaise: 0, itemCount: 0, delivery: { mode: 'SEPARATE', note: DELIVERY_NOTE } };
      groups.push(g);
    }
    const v = lineView(l);
    g.lines.push(v);
    g.subtotalPaise += v.lineTotalPaise;
    g.itemCount += v.quantity;
  }
  return {
    id: cart ? String(cart._id) : null,
    ownerType: cart?.ownerType ?? ownerType,
    cartVersion: cart?.cartVersion ?? 0,
    groups,
    restaurantCount: groups.length,
    itemCount: groups.reduce((s, g) => s + g.itemCount, 0),
    subtotalPaise: groups.reduce((s, g) => s + g.subtotalPaise, 0),
    deliveryAddress: addressView(cart?.deliveryAddress),
    couponCode: cart?.couponCode ?? null,
    expiresAt: cart?.expiresAt ? cart.expiresAt.toISOString() : null,
    deliveryExplanation: groups.length > 1 ? DELIVERY_EXPLANATION : null,
  };
}
export type CartView = ReturnType<typeof cartView>;

