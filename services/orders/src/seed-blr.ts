/**
 * Orders slice of the Bengaluru dataset (`@thali/contracts/seed-blr`), bulk + idempotent:
 *  - `restaurant_projection` for every generated restaurant
 *  - ~5,000 checkout groups + ~6,000 child orders over the past 60 days, priced with `@thali/pricing` against
 *    the generated menus (same amounts as the payments ledger / refunds and the delivery jobs): terminal states
 *    only (DELIVERED with partner + timestamps, REJECTED / CANCELLED with a SUCCEEDED refund), customer contact
 *    with `phoneLast4`, `locality` in both address snapshots, coupon / Thali Plus discounts
 *  - the admin timeline (`order_events`) and ~60 support tickets (some OPEN / IN_PROGRESS for the admin badge)
 */
import type { Connection } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import { blrMaskPhone, type BlrCheckout, type BlrChild, type BlrWorld } from '@thali/contracts/seed-blr';
import { ensureDocsBulk, type SeedReport } from '@thali/service-kit/seed';
import { lineKeyOf } from './domain/cart.js';
import { getModels } from './models/index.js';

const ADMIN = seedId('user:admin');
const pt = (p: { lat: number; lng: number }) => ({ type: 'Point' as const, coordinates: [p.lng, p.lat] });
type Hist = { from: string | null; to: string; actor: string; actorId: string | null; reason: string | null; at: Date };
const hist = (from: string | null, to: string, actor: string, at: Date, actorId: string | null = null, reason: string | null = null): Hist => ({ from, to, actor, actorId, reason, at });

const contact = (co: BlrCheckout) => ({ name: co.consumer.name, phoneMasked: blrMaskPhone(co.consumer.phone), phoneLast4: co.consumer.phone.slice(-4) });
const dropAddress = (co: BlrCheckout) => ({
  addressId: co.address.id,
  label: co.address.label,
  line1: co.address.line1,
  ...(co.address.line2 ? { line2: co.address.line2 } : {}),
  locality: co.address.locality,
  city: co.address.city,
  pincode: co.address.pincode,
  location: pt(co.address.location),
});

function childHistory(co: BlrCheckout, ch: BlrChild): Hist[] {
  const t = ch.timeline;
  const owner = ch.restaurant.ownerUserId;
  const h = [hist(null, 'AWAITING_PAYMENT', 'CUSTOMER', t.createdAt, co.consumer.id, 'checkout created'), hist('AWAITING_PAYMENT', 'PLACED', 'SYSTEM', t.placedAt, null, 'payment captured')];
  if (ch.outcome.kind === 'DELIVERED') {
    h.push(
      hist('PLACED', 'ACCEPTED', 'RESTAURANT', t.acceptedAt!, owner),
      hist('ACCEPTED', 'PREPARING', 'RESTAURANT', t.preparingAt!, owner),
      hist('PREPARING', 'READY_FOR_PICKUP', 'RESTAURANT', t.readyAt!, owner),
      hist('READY_FOR_PICKUP', 'PICKED_UP', 'SYSTEM', t.pickedUpAt!, null, 'delivery.picked_up'),
      hist('PICKED_UP', 'OUT_FOR_DELIVERY', 'SYSTEM', t.outForDeliveryAt!, null, 'delivery.started'),
      hist('OUT_FOR_DELIVERY', 'DELIVERED', 'SYSTEM', t.deliveredAt!, null, 'delivery.delivered'),
    );
  } else if (ch.outcome.kind === 'REJECTED') h.push(hist('PLACED', 'REJECTED', 'RESTAURANT', t.rejectedAt!, owner, ch.outcome.reason));
  else h.push(hist('PLACED', 'CANCELLED', 'CUSTOMER', t.cancelledAt!, co.consumer.id, ch.outcome.reason));
  return h;
}

function childDoc(co: BlrCheckout, ch: BlrChild) {
  const r = ch.restaurant;
  const t = ch.timeline;
  let extra: Record<string, unknown>;
  if (ch.outcome.kind === 'DELIVERED') {
    const p = ch.partner!;
    extra = {
      status: 'DELIVERED',
      prepMinutes: ch.prepMinutes,
      readyEta: new Date(t.acceptedAt!.getTime() + ch.prepMinutes * 60_000),
      acceptedAt: t.acceptedAt,
      readyAt: t.readyAt,
      pickedUpAt: t.pickedUpAt,
      deliveredAt: t.deliveredAt,
      deliveryJobId: seedId(`blr:delivery-job:${co.n}:${ch.c}`),
      deliveryStatus: 'DELIVERED',
      partner: { partnerId: p.partnerId, partnerUserId: p.id, name: p.name, vehicle: p.vehicle },
      deliveryDistanceKm: ch.distanceKm,
      deliveryUpdatedAt: t.deliveredAt,
      updatedAt: t.deliveredAt,
    };
  } else {
    const rejected = ch.outcome.kind === 'REJECTED';
    extra = {
      status: ch.outcome.kind,
      ...(rejected ? { rejectionReason: ch.outcome.reason } : { cancellationReason: ch.outcome.reason, cancelledBy: 'CUSTOMER', cancelledAt: t.cancelledAt }),
      refundStatus: 'SUCCEEDED',
      refundedPaise: ch.refundPaise,
      refundRequestedPaise: ch.refundPaise,
      refunds: [{ refundId: seedId(`blr:refund:${co.n}:${ch.c}`), amountPaise: ch.refundPaise, reason: rejected ? 'RESTAURANT_REJECTED' : 'CUSTOMER_CANCELLED', status: 'SUCCEEDED', updatedAt: t.refundSucceededAt }],
      updatedAt: t.refundSucceededAt,
    };
  }
  return {
    _id: ch.id,
    code: ch.code,
    checkoutGroupId: co.id,
    userId: co.consumer.id,
    restaurantId: r.id,
    restaurantOwnerId: r.ownerUserId,
    restaurantName: r.name,
    restaurantLocation: pt(r.location),
    restaurantAddress: r.address,
    restaurantPhone: r.phone,
    commissionBps: r.commissionBps,
    avgPrepMinutes: r.avgPrepMinutes,
    lines: ch.lines.map((l) => {
      const groups = new Map<string, string[]>();
      for (const a of l.addOns) groups.set(a.groupId, [...(groups.get(a.groupId) ?? []), a.id]);
      const selections = [...groups].map(([groupId, optionIds]) => ({ groupId, optionIds }));
      return {
        cartLineId: null,
        lineKey: lineKeyOf(l.itemId, selections),
        itemId: l.itemId,
        name: l.name,
        isVeg: l.isVeg,
        unitPricePaise: l.unitPricePaise,
        addOns: l.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise })),
        selections,
        quantity: l.quantity,
        note: null,
        lineTotalPaise: l.lineTotalPaise,
      };
    }),
    breakdown: ch.breakdown,
    statusHistory: childHistory(co, ch),
    acceptBy: new Date(t.placedAt.getTime() + 300_000),
    pickupCode: ch.pickupCode,
    deliveryCode: ch.deliveryCode,
    customerContact: contact(co),
    dropAddress: dropAddress(co),
    distanceKm: ch.distanceKm,
    etaMinutes: ch.etaMinutes,
    etaSource: 'DEMO_HAVERSINE',
    isDemo: true,
    placedAt: t.placedAt,
    createdAt: t.createdAt,
    ...extra,
  };
}

function checkoutDoc(co: BlrCheckout) {
  const userId = co.consumer.id;
  const h = [hist(null, 'AWAITING_PAYMENT', 'CUSTOMER', co.createdAt, userId, 'checkout created'), hist('AWAITING_PAYMENT', 'PAID_PLACED', 'SYSTEM', co.placedAt, null, 'payment captured')];
  const delivered = co.children.filter((c) => c.outcome.kind === 'DELIVERED');
  if (!delivered.length) h.push(hist('PAID_PLACED', 'CANCELLED', 'SYSTEM', co.lastEventAt, null, `${co.children[co.children.length - 1]!.code} ${co.children[co.children.length - 1]!.outcome.kind}`));
  else {
    const first = delivered.reduce((a, b) => (a.timeline.acceptedAt! <= b.timeline.acceptedAt! ? a : b));
    const last = delivered.reduce((a, b) => (a.timeline.deliveredAt! >= b.timeline.deliveredAt! ? a : b));
    h.push(hist('PAID_PLACED', 'IN_PROGRESS', 'SYSTEM', first.timeline.acceptedAt!, null, `${first.code} ACCEPTED`));
    h.push(hist('IN_PROGRESS', co.status, 'SYSTEM', co.lastEventAt, null, `${last.code} DELIVERED`));
  }
  const intentId = seedId(`blr:payment-intent:${co.n}`);
  const providerOrderId = `mock_order_blr_${co.n}`;
  return {
    _id: co.id,
    code: co.code,
    userId,
    cartId: null,
    cartVersion: 1,
    restaurantSetKey: '*',
    status: co.status,
    deliveryAddress: dropAddress(co),
    customerContact: contact(co),
    childOrderIds: co.children.map((c) => c.id),
    pricing: co.totals,
    couponCode: co.coupon?.code ?? null,
    membershipId: co.membership?.id ?? null,
    paymentIntentId: intentId,
    providerOrderId,
    paymentStatus: co.paymentStatus,
    payment: { paymentIntentId: intentId, provider: 'mock', providerOrderId, keyId: null, amountPaise: co.totals.totalPaise, currency: 'INR', demoPayUrl: null },
    expiresAt: new Date(co.createdAt.getTime() + 900_000),
    statusHistory: h,
    idempotencyKey: `seed:blr:${co.n}`,
    isDemo: true,
    placedAt: co.placedAt,
    createdAt: co.createdAt,
    updatedAt: co.lastEventAt,
  };
}

function* timelineDocs(co: BlrCheckout) {
  const add = (key: string, childId: string | null, type: string, actor: string, actorId: string | null, at: Date, data: Record<string, unknown> = {}) => ({
    _id: seedId(`blr:order-event:${co.n}:${key}`),
    checkoutGroupId: co.id,
    childOrderId: childId,
    type,
    actor,
    actorId,
    at,
    data: { ...data, isDemo: true },
  });
  yield add('created', null, 'checkout.created', 'CUSTOMER', co.consumer.id, co.createdAt, { totalPaise: co.totals.totalPaise });
  yield add('paid', null, 'payment.captured', 'SYSTEM', null, co.placedAt, { amountPaise: co.totals.totalPaise, paymentIntentId: seedId(`blr:payment-intent:${co.n}`) });
  for (const ch of co.children) {
    const h = childHistory(co, ch);
    for (let i = 1; i < h.length; i++) {
      const e = h[i]!;
      yield add(`${ch.c}:${i}`, ch.id, `order.${e.to.toLowerCase()}`, e.actor, e.actorId, e.at, { from: e.from, to: e.to, ...(e.reason ? { reason: e.reason } : {}) });
    }
    if (ch.refundPaise > 0) yield add(`${ch.c}:refund`, ch.id, 'refund.succeeded', 'SYSTEM', null, ch.timeline.refundSucceededAt!, { refundId: seedId(`blr:refund:${co.n}:${ch.c}`), amountPaise: ch.refundPaise });
  }
}

export async function seedOrdersBlr(conn: Connection, w: BlrWorld): Promise<SeedReport> {
  const m = getModels(conn);
  const report: SeedReport = {};
  const sfx = ' (blr)';
  await ensureDocsBulk(
    m.RestaurantProjection,
    w.restaurants.map((r) => ({ _id: r.id, ownerUserId: r.ownerUserId, name: r.name, status: r.status, location: pt(r.location), eventAt: w.daysAgo(r.createdDaysAgo), isDemo: true })),
    report,
    { label: `restaurant_projection${sfx}` },
  );
  await ensureDocsBulk(m.CheckoutGroup, (function* () {
    for (const co of w.checkouts) yield checkoutDoc(co);
  })(), report, { label: `checkout_groups${sfx}` });
  await ensureDocsBulk(m.ChildOrder, (function* () {
    for (const co of w.checkouts) for (const ch of co.children) yield childDoc(co, ch);
  })(), report, { label: `child_orders${sfx}` });
  await ensureDocsBulk(m.OrderEvent, (function* () {
    for (const co of w.checkouts) yield* timelineDocs(co);
  })(), report, { label: `order_events${sfx}`, chunk: 2000 });
  await ensureDocsBulk(
    m.SupportTicket,
    w.tickets.map((t) => ({
      _id: t.id,
      code: t.code,
      userId: t.userId,
      childOrderId: t.child?.id ?? null,
      checkoutGroupId: t.checkout?.id ?? null,
      subject: t.subject,
      category: t.category,
      status: t.status,
      assigneeId: t.status === 'OPEN' ? null : ADMIN,
      priority: t.priority,
      messages: t.messages.map((msg) => ({ authorId: msg.authorRole === 'ADMIN' ? ADMIN : t.userId, authorRole: msg.authorRole, body: msg.body, at: msg.at })),
      statusHistory: t.history.map((x) => ({ from: x.from, to: x.to, actor: x.actor, actorId: x.actor === 'ADMIN' ? ADMIN : t.userId, reason: null, at: x.at })),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    report,
    { label: `support_tickets${sfx}` },
  );
  return report;
}
