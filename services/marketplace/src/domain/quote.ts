/**
 * Server-side quote (LLD §8 step 2) — the only source of prices for orders.
 *
 *  - Prices, names, veg flags and add-on prices come from the DB; nothing from the client is trusted.
 *  - Open/closed reuses `isOpenAt` (Task 8, Review Focus #1); serviceability + delivery fee reuse
 *    `findServiceArea` / `isDeliverable` / `estimateDelivery` (Task 8). Any non-deliverable reason
 *    (no area, outside radius, outside the drop's service area, ...) → `NOT_SERVICEABLE`.
 *  - Selections are validated against the item's customization groups (Review Focus #5): unknown or
 *    duplicated group/option, option from another group, unavailable option, or a count outside
 *    [minSelect, maxSelect] (missing group = 0 selected) → `INVALID_SELECTION`.
 *  - Problems never throw: the response is `{ restaurants, problems }` (orders turns problems into 422).
 *  - Each restaurant's `lines` are in the same order as that restaurant's request items (one line per
 *    request item, a placeholder for unknown items) and echo the request's `lineRef`.
 *  - `drop` omitted (cart-add validation) → serviceability is not evaluated: `serviceable: true`,
 *    fee/distance 0, `serviceabilityChecked: false`.
 */
import { Types } from 'mongoose';
import type { LatLng } from '@thali/service-kit';
import type { AppContext } from '../context.js';
import type { RestaurantLean } from './restaurant-view.js';
import { isOpenAt } from './open-status.js';
import { estimateDelivery, findServiceArea, isDeliverable, toLatLng } from './serviceability.js';

export interface QuoteSelection {
  groupId: string;
  optionIds: string[];
}

export interface QuoteItemInput {
  restaurantId: string;
  itemId: string;
  quantity: number;
  selections: QuoteSelection[];
  lineRef?: string;
}

export interface QuoteInput {
  drop?: LatLng;
  items: QuoteItemInput[];
}

export type QuoteProblemCode = 'RESTAURANT_CLOSED' | 'NOT_SERVICEABLE' | 'ITEM_UNAVAILABLE' | 'INVALID_SELECTION' | 'OUT_OF_STOCK';

export interface QuoteProblem {
  code: QuoteProblemCode;
  restaurantId?: string;
  itemId?: string;
  lineRef?: string;
  message: string;
  /** Machine-readable sub-reason, e.g. PAUSED, OUTSIDE_RADIUS, MIN_SELECT, OPTION_UNAVAILABLE. */
  reason?: string;
  groupId?: string;
  optionId?: string;
  availableQty?: number;
  nextOpenAt?: string;
}

export interface QuoteAddOn {
  id: string;
  name: string;
  pricePaise: number;
}

export interface QuoteLine {
  lineRef?: string;
  itemId: string;
  name: string;
  isVeg: boolean;
  unitPricePaise: number;
  addOns: QuoteAddOn[];
  quantity: number;
  available: boolean;
  stockOk: boolean;
}

export interface QuoteRestaurant {
  restaurantId: string;
  name: string;
  ownerUserId: string;
  location: LatLng | null;
  open: boolean;
  closedReason?: string;
  serviceable: boolean;
  serviceabilityChecked: boolean;
  deliveryFeePaise: number;
  distanceKm: number;
  etaMinutes: number;
  etaSource: string;
  packagingFeePaise: number;
  lines: QuoteLine[];
}

export interface QuoteResult {
  restaurants: QuoteRestaurant[];
  problems: QuoteProblem[];
}

interface OptionLean {
  _id: unknown;
  name: string;
  pricePaise: number;
  isVeg?: boolean;
  available?: boolean | null;
}
interface GroupLean {
  _id: unknown;
  name: string;
  minSelect: number;
  maxSelect: number;
  options?: OptionLean[];
}
export interface QuoteItemLean {
  _id: unknown;
  restaurantId: unknown;
  categoryId: unknown;
  name: string;
  pricePaise: number;
  isVeg: boolean;
  available?: boolean | null;
  trackStock?: boolean | null;
  stockQty?: number | null;
  reservedQty?: number | null;
  customizationGroups?: GroupLean[];
}

export type SelectionCheck =
  | { ok: true; addOns: QuoteAddOn[] }
  | { ok: false; addOns: QuoteAddOn[]; reason: string; message: string; groupId?: string; optionId?: string };

/**
 * Validate selections against an item's customization groups. Returns the chosen add-ons (in menu
 * order: group order, then option order) with DB prices.
 */
export function checkSelections(item: Pick<QuoteItemLean, 'customizationGroups'>, selections: QuoteSelection[]): SelectionCheck {
  const groups = item.customizationGroups ?? [];
  const byGroup = new Map<string, QuoteSelection>();
  const failures: { reason: string; message: string; groupId?: string; optionId?: string }[] = [];
  const fail = (reason: string, message: string, extra: { groupId?: string; optionId?: string } = {}) => {
    failures.push({ reason, message, ...extra });
  };

  for (const s of selections) {
    if (byGroup.has(s.groupId)) fail('DUPLICATE_GROUP', 'A customization group was selected more than once', { groupId: s.groupId });
    byGroup.set(s.groupId, s);
    if (!groups.some((g) => String(g._id) === s.groupId)) fail('UNKNOWN_GROUP', 'Unknown customization group', { groupId: s.groupId });
  }

  const addOns: QuoteAddOn[] = [];
  for (const g of groups) {
    const gid = String(g._id);
    const chosen = byGroup.get(gid)?.optionIds ?? [];
    if (new Set(chosen).size !== chosen.length) fail('DUPLICATE_OPTION', `An option in "${g.name}" was selected twice`, { groupId: gid });
    const options = g.options ?? [];
    for (const optId of chosen) {
      const o = options.find((x) => String(x._id) === optId);
      if (!o) fail('UNKNOWN_OPTION', `Unknown option for "${g.name}"`, { groupId: gid, optionId: optId });
      else if (o.available === false) fail('OPTION_UNAVAILABLE', `"${o.name}" is currently unavailable`, { groupId: gid, optionId: optId });
    }
    const n = new Set(chosen).size;
    if (n < g.minSelect) fail('MIN_SELECT', `Choose at least ${g.minSelect} for "${g.name}"`, { groupId: gid });
    if (n > g.maxSelect) fail('MAX_SELECT', `Choose at most ${g.maxSelect} for "${g.name}"`, { groupId: gid });
    // add-ons in menu order (known options only, de-duplicated)
    for (const o of options) if (chosen.includes(String(o._id))) addOns.push({ id: String(o._id), name: o.name, pricePaise: o.pricePaise });
  }
  const first = failures[0];
  if (first) return { ok: false, addOns, ...first };
  return { ok: true, addOns };
}

const isHex24 = (s: string) => /^[a-f0-9]{24}$/i.test(s);

export async function buildQuote(ctx: AppContext, input: QuoteInput): Promise<QuoteResult> {
  const now = ctx.now();
  const restaurantIds = [...new Set(input.items.map((i) => i.restaurantId))];
  const itemIds = [...new Set(input.items.map((i) => i.itemId))].filter(isHex24);

  const [restaurants, items, area] = await Promise.all([
    ctx.models.Restaurant.find({ _id: { $in: restaurantIds.filter(isHex24).map((id) => new Types.ObjectId(id)) } }).lean<RestaurantLean[]>(),
    ctx.models.MenuItem.find({ _id: { $in: itemIds.map((id) => new Types.ObjectId(id)) } }).lean<QuoteItemLean[]>(),
    input.drop ? findServiceArea(ctx.conn, input.drop) : Promise.resolve(null),
  ]);
  const categoryIds = [...new Set(items.map((i) => String(i.categoryId)))];
  const activeCategories = new Set(
    (await ctx.models.MenuCategory.find({ _id: { $in: categoryIds.map((id) => new Types.ObjectId(id)) }, active: { $ne: false } }, { _id: 1 }).lean()).map((c) => String(c._id)),
  );
  const restaurantById = new Map(restaurants.map((r) => [String(r._id), r]));
  const itemById = new Map(items.map((i) => [String(i._id), i]));

  const problems: QuoteProblem[] = [];
  const seen = new Set<string>();
  const problem = (p: QuoteProblem) => {
    const key = `${p.code}|${p.restaurantId ?? ''}|${p.itemId ?? ''}|${p.lineRef ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(p);
  };

  const out: QuoteRestaurant[] = [];
  for (const rid of restaurantIds) {
    const reqItems = input.items.filter((i) => i.restaurantId === rid);
    const r = restaurantById.get(rid);
    if (!r) {
      for (const it of reqItems)
        problem({ code: 'ITEM_UNAVAILABLE', restaurantId: rid, itemId: it.itemId, ...ref(it), reason: 'RESTAURANT_NOT_FOUND', message: 'This restaurant is no longer available' });
      continue;
    }

    // open / closed (Task 8 isOpenAt: hours in the restaurant timezone, pauses, approval)
    const open = isOpenAt(r, now);
    if (!open.open) {
      problem({
        code: 'RESTAURANT_CLOSED',
        restaurantId: rid,
        reason: open.reason,
        message: open.reason === 'PAUSED' ? `${r.name} is not accepting orders right now` : `${r.name} is closed`,
        ...(open.nextOpenAt ? { nextOpenAt: open.nextOpenAt.toISOString() } : {}),
      });
    }

    // serviceability + delivery fee (Task 8 serviceability)
    const avgPrep = r.avgPrepMinutes ?? 20;
    let delivery = { serviceable: true, checked: false, deliveryFeePaise: 0, distanceKm: 0, etaMinutes: avgPrep, etaSource: 'NOT_ESTIMATED' };
    if (input.drop) {
      const d = isDeliverable(r, area, input.drop);
      if (d.deliverable && area && r.location) {
        const est = await estimateDelivery(ctx.geo, { location: r.location, avgPrepMinutes: r.avgPrepMinutes }, area, input.drop);
        delivery = { serviceable: true, checked: true, deliveryFeePaise: est.deliveryFeePaise, distanceKm: est.distanceKm, etaMinutes: est.etaMinutes, etaSource: est.etaSource };
      } else {
        delivery = { serviceable: false, checked: true, deliveryFeePaise: 0, distanceKm: d.distanceKm ?? 0, etaMinutes: avgPrep, etaSource: 'NOT_ESTIMATED' };
        problem({ code: 'NOT_SERVICEABLE', restaurantId: rid, reason: d.reason, message: `${r.name} does not deliver to this address` });
      }
    }

    // total requested quantity per item (lines that differ only by customization share stock)
    const qtyByItem = new Map<string, number>();
    for (const it of reqItems) qtyByItem.set(it.itemId, (qtyByItem.get(it.itemId) ?? 0) + it.quantity);

    const lines: QuoteLine[] = reqItems.map((it) => {
      const item = itemById.get(it.itemId);
      if (!item || String(item.restaurantId) !== rid) {
        problem({ code: 'ITEM_UNAVAILABLE', restaurantId: rid, itemId: it.itemId, ...ref(it), reason: 'ITEM_NOT_FOUND', message: 'This item is no longer on the menu' });
        return { ...ref(it), itemId: it.itemId, name: 'Unavailable item', isVeg: false, unitPricePaise: 0, addOns: [], quantity: it.quantity, available: false, stockOk: true };
      }
      const available = item.available !== false && activeCategories.has(String(item.categoryId));
      if (!available) problem({ code: 'ITEM_UNAVAILABLE', restaurantId: rid, itemId: it.itemId, ...ref(it), reason: 'ITEM_UNAVAILABLE', message: `${item.name} is unavailable` });

      const sel = checkSelections(item, it.selections);
      if (!sel.ok) {
        problem({
          code: 'INVALID_SELECTION',
          restaurantId: rid,
          itemId: it.itemId,
          ...ref(it),
          reason: sel.reason,
          message: sel.message,
          ...(sel.groupId ? { groupId: sel.groupId } : {}),
          ...(sel.optionId ? { optionId: sel.optionId } : {}),
        });
      }

      const availableQty = Math.max(0, (item.stockQty ?? 0) - (item.reservedQty ?? 0));
      const stockOk = !item.trackStock || availableQty >= (qtyByItem.get(it.itemId) ?? it.quantity);
      if (!stockOk) {
        problem({ code: 'OUT_OF_STOCK', restaurantId: rid, itemId: it.itemId, ...ref(it), availableQty, message: availableQty > 0 ? `Only ${availableQty} ${item.name} left` : `${item.name} is out of stock` });
      }
      return { ...ref(it), itemId: it.itemId, name: item.name, isVeg: item.isVeg, unitPricePaise: item.pricePaise, addOns: sel.addOns, quantity: it.quantity, available, stockOk };
    });

    out.push({
      restaurantId: rid,
      name: r.name,
      ownerUserId: r.ownerUserId,
      location: r.location?.coordinates?.length === 2 ? toLatLng(r.location) : null,
      open: open.open,
      ...(open.reason ? { closedReason: open.reason } : {}),
      serviceable: delivery.serviceable,
      serviceabilityChecked: delivery.checked,
      deliveryFeePaise: delivery.deliveryFeePaise,
      distanceKm: delivery.distanceKm,
      etaMinutes: delivery.etaMinutes,
      etaSource: delivery.etaSource,
      packagingFeePaise: r.packagingFeePaise ?? 0,
      lines,
    });
  }
  return { restaurants: out, problems };
}

const ref = (it: { lineRef?: string }) => (it.lineRef !== undefined ? { lineRef: it.lineRef } : {});
