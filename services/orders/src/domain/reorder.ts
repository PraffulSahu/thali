/**
 * Reorder (`POST /orders/:checkoutId/reorder`): put a past checkout's lines back into the user's
 * cart with today's menu. One marketplace quote (no drop point) tells us, per line, whether the
 * restaurant is open, the item available / in stock / still customizable as before, and today's
 * price (lines matched by `lineRef`). Available lines are added through the normal cart path (`addItem`, which validates again
 * and stores the display snapshot); everything else is reported in `changes[]`:
 *   PRICE_CHANGED (added, per-unit price incl. add-ons differs) | ITEM_UNAVAILABLE | OUT_OF_STOCK |
 *   INVALID_SELECTION | RESTAURANT_CLOSED | QUANTITY_LIMIT (not added).
 */
import { Types } from 'mongoose';
import { CART_MAX_QUANTITY, DomainError, formatINR } from '@thali/contracts';
import type { OrdersContext } from '../context.js';
import type { QuoteLine, QuoteProblem, QuoteResponse } from '../clients/marketplace.js';
import type { ChildOrderLine } from '../models/child-order.js';
import { addItem, cartView, findCart, type CartOwner } from './cart.js';
import { matchQuoteLines } from './quote-lines.js';

export type ReorderChangeKind = 'PRICE_CHANGED' | 'ITEM_UNAVAILABLE' | 'OUT_OF_STOCK' | 'INVALID_SELECTION' | 'RESTAURANT_CLOSED' | 'QUANTITY_LIMIT';

export interface ReorderChange {
  kind: ReorderChangeKind;
  restaurantId: string;
  restaurantName: string;
  itemId: string;
  name: string;
  quantity: number;
  added: boolean;
  oldUnitPricePaise?: number;
  newUnitPricePaise?: number;
  message: string;
}

const unitPrice = (l: { unitPricePaise: number; addOns: { pricePaise: number }[] }) => l.unitPricePaise + l.addOns.reduce((s, a) => s + a.pricePaise, 0);

const ITEM_PROBLEMS = new Set(['ITEM_UNAVAILABLE', 'OUT_OF_STOCK', 'INVALID_SELECTION']);

export async function reorder(ctx: OrdersContext, userId: string, checkoutId: string) {
  const group = Types.ObjectId.isValid(checkoutId) ? await ctx.models.CheckoutGroup.findOne({ _id: checkoutId, userId }).lean() : null;
  if (!group) throw new DomainError('NOT_FOUND', 'Order not found');
  const children = await ctx.models.ChildOrder.find({ checkoutGroupId: group._id }).sort({ restaurantId: 1 }).lean();
  const entries: { restaurantId: string; restaurantName: string; line: ChildOrderLine }[] = children.flatMap((c) =>
    c.lines.map((line) => ({ restaurantId: c.restaurantId, restaurantName: c.restaurantName, line })),
  );
  const owner: CartOwner = { kind: 'USER', userId };
  const changes: ReorderChange[] = [];
  let addedCount = 0;

  if (entries.length) {
    const refOf = (i: number) => `reorder-${i}`;
    const quote: QuoteResponse = await ctx.clients.marketplace.quote({
      items: entries.map((e, i) => ({
        lineRef: refOf(i),
        restaurantId: e.restaurantId,
        itemId: e.line.itemId,
        quantity: Math.min(e.line.quantity, CART_MAX_QUANTITY),
        selections: e.line.selections.map((s) => ({ groupId: s.groupId, optionIds: [...s.optionIds] })),
      })),
    });
    // match quote lines back by the echoed lineRef (domain/quote-lines.ts; fails closed on ambiguity)
    const matched = new Map<number, QuoteLine | null>();
    for (const restaurantId of new Set(entries.map((e) => e.restaurantId))) {
      const idx = entries.map((e, i) => (e.restaurantId === restaurantId ? i : -1)).filter((i) => i >= 0);
      const r = quote.restaurants.find((x) => x.restaurantId === restaurantId);
      const lines = r ? matchQuoteLines(idx.map((i) => ({ lineRef: refOf(i), itemId: entries[i]!.line.itemId })), r.lines) : idx.map(() => null);
      idx.forEach((i, k) => matched.set(i, lines[k] ?? null));
    }
    const problemFor = (restaurantId: string, itemId: string): QuoteProblem | undefined =>
      quote.problems.find((p) => p.restaurantId === restaurantId && p.itemId === itemId && ITEM_PROBLEMS.has(p.code));

    for (const [i, e] of entries.entries()) {
      const { line, restaurantId, restaurantName } = e;
      const base = { restaurantId, restaurantName, itemId: line.itemId, name: line.name, quantity: line.quantity };
      const restaurant = quote.restaurants.find((x) => x.restaurantId === restaurantId);
      const ql = matched.get(i) ?? undefined;
      const closed = (restaurant && !restaurant.open) || quote.problems.some((p) => p.code === 'RESTAURANT_CLOSED' && p.restaurantId === restaurantId);
      if (closed) {
        changes.push({ ...base, kind: 'RESTAURANT_CLOSED', added: false, message: `${restaurantName} is closed right now, so ${line.name} was not added.` });
        continue;
      }
      const problem = problemFor(restaurantId, line.itemId);
      const kind: ReorderChangeKind | null = !ql
        ? 'ITEM_UNAVAILABLE'
        : problem
          ? (problem.code as ReorderChangeKind)
          : !ql.available
            ? 'ITEM_UNAVAILABLE'
            : !ql.stockOk
              ? 'OUT_OF_STOCK'
              : null;
      if (kind) {
        changes.push({ ...base, kind, added: false, message: unavailableMessage(kind, line.name) });
        continue;
      }
      try {
        await addItem(ctx, owner, {
          restaurantId,
          itemId: line.itemId,
          quantity: Math.min(line.quantity, CART_MAX_QUANTITY),
          selections: line.selections.map((s) => ({ groupId: s.groupId, optionIds: [...s.optionIds] })),
          ...(line.note ? { note: line.note } : {}),
        });
      } catch (err) {
        if (!(err instanceof DomainError) || err.httpStatus >= 500) throw err;
        const k: ReorderChangeKind = ITEM_PROBLEMS.has(err.code) ? (err.code as ReorderChangeKind) : err.code === 'VALIDATION_FAILED' ? 'QUANTITY_LIMIT' : 'ITEM_UNAVAILABLE';
        changes.push({ ...base, kind: k, added: false, message: unavailableMessage(k, line.name) });
        continue;
      }
      addedCount++;
      const oldUnit = unitPrice(line);
      const newUnit = unitPrice(ql!);
      if (oldUnit !== newUnit) {
        changes.push({
          ...base,
          kind: 'PRICE_CHANGED',
          added: true,
          oldUnitPricePaise: oldUnit,
          newUnitPricePaise: newUnit,
          message: `${line.name} now costs ${formatINR(newUnit)} (was ${formatINR(oldUnit)}).`,
        });
      }
    }
  }

  const cart = await findCart(ctx, owner);
  return { cart: cartView(cart, 'USER'), changes, addedCount };
}

function unavailableMessage(kind: ReorderChangeKind, name: string): string {
  switch (kind) {
    case 'OUT_OF_STOCK':
      return `${name} is out of stock, so it was not added.`;
    case 'INVALID_SELECTION':
      return `The customizations you chose for ${name} are no longer available; add it again from the menu.`;
    case 'QUANTITY_LIMIT':
      return `Your cart already has the maximum quantity of ${name}.`;
    default:
      return `${name} is no longer available, so it was not added.`;
  }
}
