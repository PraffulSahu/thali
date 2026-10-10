import { allocateProRata, assertNonNegativeInt } from './allocate.js';
import { couponNotApplicableError, couponScope } from './coupon-scope.js';
import type {
  Breakdown,
  GroupDiscountInput,
  LineInput,
  MembershipBenefitInput,
  PricedChild,
  PricedCheckout,
  PricingConfig,
  RestaurantInput,
} from './types.js';

/** (unitPrice + sum(addOn prices)) * quantity. */
export function lineTotal(l: LineInput): number {
  assertNonNegativeInt(l.unitPricePaise, `unitPricePaise[${l.itemId}]`);
  if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) {
    throw new RangeError(`quantity[${l.itemId}] must be a positive integer (got ${String(l.quantity)})`);
  }
  let unit = l.unitPricePaise;
  for (const a of l.addOns) {
    assertNonNegativeInt(a.pricePaise, `addOn.pricePaise[${a.id}]`);
    unit += a.pricePaise;
  }
  return unit * l.quantity;
}

/** roundHalfUp(amount * bps / 10000) in pure integer arithmetic (LLD §1.1). */
function bpsOf(amountPaise: number, bps: number): number {
  return Math.floor((amountPaise * bps + 5000) / 10000);
}

const ZERO: Breakdown = {
  itemsSubtotalPaise: 0,
  couponDiscountPaise: 0,
  membershipDiscountPaise: 0,
  packagingFeePaise: 0,
  deliveryFeePaise: 0,
  deliveryDiscountPaise: 0,
  platformFeePaise: 0,
  foodTaxPaise: 0,
  feeTaxPaise: 0,
  totalPaise: 0,
};

/**
 * Pure, deterministic multi-restaurant pricing (LLD §6). Children are sorted by
 * restaurantId ascending; group totals are the component-wise sum of children.
 * Throws RangeError on non-integer/negative money, duplicate restaurant ids, or a coupon
 * exceeding the eligible items subtotal (marketplace caps it; pricing asserts).
 * Scoped coupon (`d.couponRestaurantIds` non-empty): allocated only across eligible children;
 * no eligible child → DomainError `COUPON_INVALID { reason: 'NOT_APPLICABLE' }`.
 */
export function priceCheckout(
  rs: RestaurantInput[],
  d: GroupDiscountInput,
  m: MembershipBenefitInput | null,
  c: PricingConfig,
): PricedCheckout {
  assertNonNegativeInt(c.foodTaxBps, 'foodTaxBps');
  assertNonNegativeInt(c.feeTaxBps, 'feeTaxBps');
  assertNonNegativeInt(c.platformFeePaise, 'platformFeePaise');
  assertNonNegativeInt(d.couponDiscountPaise, 'couponDiscountPaise');
  if (m) {
    assertNonNegativeInt(m.extraDiscountBps, 'extraDiscountBps');
    assertNonNegativeInt(m.extraDiscountCapPaise, 'extraDiscountCapPaise');
  }

  const sorted = [...rs].sort((a, b) => (a.restaurantId < b.restaurantId ? -1 : a.restaurantId > b.restaurantId ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.restaurantId === sorted[i - 1]!.restaurantId) {
      throw new RangeError(`duplicate restaurantId: ${sorted[i]!.restaurantId}`);
    }
  }

  // Step 1: line totals and per-restaurant items subtotal.
  const priced = sorted.map((r) => {
    assertNonNegativeInt(r.packagingFeePaise, `packagingFeePaise[${r.restaurantId}]`);
    assertNonNegativeInt(r.deliveryFeePaise, `deliveryFeePaise[${r.restaurantId}]`);
    const lines = r.lines.map((l) => ({ ...l, addOns: l.addOns.map((a) => ({ ...a })), lineTotalPaise: lineTotal(l) }));
    const subtotal = lines.reduce((acc, l) => acc + l.lineTotalPaise, 0);
    return { r, lines, subtotal };
  });

  // Step 2: coupon pro-rata by itemsSubtotal, across the eligible children only (MKT-8).
  const scoped = !!d.couponRestaurantIds && d.couponRestaurantIds.length > 0;
  const sc = couponScope(priced.map((p) => ({ restaurantId: p.r.restaurantId, itemsSubtotalPaise: p.subtotal })), d.couponRestaurantIds);
  if (!sc.ok) throw couponNotApplicableError();
  const eligibleIds = new Set(sc.eligibleRestaurantIds);
  const eligible = priced.filter((p) => eligibleIds.has(p.r.restaurantId));
  const eligibleSubtotal = sc.eligibleSubtotalPaise;
  if (d.couponDiscountPaise > eligibleSubtotal) {
    throw new RangeError(`couponDiscountPaise (${d.couponDiscountPaise}) exceeds ${scoped ? 'eligible ' : ''}items subtotal (${eligibleSubtotal})`);
  }

  const couponAlloc: Record<string, number> = Object.fromEntries(priced.map((p) => [p.r.restaurantId, 0]));
  if (eligible.length > 0) {
    Object.assign(couponAlloc, allocateProRata(d.couponDiscountPaise, eligible.map((p) => ({ key: p.r.restaurantId, weight: p.subtotal }))));
  }

  // Step 3: membership extra discount, pro-rata by (subtotal - couponAlloc).
  const net = priced.map((p) => ({ key: p.r.restaurantId, weight: p.subtotal - couponAlloc[p.r.restaurantId]! }));
  const netSum = net.reduce((acc, n) => acc + n.weight, 0);
  const memberDiscount = m ? Math.min(m.extraDiscountCapPaise, Math.floor((netSum * m.extraDiscountBps) / 10000)) : 0;
  const memberAlloc = priced.length === 0 ? {} : allocateProRata(memberDiscount, net);

  const free = new Set(m?.freeDeliveryRestaurantIds ?? []);

  const children: PricedChild[] = priced.map((p) => {
    const id = p.r.restaurantId;
    const coupon = couponAlloc[id]!;
    const member = memberAlloc[id]!;
    const deliveryFee = p.r.deliveryFeePaise; // step 4
    const deliveryDiscount = free.has(id) ? deliveryFee : 0;
    const packaging = p.r.packagingFeePaise; // step 5
    const platform = c.platformFeePaise;
    const foodTaxable = p.subtotal - coupon - member + packaging; // step 6
    const foodTax = bpsOf(foodTaxable, c.foodTaxBps);
    const feeTaxable = deliveryFee - deliveryDiscount + platform; // step 7
    const feeTax = bpsOf(feeTaxable, c.feeTaxBps);
    const total = p.subtotal - coupon - member + packaging + deliveryFee - deliveryDiscount + platform + foodTax + feeTax; // step 8
    return {
      restaurantId: id,
      lines: p.lines,
      breakdown: {
        itemsSubtotalPaise: p.subtotal,
        couponDiscountPaise: coupon,
        membershipDiscountPaise: member,
        packagingFeePaise: packaging,
        deliveryFeePaise: deliveryFee,
        deliveryDiscountPaise: deliveryDiscount,
        platformFeePaise: platform,
        foodTaxPaise: foodTax,
        feeTaxPaise: feeTax,
        totalPaise: total,
      },
    };
  });

  // Step 9: totals = component-wise sum of children.
  const totals = children.reduce<Breakdown>((acc, ch) => {
    const out = { ...acc };
    for (const k of Object.keys(out) as (keyof Breakdown)[]) out[k] += ch.breakdown[k];
    return out;
  }, { ...ZERO });

  return { children, totals };
}
