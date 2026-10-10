/** Fixtures shaped exactly like the orders service responses (services/orders/src/schemas.ts). */
import type { Breakdown } from '@thali/contracts';

const R1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const R2 = 'aaaaaaaaaaaaaaaaaaaaaaa2';
export const IDS = { R1, R2, L1: 'bbbbbbbbbbbbbbbbbbbbbbb1', L2: 'bbbbbbbbbbbbbbbbbbbbbbb2', L3: 'bbbbbbbbbbbbbbbbbbbbbbb3' };

export function breakdown(p: Partial<Breakdown>): Breakdown {
  return {
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
    ...p,
  };
}

const delivery = { mode: 'SEPARATE' as const, note: 'Delivered separately by restaurant' };

export function twoRestaurantCart() {
  return {
    id: 'cart1',
    ownerType: 'USER' as const,
    cartVersion: 3,
    groups: [
      {
        restaurantId: R1,
        restaurantName: 'Spice Route',
        lines: [
          { lineId: IDS.L1, restaurantId: R1, itemId: 'i1', name: 'Paneer Tikka', isVeg: true, unitPricePaise: 24000, addOns: [], selections: [], quantity: 2, note: null, lineTotalPaise: 48000 },
        ],
        subtotalPaise: 48000,
        itemCount: 2,
        delivery,
      },
      {
        restaurantId: R2,
        restaurantName: 'Dosa Corner',
        lines: [
          { lineId: IDS.L2, restaurantId: R2, itemId: 'i2', name: 'Masala Dosa', isVeg: true, unitPricePaise: 12000, addOns: [{ id: 'o1', name: 'Extra chutney', pricePaise: 2000 }], selections: [], quantity: 1, note: null, lineTotalPaise: 14000 },
          { lineId: IDS.L3, restaurantId: R2, itemId: 'i3', name: 'Filter Coffee', isVeg: true, unitPricePaise: 6000, addOns: [], selections: [], quantity: 1, note: null, lineTotalPaise: 6000 },
        ],
        subtotalPaise: 20000,
        itemCount: 2,
        delivery,
      },
    ],
    restaurantCount: 2,
    itemCount: 4,
    subtotalPaise: 68000,
    deliveryAddress: null,
    couponCode: null,
    expiresAt: null,
    deliveryExplanation: 'Each restaurant prepares and delivers its part of the order separately.',
  };
}

export const address = {
  id: 'addr1',
  label: 'Home',
  line1: '12 MG Road',
  line2: null,
  landmark: null,
  city: 'Bengaluru',
  pincode: '560001',
  location: { lat: 12.97, lng: 77.59 },
  isDefault: true,
};

export function preview(totalPaise = 81240) {
  const a = breakdown({ itemsSubtotalPaise: 48000, packagingFeePaise: 2000, deliveryFeePaise: 3000, platformFeePaise: 500, foodTaxPaise: 2400, feeTaxPaise: 630, totalPaise: 56530 });
  const b = breakdown({ itemsSubtotalPaise: 20000, packagingFeePaise: 1000, deliveryFeePaise: 2500, platformFeePaise: 500, foodTaxPaise: 1000, feeTaxPaise: 540, totalPaise: totalPaise - 56530 });
  const sum = (k: keyof Breakdown) => a[k] + b[k];
  return {
    cartVersion: 3,
    deliveryAddress: { addressId: null, label: 'Home', line1: '12 MG Road', line2: null, landmark: null, city: 'Bengaluru', pincode: '560001', location: { lat: 12.97, lng: 77.59 } },
    pricing: breakdown(Object.fromEntries((Object.keys(a) as (keyof Breakdown)[]).map((k) => [k, sum(k)]))),
    children: [
      { restaurantId: R1, restaurantName: 'Spice Route', lines: [{ lineId: IDS.L1, itemId: 'i1', name: 'Paneer Tikka', unitPricePaise: 24000, addOns: [], quantity: 2, lineTotalPaise: 48000 }], breakdown: a, distanceKm: 2.1, etaMinutes: 32, etaSource: 'DEMO_HAVERSINE', delivery },
      { restaurantId: R2, restaurantName: 'Dosa Corner', lines: [{ lineId: IDS.L2, itemId: 'i2', name: 'Masala Dosa', unitPricePaise: 12000, addOns: [], quantity: 1, lineTotalPaise: 14000 }], breakdown: b, distanceKm: 3.4, etaMinutes: 41, etaSource: 'DEMO_HAVERSINE', delivery },
    ],
    problems: [],
    canCheckout: true,
    coupon: null,
    membership: null,
    deliveryExplanation: 'Each restaurant prepares and delivers its part of the order separately.',
  };
}

export function childOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    code: 'TH-AAAA1111',
    restaurantId: R1,
    restaurantName: 'Spice Route',
    status: 'ACCEPTED',
    lines: [{ itemId: 'i1', name: 'Paneer Tikka', isVeg: true, unitPricePaise: 24000, addOns: [], selections: [], quantity: 2, note: null, lineTotalPaise: 48000 }],
    breakdown: breakdown({ itemsSubtotalPaise: 48000, totalPaise: 53696 }),
    acceptBy: null,
    placedAt: '2026-10-10T08:00:00.000Z',
    deliveryCode: '4821',
    refundStatus: 'NONE',
    refundedPaise: 0,
    deliveryStatus: null,
    eta: { distanceKm: 2.1, etaMinutes: 32, etaSource: 'DEMO_HAVERSINE' },
    delivery,
    ...over,
  };
}

export function checkoutView(over: Record<string, unknown> = {}) {
  return {
    id: 'ck1',
    code: 'TH-GROUP001',
    status: 'IN_PROGRESS',
    cartVersion: 3,
    createdAt: '2026-10-10T07:58:00.000Z',
    expiresAt: '2026-10-10T08:13:00.000Z',
    placedAt: '2026-10-10T08:00:00.000Z',
    deliveryAddress: preview().deliveryAddress,
    pricing: breakdown({ itemsSubtotalPaise: 68000, totalPaise: 81240 }),
    couponCode: null,
    membershipId: null,
    paymentIntentId: 'pi1',
    paymentStatus: 'CAPTURED',
    isDemo: true,
    deliveryExplanation: 'Each restaurant prepares and delivers its part of the order separately.',
    children: [childOrder()],
    ...over,
  };
}
