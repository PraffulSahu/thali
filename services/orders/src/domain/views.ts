/** Customer-facing views of checkouts and child orders (CheckoutView in the Task 11 brief). */
import type { CheckoutGroup, PaymentSnapshot } from '../models/checkout-group.js';
import type { ChildOrder } from '../models/child-order.js';
import { plainBreakdown } from '../models/common.js';
import { addressView, DELIVERY_EXPLANATION, DELIVERY_NOTE } from './cart.js';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function childOrderView(c: ChildOrder) {
  return {
    id: String(c._id),
    code: c.code,
    restaurantId: c.restaurantId,
    restaurantName: c.restaurantName,
    status: c.status,
    lines: c.lines.map((l) => ({
      itemId: l.itemId,
      name: l.name,
      isVeg: l.isVeg,
      unitPricePaise: l.unitPricePaise,
      addOns: l.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise })),
      selections: l.selections.map((s) => ({ groupId: s.groupId, optionIds: [...s.optionIds] })),
      quantity: l.quantity,
      note: l.note ?? null,
      lineTotalPaise: l.lineTotalPaise,
    })),
    breakdown: plainBreakdown(c.breakdown),
    acceptBy: iso(c.acceptBy),
    placedAt: iso(c.placedAt),
    /** Shown to the customer; the partner enters it at drop-off. */
    deliveryCode: c.deliveryCode,
    refundStatus: c.refundStatus,
    refundedPaise: c.refundedPaise ?? 0,
    deliveryStatus: c.deliveryStatus ?? null,
    eta: { distanceKm: c.distanceKm ?? null, etaMinutes: c.etaMinutes ?? null, etaSource: c.etaSource ?? null },
    delivery: { mode: 'SEPARATE' as const, note: DELIVERY_NOTE },
  };
}
export type ChildOrderView = ReturnType<typeof childOrderView>;

export function checkoutView(g: CheckoutGroup, children: ChildOrder[]) {
  const sorted = [...children].sort((a, b) => (a.restaurantId < b.restaurantId ? -1 : a.restaurantId > b.restaurantId ? 1 : 0));
  return {
    id: String(g._id),
    code: g.code,
    status: g.status,
    cartVersion: g.cartVersion,
    createdAt: iso(g.createdAt),
    expiresAt: iso(g.expiresAt),
    placedAt: iso(g.placedAt),
    deliveryAddress: addressView(g.deliveryAddress),
    pricing: plainBreakdown(g.pricing),
    couponCode: g.couponCode ?? null,
    membershipId: g.membershipId ?? null,
    paymentIntentId: g.paymentIntentId ?? null,
    paymentStatus: g.paymentStatus,
    isDemo: g.isDemo,
    deliveryExplanation: sorted.length > 1 ? DELIVERY_EXPLANATION : null,
    children: sorted.map(childOrderView),
  };
}
export type CheckoutView = ReturnType<typeof checkoutView>;

export function paymentView(p: PaymentSnapshot) {
  return {
    intentId: p.paymentIntentId,
    provider: p.provider,
    providerOrderId: p.providerOrderId,
    keyId: p.keyId ?? null,
    amountPaise: p.amountPaise,
    currency: p.currency ?? 'INR',
    demoPayUrl: p.demoPayUrl ?? null,
  };
}
export type PaymentView = ReturnType<typeof paymentView>;
