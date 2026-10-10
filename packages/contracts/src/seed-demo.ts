/**
 * Demo order history shared by the orders, payments, delivery and notifications seeds (Node only; import
 * from `@thali/contracts/seed-demo`, never from the root index). Each service seeds only its own database
 * from this one description, so amounts and ids reconcile across services.
 *
 * Breakdowns are the exact output of `@thali/pricing` `priceCheckout` for these lines (the orders seed
 * recomputes them at seed time and refuses to run on any mismatch; `services/orders/test/seed.test.ts`
 * pins it). Menu ids follow the marketplace seed: `item:<rest>:<item>`, `group:<rest>:<item>:<group>`,
 * `option:<rest>:<item>:<group>:<option>`. Users: `user:<key>`. Ids for orders/payments/delivery records
 * come from `demoOrderIds`.
 */
import type { Breakdown } from './schemas/order.js';
import { seedId } from './seed.js';

export const DEMO_PRICING_CONFIG = { foodTaxBps: 500, feeTaxBps: 1800, platformFeePaise: 500 } as const;
export const DEMO_DELIVERY_FEE_RULE = { basePaise: 2500, baseKm: 2, perKmPaise: 800, maxPaise: 8000 } as const;
export const DEMO_PARTNER_PAYOUT = { basePaise: 3000, perKmPaise: 800 } as const;

export interface DemoAddOn {
  group: string;
  option: string;
  name: string;
  pricePaise: number;
}
export interface DemoLine {
  item: string;
  name: string;
  isVeg: boolean;
  unitPricePaise: number;
  addOns: DemoAddOn[];
  quantity: number;
  lineTotalPaise: number;
}
export interface DemoRestaurant {
  slug: string;
  name: string;
  owner: string;
  phone: string;
  commissionBps: number;
  packagingFeePaise: number;
  avgPrepMinutes: number;
  location: { lat: number; lng: number };
  address: { line1: string; city: string; pincode: string };
}
export type DemoOutcome =
  | { kind: 'DELIVERED'; partner: string; vehicle: { type: string; registrationNumber: string }; partnerName: string; prepMinutes: number }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'CANCELLED'; reason: string };
export interface DemoChild {
  key: string;
  code: string;
  restaurant: DemoRestaurant;
  lines: DemoLine[];
  distanceKm: number;
  etaMinutes: number;
  breakdown: Breakdown;
  outcome: DemoOutcome;
  pickupCode: string;
  deliveryCode: string;
}
export interface DemoCheckout {
  key: string;
  code: string;
  consumer: string;
  consumerName: string;
  consumerPhone: string;
  drop: { label: string; line1: string; city: string; pincode: string; lat: number; lng: number };
  /** Payment captured / order placed (UTC). */
  placedAt: string;
  status: 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'CANCELLED';
  paymentStatus: 'CAPTURED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
  children: DemoChild[];
  totals: Breakdown;
}

const bd = (b: Omit<Breakdown, 'couponDiscountPaise' | 'membershipDiscountPaise' | 'deliveryDiscountPaise'>): Breakdown => ({
  couponDiscountPaise: 0,
  membershipDiscountPaise: 0,
  deliveryDiscountPaise: 0,
  ...b,
});

export const DEMO_RESTAURANTS = {
  spiceRoute: {
    slug: 'spice-route', name: 'Spice Route', owner: 'owner1', phone: '+918041000001', commissionBps: 2000, packagingFeePaise: 1500, avgPrepMinutes: 25,
    location: { lat: 12.9352, lng: 77.6245 }, address: { line1: '88, 5th Block, Koramangala', city: 'Bengaluru', pincode: '560034' },
  },
  greenLeaf: {
    slug: 'green-leaf', name: 'Green Leaf', owner: 'owner2', phone: '+918041000002', commissionBps: 1500, packagingFeePaise: 1000, avgPrepMinutes: 15,
    location: { lat: 12.9279, lng: 77.6271 }, address: { line1: '12, 1st Block, Koramangala', city: 'Bengaluru', pincode: '560034' },
  },
} satisfies Record<string, DemoRestaurant>;

const ARJUN = { partner: 'partner1', partnerName: 'Arjun Singh', vehicle: { type: 'BIKE', registrationNumber: 'KA01AB1234' } };
const KIRAN = { partner: 'partner2', partnerName: 'Kiran Das', vehicle: { type: 'SCOOTER', registrationNumber: 'KA05CD5678' } };

export const DEMO_CHECKOUTS: readonly DemoCheckout[] = [
  {
    // The multi-restaurant demo: A delivered, B rejected + full refund of B's share.
    key: 'multi',
    code: 'TH-DEMOMULTI',
    consumer: 'consumer1',
    consumerName: 'Asha Rao',
    consumerPhone: '+919000000001',
    drop: { label: 'Home', line1: '42, 4th Block, 80 Feet Road, Koramangala', city: 'Bengaluru', pincode: '560034', lat: 12.9338, lng: 77.6309 },
    placedAt: '2026-10-08T07:30:00.000Z',
    status: 'PARTIALLY_COMPLETED',
    paymentStatus: 'PARTIALLY_REFUNDED',
    children: [
      {
        key: 'A',
        code: 'TH-DEMOMULTI-A',
        restaurant: DEMO_RESTAURANTS.spiceRoute,
        lines: [
          {
            item: 'chicken-biryani', name: 'Hyderabadi Chicken Biryani', isVeg: false, unitPricePaise: 32900, quantity: 1, lineTotalPaise: 39900,
            addOns: [
              { group: 'portion', option: 'regular', name: 'Regular', pricePaise: 0 },
              { group: 'addons', option: 'raita', name: 'Raita', pricePaise: 3000 },
              { group: 'addons', option: 'salan', name: 'Mirchi ka salan', pricePaise: 4000 },
            ],
          },
          { item: 'butter-naan', name: 'Butter Naan', isVeg: true, unitPricePaise: 6000, quantity: 2, lineTotalPaise: 12000, addOns: [] },
        ],
        distanceKm: 0.92,
        etaMinutes: 28,
        breakdown: bd({ itemsSubtotalPaise: 51900, packagingFeePaise: 1500, deliveryFeePaise: 2500, platformFeePaise: 500, foodTaxPaise: 2670, feeTaxPaise: 540, totalPaise: 59610 }),
        outcome: { kind: 'DELIVERED', ...ARJUN, prepMinutes: 20 },
        pickupCode: '4821',
        deliveryCode: '7306',
      },
      {
        key: 'B',
        code: 'TH-DEMOMULTI-B',
        restaurant: DEMO_RESTAURANTS.greenLeaf,
        lines: [
          {
            item: 'paneer-butter-masala', name: 'Paneer Butter Masala', isVeg: true, unitPricePaise: 26900, quantity: 1, lineTotalPaise: 32900,
            addOns: [
              { group: 'spice', option: 'medium', name: 'Medium', pricePaise: 0 },
              { group: 'breads', option: 'butter-naan', name: 'Butter naan', pricePaise: 6000 },
            ],
          },
          {
            item: 'filter-coffee', name: 'Filter Coffee', isVeg: true, unitPricePaise: 6900, quantity: 1, lineTotalPaise: 9900,
            addOns: [{ group: 'size', option: 'large', name: 'Large', pricePaise: 3000 }],
          },
        ],
        distanceKm: 1.01,
        etaMinutes: 19,
        breakdown: bd({ itemsSubtotalPaise: 42800, packagingFeePaise: 1000, deliveryFeePaise: 2500, platformFeePaise: 500, foodTaxPaise: 2190, feeTaxPaise: 540, totalPaise: 49530 }),
        outcome: { kind: 'REJECTED', reason: 'Kitchen closing early today' },
        pickupCode: '1957',
        deliveryCode: '6642',
      },
    ],
    totals: bd({ itemsSubtotalPaise: 94700, packagingFeePaise: 2500, deliveryFeePaise: 5000, platformFeePaise: 1000, foodTaxPaise: 4860, feeTaxPaise: 1080, totalPaise: 109140 }),
  },
  {
    key: 'done',
    code: 'TH-DEMODONE',
    consumer: 'consumer2',
    consumerName: 'Vikram Shah',
    consumerPhone: '+919000000002',
    drop: { label: 'Home', line1: '7, 6th Block, Koramangala', city: 'Bengaluru', pincode: '560034', lat: 12.9391, lng: 77.6197 },
    placedAt: '2026-10-05T14:10:00.000Z',
    status: 'COMPLETED',
    paymentStatus: 'CAPTURED',
    children: [
      {
        key: 'A',
        code: 'TH-DEMODONE-A',
        restaurant: DEMO_RESTAURANTS.greenLeaf,
        lines: [
          {
            item: 'masala-dosa', name: 'Masala Dosa', isVeg: true, unitPricePaise: 14900, quantity: 2, lineTotalPaise: 35800,
            addOns: [{ group: 'addons', option: 'ghee-roast', name: 'Make it ghee roast', pricePaise: 3000 }],
          },
          { item: 'idli-vada', name: 'Idli Vada Combo', isVeg: true, unitPricePaise: 11900, quantity: 1, lineTotalPaise: 11900, addOns: [] },
        ],
        distanceKm: 1.93,
        etaMinutes: 24,
        breakdown: bd({ itemsSubtotalPaise: 47700, packagingFeePaise: 1000, deliveryFeePaise: 2500, platformFeePaise: 500, foodTaxPaise: 2435, feeTaxPaise: 540, totalPaise: 54675 }),
        outcome: { kind: 'DELIVERED', ...KIRAN, prepMinutes: 15 },
        pickupCode: '3390',
        deliveryCode: '5128',
      },
    ],
    totals: bd({ itemsSubtotalPaise: 47700, packagingFeePaise: 1000, deliveryFeePaise: 2500, platformFeePaise: 500, foodTaxPaise: 2435, feeTaxPaise: 540, totalPaise: 54675 }),
  },
  {
    key: 'cncl',
    code: 'TH-DEMOCNCL',
    consumer: 'consumer3',
    consumerName: 'Meera Iyer',
    consumerPhone: '+919000000003',
    drop: { label: 'Home', line1: '19, 1st Block, Koramangala', city: 'Bengaluru', pincode: '560034', lat: 12.9279, lng: 77.6346 },
    placedAt: '2026-10-09T12:45:00.000Z',
    status: 'CANCELLED',
    paymentStatus: 'REFUNDED',
    children: [
      {
        key: 'A',
        code: 'TH-DEMOCNCL-A',
        restaurant: DEMO_RESTAURANTS.spiceRoute,
        lines: [
          {
            item: 'chicken-65', name: 'Chicken 65', isVeg: false, unitPricePaise: 24900, quantity: 1, lineTotalPaise: 36900,
            addOns: [{ group: 'portion', option: 'full', name: 'Full', pricePaise: 12000 }],
          },
        ],
        distanceKm: 1.77,
        etaMinutes: 33,
        breakdown: bd({ itemsSubtotalPaise: 36900, packagingFeePaise: 1500, deliveryFeePaise: 2500, platformFeePaise: 500, foodTaxPaise: 1920, feeTaxPaise: 540, totalPaise: 43860 }),
        outcome: { kind: 'CANCELLED', reason: 'Ordered by mistake' },
        pickupCode: '8814',
        deliveryCode: '2075',
      },
    ],
    totals: bd({ itemsSubtotalPaise: 36900, packagingFeePaise: 1500, deliveryFeePaise: 2500, platformFeePaise: 500, foodTaxPaise: 1920, feeTaxPaise: 540, totalPaise: 43860 }),
  },
];

/** Refund owed for a child (rejected / cancelled before preparation: the full child total). */
export const demoRefundPaise = (c: DemoChild): number => (c.outcome.kind === 'DELIVERED' ? 0 : c.breakdown.totalPaise);

/** Deterministic ids for the demo order records in every service. */
export const demoOrderIds = {
  checkout: (co: DemoCheckout) => seedId(`checkout:${co.key}`),
  child: (co: DemoCheckout, c: DemoChild) => seedId(`child:${co.key}:${c.key}`),
  intent: (co: DemoCheckout) => seedId(`payment-intent:${co.key}`),
  providerOrderId: (co: DemoCheckout) => `mock_order_demo_${co.key}`,
  providerPaymentId: (co: DemoCheckout) => `pay_mock_demo_${co.key}`,
  refund: (co: DemoCheckout, c: DemoChild) => seedId(`refund:${co.key}:${c.key}`),
  providerRefundId: (co: DemoCheckout, c: DemoChild) => `mock_rfnd_demo_${co.key}_${c.key}`.toLowerCase(),
  job: (co: DemoCheckout, c: DemoChild) => seedId(`delivery-job:${co.key}:${c.key}`),
  partnerId: (partnerKey: string) => seedId(`partner:${partnerKey.replace('partner', '')}`),
  user: (key: string) => seedId(`user:${key}`),
  restaurant: (r: DemoRestaurant) => seedId(`restaurant:${r.slug}`),
  item: (r: DemoRestaurant, item: string) => seedId(`item:${r.slug}:${item}`),
  group: (r: DemoRestaurant, item: string, group: string) => seedId(`group:${r.slug}:${item}:${group}`),
  option: (r: DemoRestaurant, item: string, group: string, option: string) => seedId(`option:${r.slug}:${item}:${group}:${option}`),
};

/** Instants of a demo child's lifecycle (fields present depend on the outcome). */
export interface DemoTimeline {
  createdAt: Date;
  placedAt: Date;
  acceptedAt?: Date;
  preparingAt?: Date;
  readyAt?: Date;
  assignedAt?: Date;
  atPickupAt?: Date;
  pickedUpAt?: Date;
  outForDeliveryAt?: Date;
  deliveredAt?: Date;
  rejectedAt?: Date;
  cancelledAt?: Date;
  refundRequestedAt?: Date;
  refundSucceededAt?: Date;
}

/** Timeline for a demo child relative to `placedAt` (minutes). */
export function demoTimeline(co: DemoCheckout, c: DemoChild): DemoTimeline {
  const t0 = new Date(co.placedAt).getTime();
  const at = (min: number) => new Date(t0 + min * 60_000);
  const createdAt = at(-1);
  switch (c.outcome.kind) {
    case 'DELIVERED':
      return {
        createdAt, placedAt: at(0), acceptedAt: at(2), preparingAt: at(3), readyAt: at(2 + c.outcome.prepMinutes),
        assignedAt: at(4), atPickupAt: at(1 + c.outcome.prepMinutes), pickedUpAt: at(3 + c.outcome.prepMinutes),
        outForDeliveryAt: at(4 + c.outcome.prepMinutes), deliveredAt: at(4 + c.outcome.prepMinutes + c.etaMinutes - 10),
      };
    case 'REJECTED':
      return { createdAt, placedAt: at(0), rejectedAt: at(3), refundRequestedAt: at(3), refundSucceededAt: at(4) };
    case 'CANCELLED':
      return { createdAt, placedAt: at(0), cancelledAt: at(1), refundRequestedAt: at(1), refundSucceededAt: at(2) };
  }
}
