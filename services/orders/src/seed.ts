/**
 * Orders demo seed (APP_MODE=demo only; idempotent; writes only thali_orders).
 *
 *   container:  docker compose exec orders node dist/seed.js
 *   local:      npm run seed -w @thali/orders
 *
 * Seeds the demo order history from `@thali/contracts/seed-demo` (shared with the payments, delivery and
 * notifications seeds so every amount reconciles):
 *   TH-DEMOMULTI  consumer1 — A Spice Route DELIVERED (partner1) + B Green Leaf REJECTED, refund SUCCEEDED
 *                 → checkout PARTIALLY_COMPLETED (paid ₹1,091.40, refunded ₹495.30, net ₹596.10)
 *   TH-DEMODONE   consumer2 — Green Leaf DELIVERED (partner2) → COMPLETED
 *   TH-DEMOCNCL   consumer3 — Spice Route cancelled by the customer while PLACED, refund SUCCEEDED → CANCELLED
 * plus `restaurant_projection` rows for the four seeded restaurants and the admin timeline (`order_events`).
 * Only terminal states are seeded, so no sweeper / consumer ever acts on demo data.
 * Every breakdown is recomputed with `@thali/pricing` and must equal the shared fixture (else the seed refuses).
 */
import type { Connection } from 'mongoose';
import { seedId } from '@thali/contracts/seed';
import {
  DEMO_CHECKOUTS,
  DEMO_DELIVERY_FEE_RULE,
  DEMO_PRICING_CONFIG,
  demoOrderIds as ids,
  demoRefundPaise,
  demoTimeline,
  type DemoCheckout,
  type DemoChild,
  type DemoTimeline,
} from '@thali/contracts/seed-demo';
import { computeDeliveryFee, priceCheckout } from '@thali/pricing';
import { ensureDocs, isMainModule, runSeedCli, type SeedReport } from '@thali/service-kit/seed';
import { lineKeyOf } from './domain/cart.js';
import { getModels, initOrdersDb } from './models/index.js';

const pt = (lat: number, lng: number) => ({ type: 'Point' as const, coordinates: [lng, lat] });
const maskPhone = (p: string) => `${p.slice(0, 3)}******${p.slice(-4)}`;
const hist = (from: string | null, to: string, actor: string, at: Date, actorId: string | null = null, reason: string | null = null) => ({ from, to, actor, actorId, reason, at });

/** `@thali/pricing` must reproduce the fixture exactly (amounts are shared with the payments seed). */
export function verifyDemoPricing(co: DemoCheckout): void {
  const priced = priceCheckout(
    co.children.map((c) => ({
      restaurantId: c.restaurant.slug,
      packagingFeePaise: c.restaurant.packagingFeePaise,
      deliveryFeePaise: computeDeliveryFee(c.distanceKm, DEMO_DELIVERY_FEE_RULE),
      lines: c.lines.map((l) => ({ itemId: l.item, name: l.name, unitPricePaise: l.unitPricePaise, quantity: l.quantity, addOns: l.addOns.map((a) => ({ id: a.option, name: a.name, pricePaise: a.pricePaise })) })),
    })),
    { couponDiscountPaise: 0 },
    null,
    DEMO_PRICING_CONFIG,
  );
  const same = (a: object, b: object) => {
    const ka = Object.keys(a).sort();
    return JSON.stringify(ka) === JSON.stringify(Object.keys(b).sort()) && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
  };
  const mismatch = (what: string, a: unknown, b: unknown) => new Error(`demo pricing drift in ${co.code} ${what}: fixture ${JSON.stringify(a)} != @thali/pricing ${JSON.stringify(b)}`);
  if (!same(priced.totals, co.totals)) throw mismatch('totals', co.totals, priced.totals);
  for (const c of co.children) {
    const p = priced.children.find((x) => x.restaurantId === c.restaurant.slug)!;
    if (!same(p.breakdown, c.breakdown)) throw mismatch(c.key, c.breakdown, p.breakdown);
    p.lines.forEach((l, i) => {
      if (l.lineTotalPaise !== c.lines[i]!.lineTotalPaise) throw mismatch(`${c.key} line ${i}`, c.lines[i]!.lineTotalPaise, l.lineTotalPaise);
    });
  }
}

type ChildSeed = Record<string, unknown> & {
  _id: string;
  code: string;
  status: string;
  updatedAt: Date;
  acceptedAt?: Date;
  deliveredAt?: Date;
  statusHistory: ReturnType<typeof hist>[];
};

function childDoc(co: DemoCheckout, c: DemoChild): ChildSeed {
  const r = c.restaurant;
  const t = demoTimeline(co, c);
  const userId = ids.user(co.consumer);
  const ownerId = ids.user(r.owner);
  const history = [hist(null, 'AWAITING_PAYMENT', 'CUSTOMER', t.createdAt, userId, 'checkout created'), hist('AWAITING_PAYMENT', 'PLACED', 'SYSTEM', t.placedAt, null, 'payment captured')];
  const refund = demoRefundPaise(c);
  let extra: Record<string, unknown> = {};
  switch (c.outcome.kind) {
    case 'DELIVERED': {
      const d = t as Required<Pick<DemoTimeline, 'acceptedAt' | 'preparingAt' | 'readyAt' | 'pickedUpAt' | 'outForDeliveryAt' | 'deliveredAt'>>;
      history.push(
        hist('PLACED', 'ACCEPTED', 'RESTAURANT', d.acceptedAt, ownerId),
        hist('ACCEPTED', 'PREPARING', 'RESTAURANT', d.preparingAt, ownerId),
        hist('PREPARING', 'READY_FOR_PICKUP', 'RESTAURANT', d.readyAt, ownerId),
        hist('READY_FOR_PICKUP', 'PICKED_UP', 'SYSTEM', d.pickedUpAt, null, 'delivery.picked_up'),
        hist('PICKED_UP', 'OUT_FOR_DELIVERY', 'SYSTEM', d.outForDeliveryAt, null, 'delivery.started'),
        hist('OUT_FOR_DELIVERY', 'DELIVERED', 'SYSTEM', d.deliveredAt, null, 'delivery.delivered'),
      );
      extra = {
        status: 'DELIVERED',
        prepMinutes: c.outcome.prepMinutes,
        readyEta: new Date(d.acceptedAt.getTime() + c.outcome.prepMinutes * 60_000),
        acceptedAt: d.acceptedAt,
        readyAt: d.readyAt,
        pickedUpAt: d.pickedUpAt,
        deliveredAt: d.deliveredAt,
        deliveryJobId: ids.job(co, c),
        deliveryStatus: 'DELIVERED',
        partner: { partnerId: ids.partnerId(c.outcome.partner), partnerUserId: ids.user(c.outcome.partner), name: c.outcome.partnerName, vehicle: c.outcome.vehicle },
        deliveryDistanceKm: c.distanceKm,
        deliveryUpdatedAt: d.deliveredAt,
        updatedAt: d.deliveredAt,
      };
      break;
    }
    case 'REJECTED':
    case 'CANCELLED': {
      const x = t as Required<Pick<DemoTimeline, 'refundSucceededAt'>>;
      const endedAt = (c.outcome.kind === 'REJECTED' ? t.rejectedAt : t.cancelledAt)!;
      history.push(
        c.outcome.kind === 'REJECTED'
          ? hist('PLACED', 'REJECTED', 'RESTAURANT', endedAt, ownerId, c.outcome.reason)
          : hist('PLACED', 'CANCELLED', 'CUSTOMER', endedAt, userId, c.outcome.reason),
      );
      extra = {
        status: c.outcome.kind,
        ...(c.outcome.kind === 'REJECTED'
          ? { rejectionReason: c.outcome.reason }
          : { cancellationReason: c.outcome.reason, cancelledBy: 'CUSTOMER', cancelledAt: endedAt }),
        refundStatus: 'SUCCEEDED',
        refundedPaise: refund,
        refundRequestedPaise: refund,
        refunds: [
          {
            refundId: ids.refund(co, c),
            amountPaise: refund,
            reason: c.outcome.kind === 'REJECTED' ? 'RESTAURANT_REJECTED' : 'CUSTOMER_CANCELLED',
            status: 'SUCCEEDED',
            updatedAt: x.refundSucceededAt,
          },
        ],
        updatedAt: x.refundSucceededAt,
      };
      break;
    }
  }
  return {
    _id: ids.child(co, c),
    code: c.code,
    checkoutGroupId: ids.checkout(co),
    userId,
    restaurantId: ids.restaurant(r),
    restaurantOwnerId: ownerId,
    restaurantName: r.name,
    restaurantLocation: pt(r.location.lat, r.location.lng),
    restaurantAddress: r.address,
    restaurantPhone: r.phone,
    commissionBps: r.commissionBps,
    avgPrepMinutes: r.avgPrepMinutes,
    lines: c.lines.map((l) => {
      const itemId = ids.item(r, l.item);
      const groups = new Map<string, string[]>();
      for (const a of l.addOns) {
        const g = ids.group(r, l.item, a.group);
        groups.set(g, [...(groups.get(g) ?? []), ids.option(r, l.item, a.group, a.option)]);
      }
      const selections = [...groups].map(([groupId, optionIds]) => ({ groupId, optionIds }));
      return {
        cartLineId: null,
        lineKey: lineKeyOf(itemId, selections),
        itemId,
        name: l.name,
        isVeg: l.isVeg,
        unitPricePaise: l.unitPricePaise,
        addOns: l.addOns.map((a) => ({ id: ids.option(r, l.item, a.group, a.option), name: a.name, pricePaise: a.pricePaise })),
        selections,
        quantity: l.quantity,
        note: null,
        lineTotalPaise: l.lineTotalPaise,
      };
    }),
    breakdown: c.breakdown,
    statusHistory: history,
    acceptBy: new Date(t.placedAt.getTime() + 300_000),
    pickupCode: c.pickupCode,
    deliveryCode: c.deliveryCode,
    customerContact: { name: co.consumerName, phoneMasked: maskPhone(co.consumerPhone) },
    dropAddress: { label: co.drop.label, line1: co.drop.line1, city: co.drop.city, pincode: co.drop.pincode, location: pt(co.drop.lat, co.drop.lng) },
    distanceKm: c.distanceKm,
    etaMinutes: c.etaMinutes,
    etaSource: 'DEMO_HAVERSINE',
    isDemo: true,
    placedAt: t.placedAt,
    createdAt: t.createdAt,
    ...extra,
  } as unknown as ChildSeed;
}

function checkoutDoc(co: DemoCheckout, children: ChildSeed[]) {
  const t0 = new Date(co.placedAt);
  const createdAt = new Date(t0.getTime() - 60_000);
  const userId = ids.user(co.consumer);
  const history = [hist(null, 'AWAITING_PAYMENT', 'CUSTOMER', createdAt, userId, 'checkout created'), hist('AWAITING_PAYMENT', 'PAID_PLACED', 'SYSTEM', t0, null, 'payment captured')];
  const delivered = children.find((c) => c.status === 'DELIVERED');
  const lastAt = new Date(Math.max(...children.map((c) => c.updatedAt.getTime())));
  if (co.status === 'CANCELLED') history.push(hist('PAID_PLACED', 'CANCELLED', 'SYSTEM', lastAt, null, `${children[0]!.code} CANCELLED`));
  else {
    history.push(hist('PAID_PLACED', 'IN_PROGRESS', 'SYSTEM', delivered!.acceptedAt!, null, `${delivered!.code} ACCEPTED`));
    history.push(hist('IN_PROGRESS', co.status, 'SYSTEM', delivered!.deliveredAt!, null, `${delivered!.code} DELIVERED`));
  }
  return {
    _id: ids.checkout(co),
    code: co.code,
    userId,
    cartId: null,
    cartVersion: 1,
    status: co.status,
    deliveryAddress: { label: co.drop.label, line1: co.drop.line1, city: co.drop.city, pincode: co.drop.pincode, location: pt(co.drop.lat, co.drop.lng) },
    childOrderIds: children.map((c) => c._id),
    pricing: co.totals,
    couponCode: null,
    membershipId: null,
    paymentIntentId: ids.intent(co),
    providerOrderId: ids.providerOrderId(co),
    paymentStatus: co.paymentStatus,
    payment: {
      paymentIntentId: ids.intent(co),
      provider: 'mock',
      providerOrderId: ids.providerOrderId(co),
      keyId: null,
      amountPaise: co.totals.totalPaise,
      currency: 'INR',
      demoPayUrl: null,
    },
    expiresAt: new Date(createdAt.getTime() + 900_000),
    statusHistory: history,
    idempotencyKey: `seed:${co.key}`,
    isDemo: true,
    placedAt: t0,
    createdAt,
    updatedAt: lastAt,
  };
}

function timelineDocs(co: DemoCheckout, children: ChildSeed[]) {
  const gid = ids.checkout(co);
  const out: Record<string, unknown>[] = [];
  const add = (key: string, childId: string | null, type: string, actor: string, actorId: string | null, at: Date, data: Record<string, unknown> = {}) =>
    out.push({ _id: seedId(`order-event:${co.key}:${key}`), checkoutGroupId: gid, childOrderId: childId, type, actor, actorId, at, data: { ...data, isDemo: true } });
  const c0 = new Date(new Date(co.placedAt).getTime() - 60_000);
  add('created', null, 'checkout.created', 'CUSTOMER', ids.user(co.consumer), c0, { totalPaise: co.totals.totalPaise });
  add('paid', null, 'payment.captured', 'SYSTEM', null, new Date(co.placedAt), { amountPaise: co.totals.totalPaise, paymentIntentId: ids.intent(co) });
  for (const c of children) {
    for (const [i, h] of c.statusHistory.entries()) {
      if (i === 0) continue;
      add(`${c.code}:${i}`, c._id, `order.${String(h.to).toLowerCase()}`, h.actor, h.actorId, h.at, { from: h.from, to: h.to, ...(h.reason ? { reason: h.reason } : {}) });
    }
    const refund = (c as { refunds?: { refundId: string; amountPaise: number; updatedAt: Date }[] }).refunds?.[0];
    if (refund) add(`${c.code}:refund`, c._id, 'refund.succeeded', 'SYSTEM', null, refund.updatedAt, { refundId: refund.refundId, amountPaise: refund.amountPaise });
  }
  return out;
}

export async function seedOrders(conn: Connection): Promise<SeedReport> {
  const m = getModels(conn);
  const report: SeedReport = {};

  await ensureDocs(
    m.RestaurantProjection,
    [
      ['spice-route', 'Spice Route', 'owner1', 'APPROVED', 12.9352, 77.6245],
      ['green-leaf', 'Green Leaf', 'owner2', 'APPROVED', 12.9279, 77.6271],
      ['tandoor-tales', 'Tandoor Tales', 'owner1', 'APPROVAL_PENDING', 12.9121, 77.6446],
      ['coastal-curry', 'Coastal Curry House', 'owner2', 'VERIFICATION_PENDING', 12.9409, 77.6206],
    ].map(([slug, name, owner, status, lat, lng]) => ({
      _id: seedId(`restaurant:${slug}`),
      ownerUserId: seedId(`user:${owner}`),
      name,
      status,
      location: pt(lat as number, lng as number),
      eventAt: new Date('2026-09-01T06:30:00.000Z'),
    })),
    report,
    'restaurant_projection',
  );

  for (const co of DEMO_CHECKOUTS) {
    verifyDemoPricing(co);
    const children = co.children.map((c) => childDoc(co, c));
    await ensureDocs(m.CheckoutGroup, [checkoutDoc(co, children)], report);
    await ensureDocs(m.ChildOrder, children, report);
    await ensureDocs(m.OrderEvent, timelineDocs(co, children), report);
  }
  return report;
}

if (isMainModule(import.meta.url)) {
  void runSeedCli({ service: 'orders', dbName: 'thali_orders', init: initOrdersDb, run: seedOrders });
}
