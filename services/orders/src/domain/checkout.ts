/**
 * Checkout saga (LLD §8 steps 1–9, HLD §4.1 incl. failure branches) and cart preview.
 *
 *  1 load cart (422 CART_EMPTY)          → duplicate-submit: existing AWAITING_PAYMENT checkout for
 *                                          {userId, cartVersion, restaurantSetKey} is returned (200)
 *    ORD-3: optional `restaurantIds` selects a subset of the cart's restaurants (422 VALIDATION_FAILED
 *    for a restaurant not in the cart); only those groups are quoted, reserved and placed, the other
 *    lines stay in the cart. A subset covering every cart restaurant is the whole cart (`'*'`).
 *  2 marketplace quote (422 + problems)  3 refresh cart snapshot; 422 PRICE_CHANGED on expectedTotal
 *  4 coupon + membership                 5 priceCheckout
 *  6 checkoutId → marketplace reserve (409 OUT_OF_STOCK / 422 COUPON_LIMIT_REACHED)
 *  7 txn: CheckoutGroup + ChildOrders (AWAITING_PAYMENT) + outbox checkout.created; cart checkedOutVersion
 *  8 payments intent; failure → PAYMENT_FAILED + checkout.released + 502
 *  9 201 { checkout, payment }
 *
 * Concurrency: a short Redis lock per {userId, cartVersion, restaurantSetKey} serialises concurrent submits so the
 * losers simply return the winner's checkout; the unique partial index is the backstop (a loser
 * that still reaches step 7 releases its own reservation and returns the winner).
 */
import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { DomainError, restaurantSetKey, type CreateCheckoutBody } from '@thali/contracts';
import { couponNotApplicableError, couponScope, lineTotal, priceCheckout, type PricedCheckout, type RestaurantInput } from '@thali/pricing';
import { redisKey, withTransaction } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import type { InternalUser } from '../clients/identity.js';
import type {
  InternalRestaurant,
  LatLng,
  MembershipBenefitsResponse,
  QuoteLine,
  QuoteProblem,
  QuoteProblemCode,
  QuoteResponse,
  QuoteRestaurant,
} from '../clients/marketplace.js';
import type { CartDoc, CartLine } from '../models/cart.js';
import type { CheckoutGroup, CheckoutGroupDoc, PaymentSnapshot } from '../models/checkout-group.js';
import type { ChildOrder } from '../models/child-order.js';
import type { AddressSnapshot } from '../models/common.js';
import { appendOrderEvents } from '../models/order-event.js';
import { DELIVERY_NOTE, findCart, primaryProblemCode, problemError, toAddressSnapshot, addressView } from './cart.js';
import { handoverCodePair, maskPhone, orderCode } from './codes.js';
import { emitOrdersEvent } from './events.js';
import { matchQuoteLines } from './quote-lines.js';
import { queueOrderUpdated } from './realtime.js';
import { releaseCheckout, releaseOrphanReservation } from './release.js';
import { checkoutView, paymentView, type CheckoutView, type PaymentView } from './views.js';

export const CHECKOUT_PROBLEM_PRIORITY: readonly QuoteProblemCode[] = [
  'RESTAURANT_CLOSED',
  'NOT_SERVICEABLE',
  'ITEM_UNAVAILABLE',
  'INVALID_SELECTION',
  'OUT_OF_STOCK',
];

// ---------------------------------------------------------------------------------------------
// quote + pricing (shared by preview and checkout)

export interface MappedLine {
  cartLine: CartLine;
  quoteLine: QuoteLine;
}
export interface QuotedRestaurant {
  quote: QuoteRestaurant;
  lines: MappedLine[];
}

export interface QuoteAndPrice {
  quote: QuoteResponse;
  problems: QuoteProblem[];
  restaurants: QuotedRestaurant[];
  itemsSubtotalPaise: number;
  /** `restaurantIds`: the coupon's restaurant scope (empty = every restaurant), contract 1 / MKT-8. */
  coupon: { code: string; valid: boolean; discountPaise: number; restaurantIds: string[]; message?: string } | null;
  membership: MembershipBenefitsResponse | null;
  priced: PricedCheckout;
}

/** The cart lines a checkout covers plus its idempotency set key (ORD-3). */
export interface CartSelection {
  lines: CartLine[];
  /** `restaurantSetKey(restaurantIds)`; `'*'` for the whole cart (also when the subset covers every restaurant). */
  setKey: string;
}

/**
 * Restrict the cart to `restaurantIds` (ORD-3). Absent → every line, key `'*'`. A requested restaurant
 * with no line in the cart → 422 VALIDATION_FAILED (`details.restaurantIds` lists them).
 */
export function selectCartLines(cart: Pick<CartDoc, 'items'>, restaurantIds?: readonly string[] | null): CartSelection {
  if (!restaurantIds || restaurantIds.length === 0) return { lines: [...cart.items], setKey: '*' };
  const wanted = new Set(restaurantIds.map((i) => i.toLowerCase()));
  const inCart = new Set(cart.items.map((l) => l.restaurantId.toLowerCase()));
  const missing = [...wanted].filter((id) => !inCart.has(id));
  if (missing.length) {
    throw new DomainError('VALIDATION_FAILED', 'Some selected restaurants have nothing in your cart', 422, {
      restaurantIds: missing,
      issues: missing.map((id) => ({ path: 'body.restaurantIds', code: 'custom', message: `Restaurant ${id} is not in the cart` })),
    });
  }
  const lines = cart.items.filter((l) => wanted.has(l.restaurantId.toLowerCase()));
  return { lines, setKey: wanted.size === inCart.size ? '*' : restaurantSetKey([...wanted]) };
}

/** Quote the selected cart lines, collect problems, map quote lines back to cart lines (by echoed lineRef). */
async function quoteCart(ctx: OrdersContext, cartLines: CartLine[], drop: LatLng) {
  const items = cartLines.map((l) => ({
    lineRef: String(l._id),
    restaurantId: l.restaurantId,
    itemId: l.itemId,
    quantity: l.quantity,
    selections: l.selections.map((s) => ({ groupId: s.groupId, optionIds: [...s.optionIds] })),
  }));
  const quote = await ctx.clients.marketplace.quote({ drop, items });
  const problems: QuoteProblem[] = [...quote.problems];
  const has = (code: QuoteProblemCode, restaurantId: string, itemId?: string) =>
    problems.some((p) => p.code === code && p.restaurantId === restaurantId && (itemId === undefined || p.itemId === itemId));

  const byRestaurant = new Map<string, CartLine[]>();
  for (const l of cartLines) byRestaurant.set(l.restaurantId, [...(byRestaurant.get(l.restaurantId) ?? []), l]);

  const restaurants: QuotedRestaurant[] = [];
  for (const [restaurantId, groupLines] of byRestaurant) {
    const q = quote.restaurants.find((r) => r.restaurantId === restaurantId);
    if (!q) {
      for (const l of groupLines)
        if (!has('ITEM_UNAVAILABLE', restaurantId, l.itemId))
          problems.push({ code: 'ITEM_UNAVAILABLE', restaurantId, itemId: l.itemId, message: `${l.name} is no longer available` });
      continue;
    }
    if (!q.open && !has('RESTAURANT_CLOSED', restaurantId)) problems.push({ code: 'RESTAURANT_CLOSED', restaurantId, message: `${q.name} is closed` });
    if (!q.serviceable && !has('NOT_SERVICEABLE', restaurantId))
      problems.push({ code: 'NOT_SERVICEABLE', restaurantId, message: `${q.name} does not deliver to this address` });
    const matched = matchQuoteLines(groupLines.map((cl) => ({ lineRef: String(cl._id), itemId: cl.itemId })), q.lines);
    const lines: MappedLine[] = [];
    groupLines.forEach((cl, idx) => {
      const ql = matched[idx];
      if (!ql) {
        if (!has('ITEM_UNAVAILABLE', restaurantId, cl.itemId))
          problems.push({ code: 'ITEM_UNAVAILABLE', restaurantId, itemId: cl.itemId, message: `${cl.name} is no longer available` });
        return;
      }
      if (!ql.available && !has('ITEM_UNAVAILABLE', restaurantId, cl.itemId))
        problems.push({ code: 'ITEM_UNAVAILABLE', restaurantId, itemId: cl.itemId, message: `${ql.name} is unavailable` });
      if (!ql.stockOk && !has('OUT_OF_STOCK', restaurantId, cl.itemId))
        problems.push({ code: 'OUT_OF_STOCK', restaurantId, itemId: cl.itemId, message: `${ql.name} is out of stock` });
      lines.push({ cartLine: cl, quoteLine: ql });
    });
    if (lines.length) restaurants.push({ quote: q, lines });
  }
  return { quote, problems, restaurants };
}

function pricingInputs(restaurants: QuotedRestaurant[]): RestaurantInput[] {
  return restaurants.map((r) => ({
    restaurantId: r.quote.restaurantId,
    packagingFeePaise: r.quote.packagingFeePaise,
    deliveryFeePaise: r.quote.deliveryFeePaise,
    lines: r.lines.map((m) => ({
      itemId: m.quoteLine.itemId,
      name: m.quoteLine.name,
      unitPricePaise: m.quoteLine.unitPricePaise,
      addOns: m.quoteLine.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise })),
      quantity: m.cartLine.quantity,
    })),
  }));
}

/**
 * Server quote + coupon + membership + `priceCheckout` (LLD §8 steps 2–5) over the selected lines.
 * `strictCoupon`: an invalid coupon throws (checkout); otherwise it is reported (preview).
 */
export async function quoteAndPrice(
  ctx: OrdersContext,
  userId: string,
  cartLines: CartLine[],
  drop: LatLng,
  opts: { couponCode?: string | null; useMembership: boolean; strictCoupon: boolean },
): Promise<QuoteAndPrice> {
  const { quote, problems, restaurants } = await quoteCart(ctx, cartLines, drop);
  const inputs = pricingInputs(restaurants);
  const subtotals = inputs.map((r) => ({ restaurantId: r.restaurantId, itemsSubtotalPaise: r.lines.reduce((t, l) => t + lineTotal(l), 0) }));
  const itemsSubtotalPaise = subtotals.reduce((s, r) => s + r.itemsSubtotalPaise, 0);

  let coupon: QuoteAndPrice['coupon'] = null;
  const code = opts.couponCode ? opts.couponCode.trim().toUpperCase() : null;
  if (code) {
    try {
      const v = await ctx.clients.marketplace.validateCoupon({
        code,
        userId,
        itemsSubtotalPaise,
        restaurantSubtotals: subtotals.map((r) => ({ restaurantId: r.restaurantId, subtotalPaise: r.itemsSubtotalPaise })),
      });
      // re-check the scope locally: the discount may only use the eligible restaurants' items (pricing throws otherwise)
      const scope = couponScope(subtotals, v.restaurantIds);
      if (!scope.ok) throw couponNotApplicableError();
      coupon = {
        code: (v.code ?? code).toUpperCase(),
        valid: true,
        discountPaise: Math.min(v.discountPaise, scope.eligibleSubtotalPaise),
        restaurantIds: [...v.restaurantIds],
      };
    } catch (e) {
      if (opts.strictCoupon || !(e instanceof DomainError) || e.httpStatus >= 500) throw e;
      coupon = { code, valid: false, discountPaise: 0, restaurantIds: [], message: e.message };
    }
  }

  let membership: MembershipBenefitsResponse | null = null;
  if (opts.useMembership && inputs.length) {
    const m = await ctx.clients.marketplace.membershipBenefits({
      userId,
      children: inputs.map((r) => ({
        restaurantId: r.restaurantId,
        itemsSubtotalPaise: r.lines.reduce((t, l) => t + lineTotal(l), 0),
        deliveryFeePaise: r.deliveryFeePaise,
      })),
    });
    membership = m.membershipId ? m : null;
  }

  const priced = priceCheckout(
    inputs,
    {
      ...(coupon?.valid ? { couponCode: coupon.code } : {}),
      couponDiscountPaise: coupon?.valid ? coupon.discountPaise : 0,
      ...(coupon?.valid && coupon.restaurantIds.length ? { couponRestaurantIds: coupon.restaurantIds } : {}),
    },
    membership
      ? {
          freeDeliveryRestaurantIds: membership.freeDeliveryRestaurantIds,
          extraDiscountBps: membership.extraDiscountBps,
          extraDiscountCapPaise: membership.extraDiscountCapPaise,
        }
      : null,
    { foodTaxBps: ctx.config.FOOD_TAX_BPS, feeTaxBps: ctx.config.FEE_TAX_BPS, platformFeePaise: ctx.config.PLATFORM_FEE_PAISE },
  );
  return { quote, problems, restaurants, itemsSubtotalPaise, coupon, membership, priced };
}

/** Per-restaurant summary used by preview and PRICE_CHANGED details. */
export function pricedChildrenSummary(qp: QuoteAndPrice) {
  return qp.priced.children.map((c) => {
    const r = qp.restaurants.find((x) => x.quote.restaurantId === c.restaurantId)!;
    return {
      restaurantId: c.restaurantId,
      restaurantName: r.quote.name,
      lines: c.lines.map((l, i) => ({
        lineId: String(r.lines[i]!.cartLine._id),
        itemId: l.itemId,
        name: l.name,
        unitPricePaise: l.unitPricePaise,
        addOns: l.addOns,
        quantity: l.quantity,
        lineTotalPaise: l.lineTotalPaise,
      })),
      breakdown: c.breakdown,
      distanceKm: r.quote.distanceKm,
      etaMinutes: r.quote.etaMinutes,
      etaSource: r.quote.etaSource,
      delivery: { mode: 'SEPARATE' as const, note: DELIVERY_NOTE },
    };
  });
}

/** Refresh the cart's display snapshot from the quote (does not bump cartVersion; best-effort). */
async function refreshCartSnapshot(ctx: OrdersContext, cart: CartDoc, qp: QuoteAndPrice): Promise<void> {
  let changed = false;
  for (const r of qp.restaurants) {
    for (const m of r.lines) {
      const line = cart.items.find((l) => String(l._id) === String(m.cartLine._id));
      if (!line) continue;
      const addOns = m.quoteLine.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise }));
      const same =
        line.unitPricePaise === m.quoteLine.unitPricePaise &&
        line.name === m.quoteLine.name &&
        line.isVeg === m.quoteLine.isVeg &&
        line.restaurantName === r.quote.name &&
        JSON.stringify(line.addOns.map((a) => [a.id, a.name, a.pricePaise])) === JSON.stringify(addOns.map((a) => [a.id, a.name, a.pricePaise]));
      if (same) continue;
      Object.assign(line, { unitPricePaise: m.quoteLine.unitPricePaise, name: m.quoteLine.name, isVeg: m.quoteLine.isVeg, restaurantName: r.quote.name, addOns });
      changed = true;
    }
  }
  if (!changed) return;
  try {
    await cart.save();
  } catch (e) {
    if (!(e instanceof mongoose.Error.VersionError)) throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// address

export function resolveDropAddress(cart: CartDoc | null, body: { addressId?: string; address?: CreateCheckoutBody['address'] }): AddressSnapshot {
  if (body.address) return toAddressSnapshot(body.address, body.addressId);
  const snap = cart?.deliveryAddress;
  if (body.addressId) {
    if (!snap || snap.addressId !== body.addressId) {
      throw new DomainError('VALIDATION_FAILED', 'Unknown addressId: set it on the cart with PUT /cart/address (or send the address)', 400, {
        issues: [{ path: 'body.addressId', code: 'custom', message: 'Address not set on cart' }],
      });
    }
    return snap;
  }
  if (snap?.location) return snap;
  throw new DomainError('VALIDATION_FAILED', 'A delivery address is required', 400, {
    issues: [{ path: 'body.address', code: 'custom', message: 'Delivery address required' }],
  });
}

const dropOf = (a: AddressSnapshot): LatLng => ({ lat: a.location.coordinates[1]!, lng: a.location.coordinates[0]! });

// ---------------------------------------------------------------------------------------------
// preview

export async function previewCart(
  ctx: OrdersContext,
  userId: string,
  body: {
    address?: CreateCheckoutBody['address'];
    addressId?: string;
    couponCode?: string | null;
    useMembership?: boolean;
    restaurantIds?: string[];
  },
) {
  const cart = await findCart(ctx, { kind: 'USER', userId });
  if (!cart || !cart.items.length) throw new DomainError('CART_EMPTY', 'Your cart is empty');
  const selection = selectCartLines(cart, body.restaurantIds);
  const drop = resolveDropAddress(cart, body);
  const qp = await quoteAndPrice(ctx, userId, selection.lines, dropOf(drop), {
    couponCode: body.couponCode === undefined ? cart.couponCode : body.couponCode,
    useMembership: body.useMembership ?? false,
    strictCoupon: false,
  });
  return {
    cartVersion: cart.cartVersion,
    deliveryAddress: addressView(drop),
    pricing: qp.priced.totals,
    children: pricedChildrenSummary(qp),
    problems: qp.problems,
    canCheckout: qp.problems.length === 0 && qp.priced.children.length > 0,
    coupon: qp.coupon,
    membership: qp.membership ? { applied: true, membershipId: qp.membership.membershipId } : null,
    deliveryExplanation: qp.priced.children.length > 1 ? 'Each restaurant prepares and delivers its part of the order separately.' : null,
  };
}

// ---------------------------------------------------------------------------------------------
// checkout

export interface CheckoutResult {
  status: 200 | 201;
  body: { checkout: CheckoutView; payment: PaymentView };
}

async function loadView(ctx: OrdersContext, group: CheckoutGroup): Promise<CheckoutView> {
  const children = await ctx.models.ChildOrder.find({ checkoutGroupId: group._id }).lean<ChildOrder[]>();
  return checkoutView(group, children);
}

export async function getCheckoutView(ctx: OrdersContext, userId: string, checkoutId: string) {
  if (!Types.ObjectId.isValid(checkoutId)) throw new DomainError('NOT_FOUND', 'Checkout not found');
  const group = await ctx.models.CheckoutGroup.findOne({ _id: checkoutId, userId }).lean<CheckoutGroup>();
  if (!group) throw new DomainError('NOT_FOUND', 'Checkout not found');
  return { checkout: await loadView(ctx, group), payment: group.payment ? paymentView(group.payment) : null };
}

/** Groups written before ORD-3 have no `restaurantSetKey` and count as the whole cart. */
const setKeyFilter = (setKey: string) => (setKey === '*' ? { restaurantSetKey: { $in: ['*', null] } } : { restaurantSetKey: setKey });

const findActive = (ctx: OrdersContext, userId: string, cartVersion: number, setKey: string) =>
  ctx.models.CheckoutGroup.findOne({ userId, cartVersion, status: 'AWAITING_PAYMENT', ...setKeyFilter(setKey) });

const snapshotOf = (i: { paymentIntentId: string; provider: 'razorpay' | 'mock'; providerOrderId: string; keyId: string | null; amountPaise: number; currency: 'INR'; demoPayUrl: string | null }): PaymentSnapshot => ({
  paymentIntentId: i.paymentIntentId,
  provider: i.provider,
  providerOrderId: i.providerOrderId,
  keyId: i.keyId ?? null,
  amountPaise: i.amountPaise,
  currency: 'INR',
  demoPayUrl: i.demoPayUrl ?? null,
});

async function storePayment(ctx: OrdersContext, checkoutId: Types.ObjectId, snap: PaymentSnapshot, status: string): Promise<void> {
  await ctx.models.CheckoutGroup.updateOne(
    { _id: checkoutId },
    { $set: { payment: snap, paymentIntentId: snap.paymentIntentId, providerOrderId: snap.providerOrderId } },
  );
  // only fill the mirror while nothing newer was recorded (a fast payment.captured may already have run)
  await ctx.models.CheckoutGroup.updateOne({ _id: checkoutId, paymentStatus: 'PENDING' }, { $set: { paymentStatus: status } });
}

/** One reservation line per (restaurant, item): lines that differ only by customization share stock. */
function reservationLines(restaurants: QuotedRestaurant[]): { restaurantId: string; itemId: string; qty: number }[] {
  const byItem = new Map<string, { restaurantId: string; itemId: string; qty: number }>();
  for (const r of restaurants) {
    for (const m of r.lines) {
      const key = `${r.quote.restaurantId}|${m.cartLine.itemId}`;
      const cur = byItem.get(key);
      if (cur) cur.qty += m.cartLine.quantity;
      else byItem.set(key, { restaurantId: r.quote.restaurantId, itemId: m.cartLine.itemId, qty: m.cartLine.quantity });
    }
  }
  return [...byItem.values()];
}

/** Duplicate submit: return the active checkout (ensuring its payment intent exists — idempotent upstream). */
async function respondExisting(ctx: OrdersContext, group: CheckoutGroupDoc): Promise<CheckoutResult> {
  let snap = group.payment?.paymentIntentId ? group.payment : null;
  if (!snap) {
    let intent;
    try {
      intent = await ctx.clients.payments.createIntent({
        purpose: 'CHECKOUT',
        referenceId: String(group._id),
        userId: group.userId,
        amountPaise: group.pricing.totalPaise,
      });
    } catch (e) {
      ctx.logger.warn({ err: e, checkoutId: String(group._id) }, 'payment intent unavailable for existing checkout');
      throw new DomainError('PAYMENT_PROVIDER_UNAVAILABLE', 'Payment provider unavailable, please retry', 502);
    }
    snap = snapshotOf(intent);
    await storePayment(ctx, group._id, snap, intent.status);
  }
  const fresh = (await ctx.models.CheckoutGroup.findById(group._id).lean<CheckoutGroup>()) ?? group.toObject();
  return { status: 200, body: { checkout: await loadView(ctx, fresh), payment: paymentView(snap) } };
}

const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryLock(ctx: OrdersContext, key: string, token: string): Promise<boolean | null> {
  try {
    return (await ctx.redis.set(redisKey(ctx.redis, key), token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  } catch (err) {
    ctx.logger.warn({ err }, 'checkout lock unavailable; relying on the unique index');
    return null;
  }
}
const UNLOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
async function unlock(ctx: OrdersContext, key: string, token: string): Promise<void> {
  try {
    await ctx.redis.eval(UNLOCK_LUA, 1, redisKey(ctx.redis, key), token);
  } catch {
    /* lock expires on its own */
  }
}

export async function createCheckout(
  ctx: OrdersContext,
  input: { userId: string; body: CreateCheckoutBody; idempotencyKey: string | null },
): Promise<CheckoutResult> {
  const { userId, body } = input;
  const cart = await findCart(ctx, { kind: 'USER', userId });
  if (!cart || !cart.items.length) throw new DomainError('CART_EMPTY', 'Your cart is empty');
  const selection = selectCartLines(cart, body.restaurantIds);
  const { setKey } = selection;
  const dropAddress = resolveDropAddress(cart, body);

  const existing = await findActive(ctx, userId, cart.cartVersion, setKey);
  if (existing) return respondExisting(ctx, existing);

  const lockKey = `checkout-lock:${userId}:${cart.cartVersion}:${setKey}`;
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const got = await tryLock(ctx, lockKey, token);
    if (got !== false) break; // acquired, or Redis unavailable (unique index still protects)
    const active = await findActive(ctx, userId, cart.cartVersion, setKey);
    if (active) return respondExisting(ctx, active);
    if (Date.now() > deadline) throw new DomainError('IDEMPOTENCY_IN_PROGRESS', 'A checkout for this cart is already in progress');
    await sleep(100);
  }
  try {
    const active = await findActive(ctx, userId, cart.cartVersion, setKey);
    if (active) return respondExisting(ctx, active);
    return await runSaga(ctx, { userId, body, idempotencyKey: input.idempotencyKey, cart, selection, dropAddress });
  } finally {
    await unlock(ctx, lockKey, token);
  }
}

interface SagaInput {
  userId: string;
  body: CreateCheckoutBody;
  idempotencyKey: string | null;
  cart: CartDoc;
  selection: CartSelection;
  dropAddress: AddressSnapshot;
}

async function runSaga(ctx: OrdersContext, s: SagaInput): Promise<CheckoutResult> {
  const { userId, body, cart, selection, dropAddress } = s;
  const couponCode = body.couponCode ?? cart.couponCode ?? null;

  // 2–5: quote, coupon, membership, pricing (+ customer contact in parallel)
  const [qpRes, userRes] = await Promise.allSettled([
    quoteAndPrice(ctx, userId, selection.lines, dropOf(dropAddress), { couponCode, useMembership: body.useMembership, strictCoupon: true }),
    ctx.clients.identity.getUser(userId),
  ]);
  if (qpRes.status === 'rejected') throw qpRes.reason;
  const qp = qpRes.value;
  const code = primaryProblemCode(qp.problems, CHECKOUT_PROBLEM_PRIORITY);
  if (code) throw problemError(code, qp.problems);
  let user: InternalUser | null = null;
  if (userRes.status === 'fulfilled') user = userRes.value;
  else ctx.logger.warn({ err: userRes.reason, userId }, 'identity lookup failed; continuing without customer contact');

  // 3: refresh display snapshot; client confirmation of a changed total
  await refreshCartSnapshot(ctx, cart, qp);
  const totals = qp.priced.totals;
  if (body.expectedTotalPaise !== undefined && body.expectedTotalPaise !== totals.totalPaise) {
    throw new DomainError('PRICE_CHANGED', 'Prices changed since you last saw them; please review the new total', 422, {
      expectedTotalPaise: body.expectedTotalPaise,
      pricing: totals,
      children: pricedChildrenSummary(qp),
    });
  }

  // restaurant snapshots (address, phone, commission) for Task 12 / delivery / ledger
  const restaurantInfo = new Map<string, InternalRestaurant>();
  await Promise.all(
    qp.restaurants.map(async (r) => {
      const info = await ctx.clients.marketplace.getRestaurant(r.quote.restaurantId);
      if (!info) {
        throw problemError('RESTAURANT_CLOSED', [{ code: 'RESTAURANT_CLOSED', restaurantId: r.quote.restaurantId, message: `${r.quote.name} is unavailable` }]);
      }
      restaurantInfo.set(r.quote.restaurantId, info);
    }),
  );

  // 6: reserve stock / coupon / membership under a pre-generated checkout id
  const checkoutId = new Types.ObjectId();
  const childIds = new Map(qp.priced.children.map((c) => [c.restaurantId, new Types.ObjectId()]));
  const membershipHold =
    qp.membership?.membershipId && (totals.membershipDiscountPaise > 0 || totals.deliveryDiscountPaise > 0)
      ? {
          membershipId: qp.membership.membershipId,
          freeDeliveries: qp.priced.children.filter((c) => c.breakdown.deliveryDiscountPaise > 0).length,
          discountPaise: totals.membershipDiscountPaise,
        }
      : undefined;
  const appliedCoupon = qp.coupon?.valid && totals.couponDiscountPaise > 0 ? qp.coupon.code : undefined;
  try {
    await ctx.clients.marketplace.reserve({
      checkoutId: String(checkoutId),
      userId,
      lines: reservationLines(qp.restaurants),
      ...(appliedCoupon ? { couponCode: appliedCoupon } : {}),
      couponDiscountPaise: totals.couponDiscountPaise,
      ...(membershipHold ? { membership: membershipHold } : {}),
      ttlSec: ctx.config.CHECKOUT_TTL_SEC,
    });
  } catch (e) {
    const definitive = e instanceof DomainError && e.httpStatus >= 400 && e.httpStatus < 500;
    if (!definitive) {
      // ambiguous (timeout / 5xx): the hold may exist — ask marketplace to release it
      await withTransaction(ctx.conn, (session) => releaseOrphanReservation(ctx, session, String(checkoutId))).catch((err) =>
        ctx.logger.error({ err, checkoutId: String(checkoutId) }, 'could not enqueue release for ambiguous reservation'),
      );
    }
    throw e;
  }

  // 7: persist checkout + children + outbox in one transaction
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ctx.config.CHECKOUT_TTL_SEC * 1000);
  const customerContact = { name: user?.name ?? 'Customer', phoneMasked: maskPhone(user?.phone) };
  const isDemo = ctx.config.APP_MODE === 'demo';

  let group: CheckoutGroupDoc | null = null;
  // Once reserve succeeded, every failure to persist must hand the hold back (best effort; the
  // marketplace sweeper's 404 from /internal/checkouts/:id/status is the second safety net).
  let holdReleased = false;
  const releaseHold = async () => {
    if (holdReleased) return;
    holdReleased = true;
    try {
      await withTransaction(ctx.conn, (session) => releaseOrphanReservation(ctx, session, String(checkoutId)));
    } catch (err) {
      ctx.logger.error({ err, checkoutId: String(checkoutId) }, 'could not enqueue reservation release after failed checkout persist');
    }
  };
  try {
    for (let attempt = 0; attempt < 3 && !group; attempt++) {
      try {
        group = await withTransaction(ctx.conn, async (session) => {
          const childDocs = qp.priced.children.map((pc) => {
            const r = qp.restaurants.find((x) => x.quote.restaurantId === pc.restaurantId)!;
            const info = restaurantInfo.get(pc.restaurantId)!;
            return {
              _id: childIds.get(pc.restaurantId)!,
              code: orderCode(),
              checkoutGroupId: checkoutId,
              userId,
              restaurantId: pc.restaurantId,
              restaurantOwnerId: r.quote.ownerUserId,
              restaurantName: r.quote.name,
              restaurantLocation: { type: 'Point' as const, coordinates: [r.quote.location.lng, r.quote.location.lat] as [number, number] },
              restaurantAddress: { line1: info.address.line1, ...(info.address.line2 ? { line2: info.address.line2 } : {}), city: info.address.city, pincode: info.address.pincode },
              restaurantPhone: info.phone ?? null,
              commissionBps: info.commissionBps,
              avgPrepMinutes: info.avgPrepMinutes,
              lines: pc.lines.map((pl, i) => {
                const cl = r.lines[i]!.cartLine;
                return {
                  cartLineId: String(cl._id),
                  lineKey: cl.lineKey,
                  itemId: pl.itemId,
                  name: pl.name,
                  isVeg: r.lines[i]!.quoteLine.isVeg,
                  unitPricePaise: pl.unitPricePaise,
                  addOns: pl.addOns,
                  selections: cl.selections.map((x) => ({ groupId: x.groupId, optionIds: [...x.optionIds] })),
                  quantity: pl.quantity,
                  note: cl.note ?? null,
                  lineTotalPaise: pl.lineTotalPaise,
                };
              }),
              breakdown: pc.breakdown,
              status: 'AWAITING_PAYMENT' as const,
              statusHistory: [{ from: null, to: 'AWAITING_PAYMENT' as const, actor: 'CUSTOMER', actorId: userId, reason: 'checkout created', at: now }],
              refundStatus: 'NONE' as const,
              refundedPaise: 0,
              ...handoverCodePair(),
              customerContact,
              dropAddress,
              distanceKm: r.quote.distanceKm,
              etaMinutes: r.quote.etaMinutes,
              etaSource: r.quote.etaSource,
              isDemo,
            };
          });
          const [g] = await ctx.models.CheckoutGroup.create(
            [
              {
                _id: checkoutId,
                code: orderCode(),
                userId,
                cartId: cart._id,
                cartVersion: cart.cartVersion,
                restaurantSetKey: selection.setKey,
                status: 'AWAITING_PAYMENT',
                deliveryAddress: dropAddress,
                childOrderIds: childDocs.map((c) => c._id),
                pricing: totals,
                couponCode: appliedCoupon ?? null,
                membershipId: membershipHold?.membershipId ?? null,
                paymentStatus: 'PENDING',
                expiresAt,
                statusHistory: [{ from: null, to: 'AWAITING_PAYMENT', actor: 'CUSTOMER', actorId: userId, reason: 'checkout created', at: now }],
                idempotencyKey: s.idempotencyKey,
                isDemo,
              },
            ],
            { session },
          );
          await ctx.models.ChildOrder.create(childDocs, { session, ordered: true });
          await ctx.models.Cart.updateOne({ _id: cart._id }, { $set: { checkedOutVersion: cart.cartVersion } }, { session });
          await emitOrdersEvent(ctx, session, 'checkout.created', {
            checkoutId: String(checkoutId),
            userId,
            totalPaise: totals.totalPaise,
            childOrderIds: childDocs.map((c) => String(c._id)),
          }, String(checkoutId));
          await appendOrderEvents(ctx.conn, session, [
            { checkoutGroupId: checkoutId, type: 'checkout.created', actor: 'CUSTOMER', actorId: userId, data: { totalPaise: totals.totalPaise }, at: now },
          ]);
          for (const c of childDocs) {
            queueOrderUpdated(session, ctx.redis, ctx.logger, userId, {
              checkoutId: String(checkoutId),
              childOrderId: String(c._id),
              status: c.status,
              checkoutStatus: 'AWAITING_PAYMENT',
              refundStatus: 'NONE',
              deliveryStatus: null,
            });
          }
          return g!;
        });
      } catch (e) {
        const dup = e as { code?: number; keyPattern?: Record<string, unknown>; message?: string };
        if (dup.code !== 11000) throw e;
        const key = dup.keyPattern ?? {};
        if ('cartVersion' in key || /uniq_active_checkout_per_cart_version/.test(dup.message ?? '')) {
          // lost a double-submit race past the lock: release our hold and return the winner
          await releaseHold();
          const winner = await findActive(ctx, userId, cart.cartVersion, selection.setKey);
          if (winner) return respondExisting(ctx, winner);
          throw new DomainError('CONFLICT', 'Checkout conflict, please retry');
        }
        if ('code' in key && attempt < 2) continue; // order-code collision: regenerate
        throw e;
      }
    }
    if (!group) throw new DomainError('INTERNAL_ERROR', 'Could not create checkout');
  } catch (e) {
    await releaseHold();
    throw e;
  }

  // 8: payment intent
  let intent;
  try {
    intent = await ctx.clients.payments.createIntent({ purpose: 'CHECKOUT', referenceId: String(checkoutId), userId, amountPaise: totals.totalPaise });
  } catch (e) {
    ctx.logger.error({ err: e, checkoutId: String(checkoutId) }, 'payment intent creation failed; releasing checkout');
    await withTransaction(ctx.conn, async (session) => {
      const g = await ctx.models.CheckoutGroup.findById(checkoutId).session(session);
      if (g) await releaseCheckout(ctx, session, g, 'PAYMENT_FAILED', { detail: 'payment provider unavailable', paymentStatus: 'UNAVAILABLE' });
    });
    throw new DomainError('PAYMENT_PROVIDER_UNAVAILABLE', 'Payment provider unavailable, please retry', 502);
  }
  const snap = snapshotOf(intent);
  await storePayment(ctx, checkoutId, snap, intent.status);

  // 9
  const fresh = (await ctx.models.CheckoutGroup.findById(checkoutId).lean<CheckoutGroup>())!;
  return { status: 201, body: { checkout: await loadView(ctx, fresh), payment: paymentView(snap) } };
}

