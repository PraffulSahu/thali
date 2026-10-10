/**
 * Role-specific child / checkout views for Task 12 routes. What each role sees:
 *  - restaurant owner: their order, customer name + masked phone, the PICKUP code (never the
 *    customer's delivery code or full drop address), next allowed actions.
 *  - customer: Task 11 checkout view + lifecycle fields, explanations, adjusted totals.
 *  - admin: everything incl. both handover codes and the timeline.
 */
import { canTransition, childOrderTransitions, type ChildOrderStatus } from '@thali/contracts';
import type { CheckoutGroup } from '../models/checkout-group.js';
import type { ChildOrder } from '../models/child-order.js';
import { plainBreakdown } from '../models/common.js';
import type { OrderEvent } from '../models/order-event.js';
import { addressView } from './cart.js';
import { adjustedTotals, explanations } from './derive.js';
import { checkoutView, childOrderView } from './views.js';

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

const RESTAURANT_TARGETS: ChildOrderStatus[] = ['ACCEPTED', 'REJECTED', 'PREPARING', 'READY_FOR_PICKUP'];

function lineViews(c: ChildOrder) {
  return childOrderView(c).lines;
}

function historyView(c: ChildOrder, withActorId: boolean) {
  return (c.statusHistory ?? []).map((h) => ({
    from: h.from ?? null,
    to: h.to,
    actor: h.actor,
    ...(withActorId ? { actorId: h.actorId ?? null } : {}),
    reason: h.reason ?? null,
    at: iso(h.at),
  }));
}

function timestamps(c: ChildOrder) {
  return {
    placedAt: iso(c.placedAt),
    acceptedAt: iso(c.acceptedAt),
    readyAt: iso(c.readyAt),
    pickedUpAt: iso(c.pickedUpAt),
    deliveredAt: iso(c.deliveredAt),
    cancelledAt: iso(c.cancelledAt),
  };
}

function partnerView(c: ChildOrder) {
  if (!c.partner) return null;
  return { name: (c.partner.name ?? '').split(/\s+/)[0] ?? '', vehicleType: c.partner.vehicle?.type ?? null };
}

/** Next statuses the restaurant may move this child to (UI buttons; the backend re-checks). */
export function restaurantActions(c: Pick<ChildOrder, 'status' | 'acceptBy'>, now = Date.now()): ChildOrderStatus[] {
  const expired = c.status === 'PLACED' && c.acceptBy != null && new Date(c.acceptBy).getTime() < now;
  if (expired) return [];
  return RESTAURANT_TARGETS.filter((to) => canTransition(childOrderTransitions, c.status, to, 'RESTAURANT'));
}

export function ownerOrderView(c: ChildOrder) {
  return {
    id: String(c._id),
    code: c.code,
    restaurantId: c.restaurantId,
    restaurantName: c.restaurantName,
    status: c.status,
    lines: lineViews(c),
    breakdown: plainBreakdown(c.breakdown),
    customer: { name: c.customerContact?.name ?? '', phoneMasked: c.customerContact?.phoneMasked ?? '' },
    /** Give this to the delivery partner at pickup. */
    pickupCode: c.pickupCode,
    acceptBy: iso(c.acceptBy),
    prepMinutes: c.prepMinutes ?? null,
    readyEta: iso(c.readyEta),
    rejectionReason: c.rejectionReason ?? null,
    cancellationReason: c.cancellationReason ?? null,
    refundStatus: c.refundStatus,
    deliveryStatus: c.deliveryStatus ?? null,
    partner: partnerView(c),
    allowedTransitions: restaurantActions(c),
    statusHistory: historyView(c, false),
    ...timestamps(c),
    createdAt: iso(c.createdAt),
  };
}
export type OwnerOrderView = ReturnType<typeof ownerOrderView>;

/**
 * ORD-4: restaurant point for the customer's tracking map (origin dot) from the placement snapshot.
 * Public facts only (where the food comes from) — never the restaurant phone.
 */
export function restaurantPointView(c: Pick<ChildOrder, 'restaurantLocation' | 'restaurantAddress'>) {
  const coords = c.restaurantLocation?.coordinates;
  return {
    location: coords ? { lat: Number(coords[1]), lng: Number(coords[0]) } : null,
    address: {
      line1: c.restaurantAddress?.line1 ?? '',
      locality: c.restaurantAddress?.locality ?? null,
      city: c.restaurantAddress?.city ?? '',
    },
  };
}

/** Customer child view = Task 11 `childOrderView` + lifecycle details. */
export function customerChildView(c: ChildOrder) {
  return {
    ...childOrderView(c),
    restaurant: restaurantPointView(c),
    prepMinutes: c.prepMinutes ?? null,
    readyEta: iso(c.readyEta),
    rejectionReason: c.rejectionReason ?? null,
    cancellationReason: c.cancellationReason ?? null,
    refundRequestedPaise: c.refundRequestedPaise ?? 0,
    partner: partnerView(c),
    canCancel: canTransition(childOrderTransitions, c.status, 'CANCELLED', 'CUSTOMER'),
    statusHistory: historyView(c, false),
    ...timestamps(c),
  };
}

export function customerOrderDetail(g: CheckoutGroup, children: ChildOrder[]) {
  const base = checkoutView(g, children);
  const byId = new Map(children.map((c) => [String(c._id), c]));
  return {
    checkout: { ...base, children: base.children.map((v) => customerChildView(byId.get(v.id)!)) },
    explanations: explanations(sortByRestaurant(children)),
    adjustedTotals: adjustedTotals(g, children),
  };
}

export function orderSummary(g: CheckoutGroup, children: ChildOrder[]) {
  const sorted = sortByRestaurant(children);
  return {
    id: String(g._id),
    code: g.code,
    status: g.status,
    createdAt: iso(g.createdAt),
    placedAt: iso(g.placedAt),
    totalPaise: g.pricing.totalPaise,
    adjustedTotals: adjustedTotals(g, children),
    children: sorted.map((c) => ({
      id: String(c._id),
      code: c.code,
      restaurantId: c.restaurantId,
      restaurantName: c.restaurantName,
      status: c.status,
      itemCount: c.lines.reduce((s, l) => s + l.quantity, 0),
      totalPaise: c.breakdown.totalPaise,
      refundStatus: c.refundStatus,
    })),
  };
}

export function adminChildRow(c: ChildOrder) {
  return {
    id: String(c._id),
    code: c.code,
    checkoutId: String(c.checkoutGroupId),
    userId: c.userId,
    customer: { name: c.customerContact?.name ?? '', phoneMasked: c.customerContact?.phoneMasked ?? '' },
    restaurantId: c.restaurantId,
    restaurantName: c.restaurantName,
    status: c.status,
    totalPaise: c.breakdown.totalPaise,
    refundStatus: c.refundStatus,
    refundedPaise: c.refundedPaise ?? 0,
    deliveryStatus: c.deliveryStatus ?? null,
    acceptBy: iso(c.acceptBy),
    createdAt: iso(c.createdAt),
  };
}

export function adminChildView(c: ChildOrder) {
  return {
    ...customerChildView(c),
    userId: c.userId,
    restaurantOwnerId: c.restaurantOwnerId,
    customer: { name: c.customerContact?.name ?? '', phoneMasked: c.customerContact?.phoneMasked ?? '' },
    dropAddress: addressView(c.dropAddress),
    pickupCode: c.pickupCode,
    commissionBps: c.commissionBps,
    deliveryJobId: c.deliveryJobId ?? null,
    deliveryDistanceKm: c.deliveryDistanceKm ?? null,
    deliveryFailureReason: c.deliveryFailureReason ?? null,
    partner: c.partner
      ? { partnerId: c.partner.partnerId, partnerUserId: c.partner.partnerUserId, name: c.partner.name, vehicle: { ...c.partner.vehicle } }
      : null,
    refunds: (c.refunds ?? []).map((r) => ({ refundId: r.refundId, amountPaise: r.amountPaise, reason: r.reason, status: r.status, updatedAt: iso(r.updatedAt) })),
    statusHistory: historyView(c, true),
  };
}

export function adminOrderDetail(g: CheckoutGroup, children: ChildOrder[], events: OrderEvent[]) {
  const base = checkoutView(g, children);
  const byId = new Map(children.map((c) => [String(c._id), c]));
  return {
    checkout: {
      ...base,
      userId: g.userId,
      statusHistory: (g.statusHistory ?? []).map((h) => ({ from: h.from ?? null, to: h.to, actor: h.actor, reason: h.reason ?? null, at: iso(h.at) })),
      children: base.children.map((v) => adminChildView(byId.get(v.id)!)),
    },
    explanations: explanations(sortByRestaurant(children)),
    adjustedTotals: adjustedTotals(g, children),
    timeline: events.map((e) => ({
      id: String(e._id),
      type: e.type,
      childOrderId: e.childOrderId ? String(e.childOrderId) : null,
      actor: e.actor,
      actorId: e.actorId ?? null,
      data: e.data ?? {},
      at: iso(e.at),
    })),
  };
}

function sortByRestaurant<T extends Pick<ChildOrder, 'restaurantId'>>(children: T[]): T[] {
  return [...children].sort((a, b) => (a.restaurantId < b.restaurantId ? -1 : a.restaurantId > b.restaurantId ? 1 : 0));
}
