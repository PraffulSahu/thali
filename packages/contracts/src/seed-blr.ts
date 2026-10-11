/**
 * Bengaluru-scale demo dataset (Node only; import from `@thali/contracts/seed-blr`, never from the root index).
 *
 * A pure, deterministic generator over `scripts/seed-data` (see its README): ~600 restaurants across all 71
 * localities (450 owners, some with 2-3 branches), menus of 20-30 dishes with photos, 1,000 consumers, 250
 * delivery partners, ~5,000 historical checkouts over the past 60 days priced with `@thali/pricing`
 * `priceCheckout`, ratings, coupons, Thali Plus memberships, weekly payouts and support tickets.
 *
 * Every service seed calls `buildBlrWorld()` and writes only the slice it owns, so ids and amounts reconcile
 * across the six databases without any lookups (gap analysis §5.2):
 *  - ids: `seedId('blr:…')` (`blrIds`); never colliding with the `seed-demo` story (which stays untouched).
 *  - randomness: named seeded streams (`seed-blr-prng.ts`), so the structure (which restaurant, which dish,
 *    which outcome) never depends on the clock.
 *  - time: everything is relative to `anchor` (default `SEED_BLR_ANCHOR` or now; `scripts/seed.ts` passes one
 *    anchor to all services). Only timestamps move with the anchor, so a re-run on another day inserts nothing
 *    new. History has a structural (day-ago, minute-of-day IST) slot per checkout; a slot that would still be
 *    in progress at the anchor is stamped one day earlier (same time of day), so "today" fills up with the
 *    orders that are already finished.
 */
import { bpsOf } from './money.js';
import type { Breakdown } from './schemas/order.js';
import { seedId } from './seed.js';
import { DEMO_DELIVERY_FEE_RULE, DEMO_PARTNER_PAYOUT, DEMO_PRICING_CONFIG } from './seed-demo.js';
import {
  avatarRef,
  imageById,
  imageRef,
  loadBlrData,
  loadImageManifest,
  type AvatarRow,
  type BlrData,
  type DishRow,
  type ImageManifest,
  type LocalityRow,
  type RestaurantNameRow,
  type RestaurantType,
} from './seed-blr-data.js';
import { crockford, haversineKm, offsetKm, rng, slugify, type Rng } from './seed-blr-prng.js';

export * from './seed-blr-data.js';
export { hash32, haversineKm, rng, slugify } from './seed-blr-prng.js';

// ------------------------------------------------------------------------------------- constants --
export const BLR_COUNTS = { restaurants: 600, consumers: 1000, partners: 250, checkouts: 5000, historyDays: 60 } as const;
/** Owners by number of restaurants (330×1 + 90×2 + 30×3 = 600 restaurants, 450 owners). */
const OWNER_SPLIT = [
  [1, 330],
  [2, 90],
  [3, 30],
] as const;
export const BLR_PRICING_CONFIG = DEMO_PRICING_CONFIG;
export const BLR_DELIVERY_FEE_RULE = DEMO_DELIVERY_FEE_RULE;
export const BLR_PARTNER_PAYOUT = DEMO_PARTNER_PAYOUT;
export const BLR_PLAN_ID = seedId('plan:thali-plus');
/** The seeded Thali Plus plan (marketplace seed) as frozen into membership snapshots. */
export const BLR_PLAN = {
  name: 'Thali Plus',
  pricePaise: 14900,
  durationDays: 30,
  benefits: { freeDeliveryMinOrderPaise: 19900, freeDeliveriesPerPeriod: 10, extraDiscountBps: 500, extraDiscountCapPaise: 5000 },
  terms:
    '**Thali Plus (demo plan)**\n\n- Free delivery on up to 10 orders above ₹199 for 30 days\n- Extra 5% off (up to ₹50) per order\n- Prepaid, non-refundable once a benefit has been used\n- Demo mode: payment is simulated',
} as const;

/**
 * Smoke / e2e drop point (Koramangala 4th Block). Generated restaurants keep ≥ 1 km away from it so the
 * demo restaurants (Spice Route 0.7 km, Green Leaf 0.8 km) stay the nearest open ones on the first
 * discovery page there (`scripts/smoke.ts`, `e2e/tests/01-*`).
 */
export const BLR_DEMO_DROP = { lat: 12.9338, lng: 77.6309 };
export const BLR_DEMO_EXCLUSION_KM = 1.0;

/** One city-wide service area: the BBMP area with margin (every locality centroid is inside). */
export const BLR_CITY_POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [77.43, 12.83],
      [77.6, 12.78],
      [77.82, 12.85],
      [77.86, 13.0],
      [77.78, 13.15],
      [77.6, 13.2],
      [77.42, 13.12],
      [77.38, 12.97],
      [77.43, 12.83],
    ],
  ],
};
/** The original demo polygon of `service-area:blr-koramangala` (upgraded in place to the city polygon). */
export const BLR_LEGACY_DEMO_POLYGON = [[[77.58, 12.9], [77.68, 12.9], [77.68, 12.99], [77.58, 12.99], [77.58, 12.9]]];

/**
 * Phones: consumers +9191010xxxxx, owners +9192020xxxxx, partners +9193030xxxxx (demo numbers end in 000000x).
 * These ranges are exactly identity's default DEMO_PHONE_PREFIXES (demo OTP in demo mode).
 */
export const blrPhone = {
  consumer: (j: number) => `+91910${1000001 + j}`,
  owner: (k: number) => `+91920${2000001 + k}`,
  partner: (k: number) => `+91930${3000001 + k}`,
};

export const blrIds = {
  restaurant: (i: number) => seedId(`blr:restaurant:${i}`),
  owner: (k: number) => seedId(`blr:user:owner:${k}`),
  consumer: (j: number) => seedId(`blr:user:consumer:${j}`),
  partnerUser: (k: number) => seedId(`blr:user:partner:${k}`),
  partner: (k: number) => seedId(`blr:partner:${k}`),
  address: (j: number, slot: string) => seedId(`blr:address:${j}:${slot}`),
  category: (i: number, slug: string) => seedId(`blr:category:${i}:${slug}`),
  item: (i: number, dish: string) => seedId(`blr:item:${i}:${dish}`),
  group: (i: number, dish: string, g: number) => seedId(`blr:group:${i}:${dish}:${g}`),
  option: (i: number, dish: string, g: number, o: number) => seedId(`blr:option:${i}:${dish}:${g}:${o}`),
  coupon: (code: string) => seedId(`blr:coupon:${code}`),
  membership: (j: number, term: number) => seedId(`blr:membership:${j}:${term}`),
  membershipIntent: (j: number, term: number) => seedId(`blr:payment-intent:membership:${j}:${term}`),
  membershipProviderOrderId: (j: number, term: number) => `mock_order_blr_m${j}_${term}`,
  membershipProviderPaymentId: (j: number, term: number) => `pay_mock_blr_m${j}_${term}`,
  checkout: (n: number) => seedId(`blr:checkout:${n}`),
  child: (n: number, c: number) => seedId(`blr:child:${n}:${c}`),
  intent: (n: number) => seedId(`blr:payment-intent:${n}`),
  providerOrderId: (n: number) => `mock_order_blr_${n}`,
  providerPaymentId: (n: number) => `pay_mock_blr_${n}`,
  refund: (n: number, c: number) => seedId(`blr:refund:${n}:${c}`),
  providerRefundId: (n: number, c: number) => `mock_rfnd_blr_${n}_${c}`,
  job: (n: number, c: number) => seedId(`blr:delivery-job:${n}:${c}`),
  rating: (n: number, c: number) => seedId(`blr:rating:${n}:${c}`),
  redemption: (n: number) => seedId(`blr:coupon-redemption:${n}`),
  ticket: (t: number) => seedId(`blr:ticket:${t}`),
  payout: (account: string, k: number) => seedId(`blr:payout:${account}:${k}`),
  ledger: (kind: string, key: string) => seedId(`blr:ledger:${kind}:${key}`),
  notification: (key: string) => seedId(`blr:notification:${key}`),
};

/** Shared demo KYC files (uploaded once; generated restaurants and partners all point at them). */
export const BLR_RESTAURANT_DOC_TYPES = ['FSSAI', 'GST', 'PAN'] as const;
export const BLR_PARTNER_DOC_TYPES = ['ID_PROOF', 'DRIVING_LICENSE', 'VEHICLE_RC'] as const;
export const blrRestaurantDocKey = (type: string) => `documents/demo/blr/${type.toLowerCase()}.pdf`;
export const blrPartnerDocKey = (type: string) => `partners/demo/blr/${type.toLowerCase()}.pdf`;

const MIN = 60_000;
const DAY = 86_400_000;
const IST_OFFSET = 330 * MIN;

// ----------------------------------------------------------------------------------------- types --
export interface LatLng {
  lat: number;
  lng: number;
}
export interface HoursSlot {
  day: number;
  open: string;
  close: string;
}
export interface BlrOption {
  id: string;
  name: string;
  pricePaise: number;
  isVeg: boolean;
  available: boolean;
}
export interface BlrGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: BlrOption[];
}
export interface BlrItem {
  id: string;
  dishId: string;
  categoryId: string;
  name: string;
  description: string;
  pricePaise: number;
  isVeg: boolean;
  imageKey: string | null;
  available: boolean;
  trackStock: boolean;
  stockQty: number;
  tags: string[];
  featured: boolean;
  groups: BlrGroup[];
}
export interface BlrCategory {
  id: string;
  name: string;
  sortOrder: number;
}
export type BlrRestaurantStatus = 'APPROVED' | 'APPROVAL_PENDING' | 'VERIFICATION_PENDING' | 'SUSPENDED' | 'REJECTED';
export interface BlrRestaurant {
  i: number;
  id: string;
  slug: string;
  name: string;
  businessName: string;
  brand: number;
  ownerK: number;
  ownerUserId: string;
  primaryCuisine: string;
  cuisines: string[];
  type: RestaurantType;
  priceBand: 'budget' | 'mid' | 'premium';
  pureVeg: boolean;
  description: string;
  locality: LocalityRow;
  location: LatLng;
  address: { line1: string; line2?: string; locality: string; city: string; pincode: string };
  phone: string;
  businessEmail: string;
  accountNumber: string;
  ifsc: string;
  hours: HoursSlot[];
  hoursKind: string;
  status: BlrRestaurantStatus;
  statusReason?: string;
  /** Days before the anchor the restaurant joined (no orders before that). */
  createdDaysAgo: number;
  isNew: boolean;
  commissionBps: number;
  packagingFeePaise: number;
  avgPrepMinutes: number;
  deliveryRadiusKm: number;
  coverRef: string | null;
  coverImageId: string | null;
  categories: BlrCategory[];
  items: BlrItem[];
  popularity: number;
  quality: number;
  ratingSum: number;
  ratingCount: number;
}
export interface BlrAddress {
  id: string;
  label: 'Home' | 'Work' | 'Other';
  line1: string;
  line2?: string;
  locality: string;
  city: 'Bengaluru';
  pincode: string;
  formattedAddress: string;
  location: LatLng;
  isDefault: boolean;
}
export interface BlrUserBase {
  id: string;
  phone: string;
  name: string;
  gender: 'male' | 'female';
  email: string | null;
  avatarKey: string | null;
  createdDaysAgo: number;
}
export interface BlrConsumer extends BlrUserBase {
  j: number;
  addresses: BlrAddress[];
  activity: number;
}
export interface BlrOwner extends BlrUserBase {
  k: number;
  restaurantIdx: number[];
}
export type BlrPartnerStatus = 'APPROVED' | 'APPROVAL_PENDING' | 'SUSPENDED' | 'REJECTED';
export interface BlrPartner extends BlrUserBase {
  k: number;
  partnerId: string;
  vehicle: { type: 'BIKE' | 'SCOOTER' | 'BICYCLE' | 'CAR'; registrationNumber: string };
  status: BlrPartnerStatus;
  statusReason: string | null;
  base: LatLng;
  baseLocality: string;
  activity: number;
}
export interface BlrCoupon {
  id: string;
  code: string;
  description: string;
  type: 'FLAT' | 'PERCENT';
  valuePaise?: number;
  valueBps?: number;
  maxDiscountPaise?: number;
  minOrderPaise: number;
  perUserLimit: number;
  restaurantIds: string[];
  badgeLabel?: string;
  usedCount: number;
}
export interface BlrMembershipUsage {
  checkoutId: string;
  freeDeliveries: number;
  discountPaise: number;
  at: Date;
}
export interface BlrMembership {
  id: string;
  j: number;
  term: number;
  userId: string;
  status: 'ACTIVE' | 'EXPIRED';
  startsAt: Date;
  endsAt: Date;
  /** Structural start (minutes relative to the anchor's IST midnight). */
  startT: number;
  paymentIntentId: string;
  providerOrderId: string;
  providerPaymentId: string;
  usage: BlrMembershipUsage[];
  freeDeliveriesUsed: number;
}
export interface BlrAddOn {
  id: string;
  groupId: string;
  name: string;
  pricePaise: number;
}
export interface BlrLine {
  itemId: string;
  name: string;
  isVeg: boolean;
  unitPricePaise: number;
  addOns: BlrAddOn[];
  quantity: number;
  lineTotalPaise: number;
}
export type BlrOutcome =
  | { kind: 'DELIVERED' }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'CANCELLED'; reason: string };
export interface BlrTimeline {
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
export interface BlrRating {
  id: string;
  stars: number;
  comment: string;
  at: Date;
}
export interface BlrChild {
  c: number;
  id: string;
  code: string;
  restaurant: BlrRestaurant;
  lines: BlrLine[];
  breakdown: Breakdown;
  distanceKm: number;
  etaMinutes: number;
  prepMinutes: number;
  outcome: BlrOutcome;
  partner: BlrPartner | null;
  pickupCode: string;
  deliveryCode: string;
  timeline: BlrTimeline;
  refundPaise: number;
  rating: BlrRating | null;
}
export interface BlrCheckout {
  n: number;
  id: string;
  code: string;
  consumer: BlrConsumer;
  address: BlrAddress;
  /** Structural slot: whole days before the anchor's IST day, and IST minute of day. */
  dayAgo: number;
  minuteOfDay: number;
  createdAt: Date;
  placedAt: Date;
  status: 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'CANCELLED';
  paymentStatus: 'CAPTURED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
  children: BlrChild[];
  totals: Breakdown;
  coupon: BlrCoupon | null;
  membership: BlrMembership | null;
  refundedPaise: number;
  lastEventAt: Date;
}
export interface BlrTicket {
  t: number;
  id: string;
  code: string;
  userId: string;
  checkout: BlrCheckout | null;
  child: BlrChild | null;
  subject: string;
  category: 'ORDER_ISSUE' | 'PAYMENT' | 'DELIVERY' | 'ACCOUNT' | 'OTHER';
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  messages: { authorRole: 'CUSTOMER' | 'ADMIN'; body: string; at: Date }[];
  history: { from: string | null; to: string; at: Date; actor: 'CUSTOMER' | 'ADMIN' }[];
  createdAt: Date;
  updatedAt: Date;
}
export interface BlrWorld {
  anchor: Date;
  data: BlrData;
  manifest: ImageManifest;
  restaurants: BlrRestaurant[];
  owners: BlrOwner[];
  consumers: BlrConsumer[];
  partners: BlrPartner[];
  coupons: BlrCoupon[];
  memberships: BlrMembership[];
  checkouts: BlrCheckout[];
  tickets: BlrTicket[];
  /** Instant of a structural slot (days before the anchor's IST day, IST minutes). */
  at(dayAgo: number, minuteOfDay: number): Date;
  /** `anchor − days` (+ minutes). */
  daysAgo(days: number, minutes?: number): Date;
}

/** Minimal shape of `@thali/pricing` used by the generator (injected so this package keeps no dependency on it). */
export interface BlrPricing {
  priceCheckout(
    rs: { restaurantId: string; packagingFeePaise: number; deliveryFeePaise: number; lines: { itemId: string; name: string; unitPricePaise: number; quantity: number; addOns: { id: string; name: string; pricePaise: number }[] }[] }[],
    d: { couponCode?: string; couponDiscountPaise: number; couponRestaurantIds?: readonly string[] },
    m: { freeDeliveryRestaurantIds: string[]; extraDiscountBps: number; extraDiscountCapPaise: number } | null,
    c: { foodTaxBps: number; feeTaxBps: number; platformFeePaise: number },
  ): { children: { restaurantId: string; lines: { lineTotalPaise: number }[]; breakdown: Breakdown }[]; totals: Breakdown };
  computeDeliveryFee(distanceKm: number, rule: { basePaise: number; baseKm: number; perKmPaise: number; maxPaise: number }): number;
}

/**
 * Load `@thali/pricing` at runtime. Services that do not depend on it (identity, payments, delivery,
 * notifications) still ship its compiled dist in their image (`/repo/packages/pricing/dist`), so fall back to
 * the sibling package path when the bare specifier does not resolve.
 */
export async function loadPricing(): Promise<BlrPricing> {
  const spec = '@thali/pricing';
  try {
    return (await import(spec)) as BlrPricing;
  } catch {
    return (await import(new URL('../../pricing/dist/index.js', import.meta.url).href)) as BlrPricing;
  }
}

// --------------------------------------------------------------------------------------- helpers --
function ord(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** x9-rupee menu price (₹249), never below ₹19. */
const menuPrice = (paise: number) => Math.max(1900, Math.round(paise / 1000) * 1000 - 100);
const round10 = (paise: number) => Math.max(0, Math.round(paise / 1000) * 1000);
const round5r = (paise: number) => Math.max(0, Math.round(paise / 500) * 500);
const NON_VEG_RE = /\b(egg|eggs|chicken|mutton|lamb|fish|prawn|prawns|keema|bacon|ham|pepperoni|salami|meat|beef|pork|crab|squid|sausage|seafood|tuna|anchovy|kheema|liver|boti)\b/i;
const maskPhone = (p: string) => `${p.slice(0, 3)}******${p.slice(-4)}`;
export const blrMaskPhone = maskPhone;

function istMidnight(anchor: Date): number {
  return Math.floor((anchor.getTime() + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
}
export function istMinuteOfDay(d: Date): number {
  return Math.floor((((d.getTime() + IST_OFFSET) % DAY) + DAY) % DAY / MIN);
}

/** Minute-of-day intervals ([start, end) within one day) of a daily schedule, overnight split. */
function intervalsOf(slots: { open: string; close: string }[]): [number, number][] {
  const out: [number, number][] = [];
  for (const s of slots) {
    const o = toMin(s.open);
    const c = toMin(s.close);
    if (o < c) out.push([o, c]);
    else if (o === c) out.push([0, 1440]);
    else {
      out.push([o, 1440]);
      out.push([0, c]);
    }
  }
  return out;
}
const openAt = (iv: [number, number][], m: number) => iv.some(([a, b]) => m >= a && m < b);

// ---------------------------------------------------------------------------------------- cuisines --
/** Bengaluru RTO codes for partner number plates. */
const RTO = ['01', '02', '03', '04', '05', '41', '50', '51', '53', '57', '59', '60', '61'];
const PLATE_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const IFSC = ['HDFC0001234', 'ICIC0000456', 'SBIN0040291', 'UTIB0000009', 'KKBK0008061', 'CNRB0000412', 'BARB0KORAMA'];

/** Restaurant-cover photos whose subject actually matches a café / bakery / sweet shop (by curated id). */
const COVER_ALLOW: Record<string, string[]> = {
  cafe: [
    'cover-007-aliyans-cafe-t-dasarahalli-bangalore-5', 'cover-008-aliyans-cafe-t-dasarahalli-bangalore-4', 'cover-011-interior-of-1up-cafe-2024-02-18',
    'cover-014-interior-of-floral-cafe-2026-02-25', 'cover-015-interior-of-kitchen-cafe-2025-01-29', 'cover-016-interior-johnie-s-coffee-shop-2021',
    'cover-017-interior-johnie-s-coffee-shop-2021-2', 'cover-019-2019-02-awesome-coffee-shop-in-korat', 'cover-020-johnie-s-coffee-shop-interior',
    'cover-124-cafe', 'cover-127-cafe-whitney', 'cover-129-interior', 'cover-130-fog-eater-cafe', 'cover-132-interior-of-zuzu-cafe-taken-with-a-misty',
    'cover-136-interior-of-tatte-bakery-and-cafe', 'cover-137-brickhouse-coffee', 'cover-138-brickhouse-coffee', 'cover-139-view-from-inside-the-coffee-shop',
    'cover-140-coffee-shop-just-before-closing',
  ],
  bakery: [
    'cover-023-bakery-window-display-5338966789', 'cover-027-interior-of-bakery-in-krak-w-2023', 'cover-028-shalom-kosher-interior-bakery-22',
    'cover-029-shalom-kosher-interior-bakery-24', 'cover-160-dscf0568-a-table-topped-with-lots-of-dif', 'cover-161-dsc-9982-a-table-topped-with-trays-fille',
    'cover-163-temptation', 'cover-165-baked-goods-on-display-at-mork-in-centre',
  ],
  desserts: ['cover-030-street-side-sweets-shop-goa-india-2009', 'cover-031-india-varanasi-pastry-shop-2542', 'cover-032-street-side-sweets-shop-uttarakhand-indi'],
};

/** Extra restaurant density per locality (base: every locality gets 6). */
const RESTAURANT_HUBS: Record<string, number> = {
  Indiranagar: 4, 'HSR Layout': 4, Whitefield: 4, Marathahalli: 3, 'BTM Layout': 3, 'JP Nagar': 3, Jayanagar: 3, 'Electronic City': 3, Bellandur: 3,
  'Sarjapur Road': 2, 'MG Road': 2, 'Church Street': 2, 'Brigade Road': 2, Malleshwaram: 2, 'Kalyan Nagar': 2, Hebbal: 2, Banashankari: 2, 'Bannerghatta Road': 2,
  'Koramangala 5th Block': 2, 'Koramangala 6th Block': 1.5, Ejipura: 1.5, Domlur: 1.5, Basavanagudi: 1.5, Rajajinagar: 1.5, 'Frazer Town': 1.5,
};
const RESIDENTIAL: Record<string, number> = {
  'HSR Layout': 3, 'BTM Layout': 3, 'JP Nagar': 3, Jayanagar: 2, Whitefield: 3, Marathahalli: 3, Bellandur: 2.5, 'Electronic City': 2, 'Kalyan Nagar': 2,
  Hebbal: 1.5, Yelahanka: 1.5, Rajajinagar: 2, Malleshwaram: 2, Indiranagar: 2, Banashankari: 2, 'Sarjapur Road': 2.5, Bommanahalli: 2, Hulimavu: 1.5,
  'Bannerghatta Road': 2, Thanisandra: 1.5, 'Ramamurthy Nagar': 1.5, 'KR Puram': 1.5, Mahadevapura: 1.5, Kundalahalli: 1.5, Varthur: 1.5, 'RR Nagar': 1.5,
};
const WORK_HUBS: Record<string, number> = {
  Whitefield: 6, 'Electronic City': 5, Bellandur: 5, Marathahalli: 3, 'Koramangala 4th Block': 2, 'Koramangala 5th Block': 2, Indiranagar: 2, 'MG Road': 3,
  Hebbal: 4, Domlur: 3, 'Sarjapur Road': 2, Mahadevapura: 3, Kundalahalli: 2, Hoodi: 2, 'Old Airport Road': 2, 'Church Street': 1, Yeshwanthpur: 1, 'Brigade Road': 1,
};
const APARTMENTS = [
  'Sai Krupa Residency', 'Green Glen Apartments', 'Lakeview Enclave', 'Sri Lakshmi Nilaya', 'Sunrise Heights', 'Nandi Gardens', 'Silver Oak Apartments',
  'Brindavan Residency', 'Palm Grove Apartments', 'Cauvery Enclave', 'Hamsa Residency', 'Mayura Apartments', 'Shanti Nivas', 'Gulmohar Heights', 'Kaveri Towers',
  'Ashirwad Apartments', 'Tulsi Enclave', 'Hill View Residency', 'Coconut Grove', 'Amrutha Nilaya',
];
const OFFICES = [
  'Lakeside Tech Park', 'Orion Business Bay', 'Cedar Tech Park', 'Silver Oak Campus', 'Banyan Business Park', 'Skyline Tech Towers', 'Granite Square',
  'Riverstone IT Park', 'Maple Corporate Centre', 'Neem Tree Campus', 'Horizon Business Hub', 'Pinnacle Tech Park',
];
const REJECT_REASONS = ['Kitchen closing early today', 'Item out of stock', 'Too many orders right now', 'Delivery partner not available nearby', 'Restaurant closing for a private event'];
const CANCEL_REASONS = ['Ordered by mistake', 'Changed my mind', 'Wrong delivery address', 'Want to add more items', 'Taking too long to accept'];
const RATING_COMMENTS: Record<number, string[]> = {
  5: ['Superb, arrived piping hot!', 'Best biryani in the area.', 'Loved it, will order again.', 'Perfectly packed and fresh.', 'Authentic taste, generous portions.', 'Crispy dosa and great chutney.'],
  4: ['Tasty, slightly late.', 'Good food, could be a bit spicier.', 'Nice portion size.', 'Good value for money.', 'Fresh and tasty.'],
  3: ['Okay, nothing special.', 'Food was a little cold.', 'Average taste this time.', 'Portion was smaller than expected.'],
  2: ['Too oily for my liking.', 'Missing the extra chutney I paid for.', 'Arrived cold.'],
  1: ['Wrong item delivered.', 'Very late and cold.'],
};
const SUSPEND_REASONS = ['Repeated late deliveries', 'Multiple customer complaints', 'Documents expired - renewal pending'];
const REJECT_PARTNER_REASONS = ['Driving licence image unreadable', 'Vehicle RC does not match the registration number'];

// ------------------------------------------------------------------------------------------ world --
export interface BuildBlrWorldOptions {
  pricing: BlrPricing;
  anchor?: Date;
  data?: BlrData;
  manifest?: ImageManifest;
  /** Override counts (tests). */
  counts?: Partial<typeof BLR_COUNTS>;
}

export function defaultBlrAnchor(): Date {
  const env = process.env.SEED_BLR_ANCHOR;
  const d = env ? new Date(env) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`SEED_BLR_ANCHOR is not a date: ${env}`);
  return new Date(Math.floor(d.getTime() / MIN) * MIN);
}

export function buildBlrWorld(opts: BuildBlrWorldOptions): BlrWorld {
  const anchor = opts.anchor ?? defaultBlrAnchor();
  const data = opts.data ?? loadBlrData();
  const manifest = opts.manifest ?? loadImageManifest();
  const counts = { ...BLR_COUNTS, ...opts.counts };
  const midnight = istMidnight(anchor);
  const at = (dayAgo: number, minuteOfDay: number) => new Date(midnight - dayAgo * DAY + minuteOfDay * MIN);
  const daysAgo = (days: number, minutes = 0) => new Date(anchor.getTime() - days * DAY + minutes * MIN);

  const restaurants = genRestaurants(data, manifest, counts.restaurants);
  const owners = genOwners(data, manifest, restaurants);
  const consumers = genConsumers(data, manifest, counts.consumers);
  const partners = genPartners(data, manifest, counts.partners);
  const coupons = genCoupons(restaurants);
  const memberships = genMemberships(consumers, at, anchor);
  const world: BlrWorld = { anchor, data, manifest, restaurants, owners, consumers, partners, coupons, memberships, checkouts: [], tickets: [], at, daysAgo };
  world.checkouts = genCheckouts(world, opts.pricing, counts.checkouts, counts.historyDays);
  world.tickets = genTickets(world);
  return world;
}

// ----------------------------------------------------------------------------------- restaurants --
interface Brand {
  b: number;
  ownerK: number;
  primary: string;
  row: RestaurantNameRow;
  branches: number;
  pureVeg: boolean;
}

function genRestaurants(data: BlrData, manifest: ImageManifest, total: number): BlrRestaurant[] {
  const r0 = rng('brands');
  const cuisineWeights = data.cuisines.map((c) => c.weight);
  const namePools = new Map(Object.entries(data.restaurantNames).map(([k, v]) => [k, rng(`names:${k}`).shuffle(v)]));
  // owners → brands: 330 singles, 90 doubles, 30 triples (scaled down for small test worlds)
  const scale = total / 600;
  const splits: number[] = [];
  for (const [n, count] of OWNER_SPLIT) for (let x = 0; x < Math.round(count * scale); x++) splits.push(n);
  let sum = splits.reduce((a, b) => a + b, 0);
  while (sum > total) sum -= splits.pop()!;
  while (sum < total) {
    splits.push(1);
    sum++;
  }
  const brandSizes = r0.shuffle(splits);
  const brands: Brand[] = brandSizes.map((branches, b) => {
    const rb = rng(`brand:${b}`);
    let primary = data.cuisines[rb.weightedIndex(cuisineWeights)]!.slug;
    let pool = namePools.get(primary)!;
    for (let tries = 0; !pool.length && tries < 50; tries++) {
      primary = data.cuisines[rb.weightedIndex(cuisineWeights)]!.slug;
      pool = namePools.get(primary)!;
    }
    const row = pool.length ? pool.shift()! : rb.pick(data.restaurantNames[primary]!);
    // ≈18% declared pure-veg kitchens: most darshinis / tiffin rooms / sweet shops, fewer of the rest
    const vegNamed = row.veg === 'pure-veg';
    const pVeg = !vegNamed ? 0 : row.type === 'darshini' || row.type === 'tiffin-room' ? 0.85 : primary === 'desserts' || primary === 'ice-cream' ? 0.55 : 0.35;
    return { b, ownerK: b, primary, row, branches, pureVeg: rb.chance(pVeg) };
  });

  // locality slots: every locality ≥ 6 restaurants, extra by hub weight
  const locs = data.localities;
  const base = Math.max(1, Math.min(6, Math.floor(total / locs.length)));
  const slots: number[] = [];
  for (let li = 0; li < locs.length; li++) for (let x = 0; x < base; x++) slots.push(li);
  const rs = rng('locality-slots');
  const hubW = locs.map((l) => RESTAURANT_HUBS[l.name] ?? 1);
  while (slots.length < total) slots.push(rs.weightedIndex(hubW));
  slots.length = total;
  const slotOrder = rs.shuffle(slots);

  // assign branches (distinct localities per brand)
  const assignments: { brand: Brand; li: number; branch: number }[] = [];
  let cursor = 0;
  for (const brand of brands) {
    const used = new Set<number>();
    for (let br = 0; br < brand.branches; br++) {
      let pick = cursor;
      while (pick < slotOrder.length - 1 && used.has(slotOrder[pick]!)) pick++;
      [slotOrder[cursor], slotOrder[pick]] = [slotOrder[pick]!, slotOrder[cursor]!];
      used.add(slotOrder[cursor]!);
      assignments.push({ brand, li: slotOrder[cursor]!, branch: br });
      cursor++;
    }
  }

  const slugs = new Set<string>();
  const out = assignments.map(({ brand, li, branch }, i) => buildRestaurant(data, manifest, brand, locs[li]!, branch, i, slugs));
  assignStatuses(out);
  return out;
}

function buildRestaurant(data: BlrData, manifest: ImageManifest, brand: Brand, loc: LocalityRow, branch: number, i: number, slugs: Set<string>): BlrRestaurant {
  const r = rng(`restaurant:${i}`);
  const row = brand.row;
  const known = new Set(data.cuisines.map((c) => c.slug));
  const secondary = row.secondaryCuisines.filter((c) => known.has(c) && c !== brand.primary).slice(0, 2);
  // location: jittered around the centroid; ≥ 1 km from the smoke/e2e drop point
  let location = offsetKm(loc, Math.min(1.3, 0.12 + Math.abs(r.normal(0, 0.45))), r.next() * 2 * Math.PI);
  if (haversineKm(location, BLR_DEMO_DROP) < BLR_DEMO_EXCLUSION_KM) {
    const bearing = Math.atan2(location.lng - BLR_DEMO_DROP.lng, location.lat - BLR_DEMO_DROP.lat) || r.next() * 2 * Math.PI;
    location = offsetKm(BLR_DEMO_DROP, BLR_DEMO_EXCLUSION_KM + 0.1 + r.next() * 0.6, bearing);
  }
  const street = r.pick(loc.streets);
  const line1 = `${r.int(1, 480)}${r.chance(0.2) ? `/${r.int(1, 9)}` : ''}, ${street}`;
  const line2 = r.chance(0.35) ? r.pick(['Ground Floor', '1st Floor', 'Opp. Bus Stop', 'Near Metro Station', 'Next to Park', '2nd Floor']) : undefined;
  let slug = slugify(`${row.name} ${loc.name}`);
  for (let n = 2; slugs.has(slug); n++) slug = slugify(`${row.name} ${loc.name} ${n}`);
  slugs.add(slug);

  const band = row.priceBand;
  const mult = (band === 'budget' ? 0.85 : band === 'premium' ? 1.3 : 1) * (0.95 + r.next() * 0.12);
  const type = row.type;
  const prepBase: Record<RestaurantType, [number, number]> = {
    darshini: [10, 15], 'tiffin-room': [10, 16], 'quick-service': [12, 18], 'cloud-kitchen': [18, 26], 'family-restaurant': [20, 30], 'military-hotel': [18, 25], cafe: [12, 20],
  };
  let [pmin, pmax] = prepBase[type];
  if (brand.primary === 'bakery' || brand.primary === 'ice-cream' || brand.primary === 'desserts') [pmin, pmax] = [6, 12];
  if (brand.primary === 'biryani' || brand.primary === 'mughlai') [pmin, pmax] = [pmin + 2, pmax + 4];
  const { hours, kind: hoursKind } = genHours(r, type, brand.primary);
  const menu = genMenu(data, manifest, r, i, brand, secondary, mult);
  const cover = pickCover(data, manifest, r, brand.primary, menu.items);
  const accountNumber = `50${String(100000000000 + (seedNumeric(`acct:${i}`) % 899999999999)).slice(0, 12)}`;
  const name = row.name;
  return {
    i,
    id: seedId(`blr:restaurant:${i}`),
    slug,
    name,
    businessName: `${name.replace(/\b(Hotel|Cafe|House|Corner|Centre|Center)\b/g, '').trim() || name} ${r.pick(['Foods', 'Hospitality', 'Kitchens', 'Enterprises', 'Foods LLP'])}${r.chance(0.4) ? ' Pvt Ltd' : ''}`.replace(/\s+/g, ' '),
    brand: brand.b,
    ownerK: brand.ownerK,
    ownerUserId: seedId(`blr:user:owner:${brand.ownerK}`),
    primaryCuisine: brand.primary,
    cuisines: [brand.primary, ...secondary],
    type,
    priceBand: band,
    pureVeg: brand.pureVeg,
    description: row.description,
    locality: loc,
    location,
    address: { line1, ...(line2 ? { line2 } : {}), locality: loc.name, city: 'Bengaluru', pincode: loc.pincode },
    phone: `+9180${41100000 + i}`,
    businessEmail: `orders.${slug.slice(0, 40)}@example.com`,
    accountNumber,
    ifsc: r.pick(IFSC),
    hours,
    hoursKind,
    status: 'APPROVED',
    createdDaysAgo: branch > 0 ? r.int(70, 300) : r.int(90, 720),
    isNew: false,
    commissionBps: r.pick([1500, 1600, 1800, 1800, 2000, 2000, 2200]),
    packagingFeePaise: band === 'budget' ? r.pick([0, 500, 1000]) : band === 'mid' ? r.pick([1000, 1500, 2000]) : r.pick([2000, 2500, 3000]),
    avgPrepMinutes: r.int(pmin, pmax),
    deliveryRadiusKm: band === 'premium' ? r.pick([7, 8]) : r.pick([5, 6, 6, 6, 7]),
    coverRef: cover.ref,
    coverImageId: cover.id,
    categories: menu.categories,
    items: menu.items,
    popularity: Math.exp(r.normal(0, 0.45)) * (type === 'darshini' || type === 'quick-service' ? 1.15 : 1),
    quality: Math.min(4.8, Math.max(3.2, r.normal(4.15, 0.3))),
    ratingSum: 0,
    ratingCount: 0,
  };
}

/** Stable positive integer from a seed name (account numbers etc.). */
function seedNumeric(name: string): number {
  return parseInt(seedId(`blr:${name}`).slice(0, 12), 16);
}

function genHours(r: Rng, type: RestaurantType, primary: string): { hours: HoursSlot[]; kind: string } {
  const daily = (windows: [string, string][]) => [0, 1, 2, 3, 4, 5, 6].flatMap((day) => windows.map(([open, close]) => ({ day, open, close })));
  let kind: string;
  let windows: [string, string][];
  const x = r.next();
  if (type === 'darshini' || type === 'tiffin-room' || primary === 'south-indian') {
    if (x < 0.15) [kind, windows] = ['breakfast-only', [['06:30', '12:00']]];
    else if (x < 0.35) [kind, windows] = ['split-tiffin', [['06:30', '11:30'], ['16:30', '21:30']]];
    else [kind, windows] = ['early', [[r.pick(['06:00', '06:30', '07:00']), r.pick(['22:00', '22:30'])]]];
  } else if (primary === 'cafe') [kind, windows] = ['cafe', [[r.pick(['08:00', '08:30', '09:00']), r.pick(['22:30', '23:00', '23:30'])]]];
  else if (primary === 'bakery') [kind, windows] = ['bakery', [[r.pick(['07:30', '08:00']), r.pick(['21:30', '22:00'])]]];
  else if (primary === 'ice-cream' || primary === 'desserts') [kind, windows] = ['dessert', [[r.pick(['11:00', '12:00']), r.pick(['23:30', '00:30', '01:00'])]]];
  else if (primary === 'chai-snacks') [kind, windows] = x < 0.3 ? ['evening', [['15:30', '23:00']]] : ['all-day', [[r.pick(['06:30', '07:00']), r.pick(['22:30', '23:00'])]]];
  else if (primary === 'street-food') [kind, windows] = x < 0.5 ? ['evening', [['16:00', '22:30']]] : ['all-day', [['11:00', '22:30']]];
  else if (x < 0.5) [kind, windows] = ['regular', [[r.pick(['11:00', '11:30', '12:00']), r.pick(['23:00', '23:30'])]]];
  else if (x < 0.68) [kind, windows] = ['split', [['12:00', '15:30'], ['19:00', '23:00']]];
  else if (x < 0.8) [kind, windows] = ['dinner-only', [[r.pick(['18:00', '18:30', '19:00']), r.pick(['23:30', '00:00'])]]];
  else if (x < 0.92 || type === 'cloud-kitchen') [kind, windows] = ['late-night', [[r.pick(['12:00', '17:00', '19:00']), r.pick(['02:00', '03:00'])]]];
  else [kind, windows] = ['long', [['11:00', '01:00']]];
  let hours = daily(windows);
  // ~5% weekly off (a weekday with no slots), shown as "closed today" on that day
  if (r.chance(0.05)) {
    const off = r.int(1, 4);
    hours = hours.filter((h) => h.day !== off);
    kind += `+off-${off}`;
  }
  return { hours, kind };
}

/** Structural "open at minute-of-day" (weekly offs ignored so the history never depends on the weekday). */
const intervalsCache = new WeakMap<BlrRestaurant, [number, number][]>();
function restaurantOpenAt(r: BlrRestaurant, m: number): boolean {
  let iv = intervalsCache.get(r);
  if (!iv) {
    const day = r.hours.length ? r.hours[0]!.day : 0;
    iv = intervalsOf(r.hours.filter((h) => h.day === day));
    intervalsCache.set(r, iv);
  }
  return openAt(iv, m);
}

function genMenu(data: BlrData, manifest: ImageManifest, r: Rng, i: number, brand: Brand, secondary: string[], mult: number): { categories: BlrCategory[]; items: BlrItem[] } {
  const vegOnlyPrimary = brand.row.veg === 'pure-veg';
  const okPrimary = (d: DishRow) => !vegOnlyPrimary || d.isVeg;
  const okSecondary = (d: DishRow) => !brand.pureVeg || d.isVeg;
  const score = (d: DishRow) => r.next() + (d.tags.includes('bestseller') ? 0.6 : 0) + (d.tags.includes('chef-special') ? 0.2 : 0);
  const rank = (list: DishRow[]) => list.map((d) => ({ d, s: score(d) })).sort((a, b) => b.s - a.s).map((x) => x.d);
  const primaryDishes = rank(data.dishes.filter((d) => d.cuisine === brand.primary && okPrimary(d)));
  const target = r.int(20, 30);
  const fromPrimary = primaryDishes.slice(0, Math.min(primaryDishes.length, Math.round(target * (secondary.length ? 0.72 : 1))));
  const chosen = new Set(fromPrimary.map((d) => d.id));
  const picks = [...fromPrimary];
  const second = rank(data.dishes.filter((d) => secondary.includes(d.cuisine) && okSecondary(d) && !chosen.has(d.id)));
  for (const d of second) {
    if (picks.length >= target) break;
    if (picks.some((p) => p.name === d.name)) continue;
    picks.push(d);
    chosen.add(d.id);
  }
  for (const d of primaryDishes) {
    if (picks.length >= Math.max(14, Math.min(target, 20))) break;
    if (!chosen.has(d.id)) {
      picks.push(d);
      chosen.add(d.id);
    }
  }
  // categories: section order as first seen in dishes.json (primary cuisine first)
  const sectionOrder: string[] = [];
  for (const cz of [brand.primary, ...secondary]) for (const d of data.dishes) if (d.cuisine === cz && !sectionOrder.includes(d.menuSection)) sectionOrder.push(d.menuSection);
  const sections = sectionOrder.filter((s) => picks.some((p) => p.menuSection === s));
  const categories = sections.map((name, sortOrder) => ({ id: seedId(`blr:category:${i}:${slugify(name)}`), name, sortOrder }));
  const catId = new Map(categories.map((c) => [c.name, c.id]));
  const sorted = [...picks].sort((a, b) => sections.indexOf(a.menuSection) - sections.indexOf(b.menuSection));

  const items: BlrItem[] = sorted.map((d) => {
    const groups: BlrGroup[] = [];
    let price = menuPrice(d.basePricePaise * mult);
    if (d.variants && d.variants.options.length > 1) {
      const minDelta = Math.min(...d.variants.options.map((o) => o.priceDeltaPaise));
      price = menuPrice((d.basePricePaise + minDelta) * mult);
      const gi = groups.length;
      groups.push({
        id: seedId(`blr:group:${i}:${d.id}:${gi}`),
        name: d.variants.name,
        minSelect: 1,
        maxSelect: 1,
        options: d.variants.options.map((o, oi) => ({
          id: seedId(`blr:option:${i}:${d.id}:${gi}:${oi}`),
          name: o.name,
          pricePaise: round10((o.priceDeltaPaise - minDelta) * mult),
          isVeg: d.isVeg,
          available: true,
        })),
      });
    }
    for (const g of d.addonGroups ?? []) {
      const gi = groups.length;
      const options = g.options
        .map((o, oi) => ({ id: seedId(`blr:option:${i}:${d.id}:${gi}:${oi}`), name: o.name, pricePaise: round5r(o.pricePaise * mult), isVeg: !NON_VEG_RE.test(o.name), available: r.next() > 0.015 }))
        .filter((o) => !brand.pureVeg || o.isVeg);
      if (!options.length) continue;
      const maxSelect = Math.max(1, Math.min(g.max, options.length));
      const minSelect = Math.min(g.min, maxSelect);
      if (minSelect > 0 && options.filter((o) => o.available).length < minSelect) for (const o of options) o.available = true;
      groups.push({ id: seedId(`blr:group:${i}:${d.id}:${gi}`), name: g.name, minSelect, maxSelect, options });
    }
    const roll = r.next();
    const imageId = d.imageIds.length ? d.imageIds[i % d.imageIds.length]! : null;
    return {
      id: seedId(`blr:item:${i}:${d.id}`),
      dishId: d.id,
      categoryId: catId.get(d.menuSection)!,
      name: d.name,
      description: d.description,
      pricePaise: price,
      isVeg: d.isVeg,
      imageKey: imageId ? imageRef(data, manifest, imageId) : null,
      available: roll >= 0.04,
      trackStock: roll >= 0.04 && roll < 0.1,
      stockQty: roll >= 0.07 && roll < 0.1 ? r.int(6, 40) : 0,
      tags: [...d.tags],
      featured: false,
      groups,
    };
  });
  // featured ("Recommended"): up to 6 bestsellers / chef specials that can be ordered
  const orderable = (it: BlrItem) => it.available && !(it.trackStock && it.stockQty === 0);
  const featuredCount = Math.min(6, r.int(3, 6));
  const ranked = items
    .filter(orderable)
    .map((it) => ({ it, s: (it.tags.includes('bestseller') ? 2 : 0) + (it.tags.includes('chef-special') ? 1 : 0) + r.next() }))
    .sort((a, b) => b.s - a.s);
  for (const { it } of ranked.slice(0, featuredCount)) it.featured = true;
  return { categories, items };
}

function pickCover(data: BlrData, manifest: ImageManifest, r: Rng, primary: string, items: BlrItem[]): { ref: string | null; id: string | null } {
  const allow = COVER_ALLOW[primary === 'ice-cream' ? 'desserts' : primary];
  const imgs = imageById(data);
  if (allow && r.chance(0.4)) {
    const present = allow.filter((x) => imgs.has(x));
    if (present.length) {
      const id = r.pick(present);
      return { ref: imageRef(data, manifest, id), id };
    } // none of the curated covers in images.json: fall through to the dish photo
  }
  // food-forward: a photo of a signature dish (first featured bestseller)
  const sig = items.find((it) => it.featured && it.tags.includes('bestseller')) ?? items.find((it) => it.featured) ?? items[0];
  if (!sig) return { ref: null, id: null };
  const dish = data.dishes.find((d) => d.id === sig.dishId);
  const ids = dish?.imageIds ?? [];
  if (!ids.length) return { ref: null, id: null };
  const id = ids[r.int(0, ids.length - 1)]!;
  return { ref: imageRef(data, manifest, id), id };
}

function assignStatuses(rs: BlrRestaurant[]): void {
  const r = rng('restaurant-statuses');
  const singles = rs.filter((x) => rs.filter((y) => y.brand === x.brand).length === 1);
  const scale = rs.length / 600;
  const plan: [BlrRestaurantStatus, number][] = [
    ['APPROVAL_PENDING', Math.max(1, Math.round(8 * scale))],
    ['VERIFICATION_PENDING', Math.max(1, Math.round(5 * scale))],
    ['SUSPENDED', Math.round(3 * scale)],
    ['REJECTED', Math.round(2 * scale)],
  ];
  const pool = r.shuffle(singles);
  for (const [status, n] of plan) {
    for (let x = 0; x < n && pool.length; x++) {
      const t = pool.shift()!;
      t.status = status;
      if (status === 'APPROVAL_PENDING' || status === 'VERIFICATION_PENDING') t.createdDaysAgo = r.int(1, 6);
      if (status === 'SUSPENDED') t.statusReason = r.pick(['FSSAI licence expired - renewal pending', 'Repeated hygiene complaints']);
      if (status === 'REJECTED') {
        t.statusReason = r.pick(['GST certificate does not match the business name', 'FSSAI licence number could not be verified']);
        t.createdDaysAgo = r.int(8, 30);
      }
    }
  }
  // ≈8% of approved restaurants joined recently ("New": under 5 ratings by construction)
  const approved = rs.filter((x) => x.status === 'APPROVED');
  for (const t of r.sample(approved, Math.round(approved.length * 0.08))) {
    t.isNew = true;
    t.createdDaysAgo = r.int(4, 21);
    t.popularity *= 0.5;
  }
}

// ---------------------------------------------------------------------------------------- people --
interface PeoplePools {
  male: AvatarRow[];
  female: AvatarRow[];
}
const peopleOrder = new WeakMap<BlrData, { consumers: number[]; owners: number[]; partners: number[] }>();
function peopleSplit(data: BlrData) {
  let s = peopleOrder.get(data);
  if (!s) {
    const r = rng('people');
    const idx = r.shuffle(data.people.map((_, i) => i));
    const males = idx.filter((i) => data.people[i]!.gender === 'male');
    const partnersIdx = [...males.slice(0, 232), ...idx.filter((i) => data.people[i]!.gender === 'female').slice(0, 18)];
    const taken = new Set(partnersIdx);
    const rest = idx.filter((i) => !taken.has(i));
    s = { partners: r.shuffle(partnersIdx), owners: rest.slice(0, 450), consumers: rest.slice(450) };
    peopleOrder.set(data, s);
  }
  return s;
}
function avatarPools(data: BlrData): PeoplePools {
  return { male: data.avatars.filter((a) => a.gender === 'male'), female: data.avatars.filter((a) => a.gender === 'female') };
}
const emailLocal = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');

function genOwners(data: BlrData, manifest: ImageManifest, rs: BlrRestaurant[]): BlrOwner[] {
  const pools = avatarPools(data);
  const order = peopleSplit(data).owners;
  const byOwner = new Map<number, number[]>();
  for (const x of rs) byOwner.set(x.ownerK, [...(byOwner.get(x.ownerK) ?? []), x.i]);
  return [...byOwner.keys()].sort((a, b) => a - b).map((k) => {
    const r = rng(`owner:${k}`);
    const p = data.people[order[k % order.length]!]!;
    const av = r.chance(0.55) ? r.pick(pools[p.gender]) : null;
    const restaurantIdx = byOwner.get(k)!;
    return {
      k,
      id: seedId(`blr:user:owner:${k}`),
      phone: blrPhone.owner(k),
      name: p.fullName,
      gender: p.gender,
      email: r.chance(0.7) ? `${emailLocal(p.firstName)}.${emailLocal(p.lastName)}.owner${k}@example.com` : null,
      avatarKey: av ? avatarRef(manifest, av) : null,
      createdDaysAgo: Math.max(...restaurantIdx.map((i) => rs[i]!.createdDaysAgo)) + r.int(1, 5),
      restaurantIdx,
    };
  });
}

function weightedLocality(r: Rng, data: BlrData, weights: Record<string, number>, baseW = 1): LocalityRow {
  return data.localities[r.weightedIndex(data.localities.map((l) => weights[l.name] ?? baseW))]!;
}

function genAddress(r: Rng, j: number, slot: 'Home' | 'Work' | 'Other', loc: LocalityRow, isDefault: boolean): BlrAddress {
  const street = r.pick(loc.streets);
  let line1: string;
  let line2: string | undefined;
  if (slot === 'Work') {
    line1 = `${r.pick(OFFICES)}, Tower ${r.pick(['A', 'B', 'C', 'D'])}, ${ord(r.int(1, 12))} Floor`;
    line2 = street;
  } else if (r.chance(0.5)) {
    line1 = `Flat ${r.int(1, 14)}0${r.int(1, 8)}, ${r.pick(APARTMENTS)}`;
    line2 = street;
  } else {
    line1 = `#${r.int(1, 450)}, ${ord(r.int(1, 18))} Cross, ${street}`;
  }
  const location = offsetKm(loc, 0.1 + Math.abs(r.normal(0, 0.45)), r.next() * 2 * Math.PI);
  return {
    id: seedId(`blr:address:${j}:${slot}`),
    label: slot,
    line1,
    ...(line2 ? { line2 } : {}),
    locality: loc.name,
    city: 'Bengaluru',
    pincode: loc.pincode,
    formattedAddress: `${line1}${line2 ? `, ${line2}` : ''}, ${loc.name}, Bengaluru, Karnataka ${loc.pincode}`,
    location,
    isDefault,
  };
}

function genConsumers(data: BlrData, manifest: ImageManifest, n: number): BlrConsumer[] {
  const pools = avatarPools(data);
  const order = peopleSplit(data).consumers;
  const out: BlrConsumer[] = [];
  for (let j = 0; j < n; j++) {
    const r = rng(`consumer:${j}`);
    const p = data.people[order[j % order.length]!]!;
    const av = r.chance(0.7) ? r.pick(pools[p.gender]) : null;
    const home = genAddress(r, j, 'Home', weightedLocality(r, data, RESIDENTIAL), true);
    const addresses = [home];
    if (r.chance(0.5)) addresses.push(genAddress(r, j, 'Work', weightedLocality(r, data, WORK_HUBS, 0.2), false));
    if (r.chance(0.2)) addresses.push(genAddress(r, j, 'Other', weightedLocality(r, data, RESIDENTIAL), false));
    out.push({
      j,
      id: seedId(`blr:user:consumer:${j}`),
      phone: blrPhone.consumer(j),
      name: p.fullName,
      gender: p.gender,
      email: r.chance(0.55) ? `${emailLocal(p.firstName)}.${emailLocal(p.lastName)}${j}@example.com` : null,
      avatarKey: av ? avatarRef(manifest, av) : null,
      createdDaysAgo: r.int(62, 540),
      addresses,
      activity: Math.exp(r.normal(0, 0.9)),
    });
  }
  return out;
}

function genPartners(data: BlrData, manifest: ImageManifest, n: number): BlrPartner[] {
  const pools = avatarPools(data);
  const order = peopleSplit(data).partners;
  const r0 = rng('partner-statuses');
  const scale = n / 250;
  const statuses: BlrPartnerStatus[] = Array.from({ length: n }, () => 'APPROVED' as BlrPartnerStatus);
  const idx = r0.shuffle(statuses.map((_, k) => k));
  const plan: [BlrPartnerStatus, number][] = [
    ['APPROVAL_PENDING', Math.max(1, Math.round(12 * scale))],
    ['SUSPENDED', Math.round(8 * scale)],
    ['REJECTED', Math.round(5 * scale)],
  ];
  for (const [s, count] of plan) for (let x = 0; x < count && idx.length; x++) statuses[idx.shift()!] = s;
  const plates = new Set<string>();
  return statuses.map((status, k) => {
    const r = rng(`partner:${k}`);
    const p = data.people[order[k % order.length]!]!;
    const av = r.chance(0.85) ? r.pick(pools[p.gender]) : null;
    const vt = r.weighted(['BIKE', 'SCOOTER', 'BICYCLE', 'CAR'] as const, (v) => ({ BIKE: 55, SCOOTER: 37, BICYCLE: 5, CAR: 3 })[v]);
    let plate: string;
    if (vt === 'BICYCLE') plate = `NA-BICYCLE-${String(k).padStart(3, '0')}`;
    else
      do plate = `KA${r.pick(RTO)}${PLATE_LETTERS[r.int(0, PLATE_LETTERS.length - 1)]}${PLATE_LETTERS[r.int(0, PLATE_LETTERS.length - 1)]}${r.int(1000, 9999)}`;
      while (plates.has(plate));
    plates.add(plate);
    const loc = weightedLocality(r, data, RESIDENTIAL);
    return {
      k,
      id: seedId(`blr:user:partner:${k}`),
      partnerId: seedId(`blr:partner:${k}`),
      phone: blrPhone.partner(k),
      name: p.fullName,
      gender: p.gender,
      email: null,
      avatarKey: av ? avatarRef(manifest, av) : null,
      createdDaysAgo: status === 'APPROVAL_PENDING' ? r.int(1, 8) : r.int(70, 600),
      vehicle: { type: vt, registrationNumber: plate },
      status,
      statusReason: status === 'SUSPENDED' ? r.pick(SUSPEND_REASONS) : status === 'REJECTED' ? r.pick(REJECT_PARTNER_REASONS) : null,
      base: offsetKm(loc, Math.abs(r.normal(0, 0.8)), r.next() * 2 * Math.PI),
      baseLocality: loc.name,
      activity: Math.exp(r.normal(0, 0.5)),
    };
  });
}

// --------------------------------------------------------------------------------- coupons & plus --
const CITY_COUPONS: Omit<BlrCoupon, 'id' | 'usedCount' | 'restaurantIds'>[] = [
  { code: 'BLRFEAST', description: '20% off up to ₹120 on orders above ₹249', type: 'PERCENT', valueBps: 2000, maxDiscountPaise: 12000, minOrderPaise: 24900, perUserLimit: 5 },
  { code: 'NAMMA75', description: '₹75 off on orders above ₹349', type: 'FLAT', valuePaise: 7500, minOrderPaise: 34900, perUserLimit: 3 },
  { code: 'WEEKEND40', description: '40% off up to ₹80 on orders above ₹199', type: 'PERCENT', valueBps: 4000, maxDiscountPaise: 8000, minOrderPaise: 19900, perUserLimit: 2 },
  { code: 'BIGBITE150', description: '₹150 off on orders above ₹799', type: 'FLAT', valuePaise: 15000, minOrderPaise: 79900, perUserLimit: 2 },
];
const SCOPED_OFFERS = [
  { type: 'PERCENT', valueBps: 2000, maxDiscountPaise: 10000, minOrderPaise: 19900, badgeLabel: '20% OFF' },
  { type: 'PERCENT', valueBps: 3000, maxDiscountPaise: 7500, minOrderPaise: 14900, badgeLabel: '30% OFF' },
  { type: 'PERCENT', valueBps: 5000, maxDiscountPaise: 10000, minOrderPaise: 24900, badgeLabel: '50% OFF' },
  { type: 'FLAT', valuePaise: 5000, minOrderPaise: 24900, badgeLabel: '₹50 OFF' },
  { type: 'FLAT', valuePaise: 7500, minOrderPaise: 39900, badgeLabel: '₹75 OFF' },
  { type: 'FLAT', valuePaise: 10000, minOrderPaise: 49900, badgeLabel: '₹100 OFF' },
] as const;
const STOP_WORDS = new Set(['SRI', 'SHRI', 'THE', 'NEW', 'HOTEL', 'CAFE', 'OLD', 'NAMMA', 'HOUSE', 'BIG', 'LITTLE', 'MY', 'OUR', 'AL']);
const rupeesLabel = (p: number) => `₹${p / 100}`;

function genCoupons(rs: BlrRestaurant[]): BlrCoupon[] {
  const r = rng('coupons');
  const out: BlrCoupon[] = CITY_COUPONS.map((c) => ({ ...c, id: seedId(`blr:coupon:${c.code}`), restaurantIds: [], usedCount: 0 }));
  const codes = new Set(out.map((c) => c.code));
  const approved = rs.filter((x) => x.status === 'APPROVED');
  const target = Math.round(approved.length * 0.1);
  const brands = r.shuffle([...new Set(approved.map((x) => x.brand))]);
  let covered = 0;
  for (const b of brands) {
    if (covered >= target) break;
    const branches = approved.filter((x) => x.brand === b);
    const offer = r.pick(SCOPED_OFFERS);
    const word = branches[0]!.name.toUpperCase().replace(/[^A-Z ]/g, '').split(/\s+/).find((w) => w.length >= 3 && !STOP_WORDS.has(w)) ?? 'THALI';
    const value = offer.type === 'PERCENT' ? offer.valueBps / 100 : offer.valuePaise / 100;
    let code = `${word.slice(0, 8)}${value}`;
    for (let n = 2; codes.has(code); n++) code = `${word.slice(0, 7)}${value}${n}`;
    codes.add(code);
    const headline = offer.type === 'PERCENT' ? `${offer.valueBps / 100}% off up to ${rupeesLabel(offer.maxDiscountPaise)}` : `${rupeesLabel(offer.valuePaise)} off`;
    out.push({
      id: seedId(`blr:coupon:${code}`),
      code,
      description: `${headline} at ${branches[0]!.name} on orders above ${rupeesLabel(offer.minOrderPaise)}`,
      type: offer.type,
      ...(offer.type === 'PERCENT' ? { valueBps: offer.valueBps, maxDiscountPaise: offer.maxDiscountPaise } : { valuePaise: offer.valuePaise }),
      minOrderPaise: offer.minOrderPaise,
      perUserLimit: 3,
      restaurantIds: branches.map((x) => x.id),
      badgeLabel: offer.badgeLabel,
      usedCount: 0,
    });
    covered += branches.length;
  }
  return out;
}

/** marketplace `computeDiscount` (coupons.ts): FLAT value / PERCENT bps half-up capped, never above the subtotal. */
export function blrCouponDiscount(c: Pick<BlrCoupon, 'type' | 'valuePaise' | 'valueBps' | 'maxDiscountPaise'>, subtotalPaise: number): number {
  let d = c.type === 'FLAT' ? (c.valuePaise ?? 0) : bpsOf(subtotalPaise, c.valueBps ?? 0);
  if (c.type === 'PERCENT' && c.maxDiscountPaise != null) d = Math.min(d, c.maxDiscountPaise);
  return Math.max(0, Math.min(d, subtotalPaise));
}

function genMemberships(consumers: BlrConsumer[], at: (d: number, m: number) => Date, anchor: Date): BlrMembership[] {
  const out: BlrMembership[] = [];
  for (const c of consumers) {
    const r = rng(`membership:${c.j}`);
    if (!r.chance(0.09)) continue;
    const s0 = r.int(2, 29);
    const terms = 1 + (r.chance(0.45) ? 1 : 0) + (r.chance(0.25) ? 1 : 0);
    for (let term = 0; term < terms; term++) {
      const startDay = s0 + 30 * (terms - 1 - term);
      const startT = -startDay * 1440 + 600 + r.int(0, 600);
      const startsAt = at(0, startT); // at(0, m) with negative m = days before today
      const endsAt = new Date(startsAt.getTime() + BLR_PLAN.durationDays * DAY);
      out.push({
        id: seedId(`blr:membership:${c.j}:${term}`),
        j: c.j,
        term,
        userId: c.id,
        status: endsAt.getTime() > anchor.getTime() ? 'ACTIVE' : 'EXPIRED',
        startsAt,
        endsAt,
        startT,
        paymentIntentId: seedId(`blr:payment-intent:membership:${c.j}:${term}`),
        providerOrderId: `mock_order_blr_m${c.j}_${term}`,
        providerPaymentId: `pay_mock_blr_m${c.j}_${term}`,
        usage: [],
        freeDeliveriesUsed: 0,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------- checkouts --
const MEALS: { w: number; mu: number; sd: number }[] = [
  { w: 9, mu: 8.6 * 60, sd: 50 },
  { w: 37, mu: 13.3 * 60, sd: 55 },
  { w: 10, mu: 17 * 60, sd: 45 },
  { w: 38, mu: 20.8 * 60, sd: 65 },
  { w: 6, mu: 23.5 * 60, sd: 40 },
];

interface ChildPlan {
  restaurant: BlrRestaurant;
  lines: Omit<BlrLine, 'lineTotalPaise'>[];
  distanceKm: number;
  deliveryFeePaise: number;
  outcome: BlrOutcome;
}

function genCheckouts(w: BlrWorld, pricing: BlrPricing, total: number, historyDays: number): BlrCheckout[] {
  const anchorMs = w.anchor.getTime();
  const r0 = rng('checkout-days');
  // per-day volume: ~1.6× growth over the window, ±12% noise; day 0 = today (structural)
  const dayW = Array.from({ length: historyDays + 1 }, (_, d) => (1 + 0.6 * (historyDays - d) / historyDays) * (0.88 + r0.next() * 0.24));
  const sumW = dayW.reduce((a, b) => a + b, 0);
  const perDay = dayW.map((x) => Math.floor((x / sumW) * total));
  for (let d = 0, left = total - perDay.reduce((a, b) => a + b, 0); left > 0; d = (d + 1) % perDay.length, left--) perDay[d]!++;
  const slots: { d: number; m: number }[] = [];
  for (let d = historyDays; d >= 0; d--) {
    const rd = rng(`day:${d}`);
    const ms: number[] = [];
    for (let x = 0; x < perDay[d]!; x++) {
      const meal = MEALS[rd.weightedIndex(MEALS.map((mm) => mm.w))]!;
      ms.push((((Math.round(rd.normal(meal.mu, meal.sd)) % 1440) + 1440) % 1440));
    }
    ms.sort((a, b) => a - b);
    for (const m of ms) slots.push({ d, m });
  }

  const approved = w.restaurants.filter((x) => x.status === 'APPROVED');
  const approvedPartners = w.partners.filter((p) => p.status === 'APPROVED');
  const nearPartners = new Map<number, BlrPartner[]>();
  for (const rest of approved) {
    nearPartners.set(
      rest.i,
      approvedPartners
        .map((p) => ({ p, km: haversineKm(p.base, rest.location) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, 30)
        .map((x) => x.p),
    );
  }
  const consumerCum: number[] = [];
  let acc = 0;
  for (const c of w.consumers) consumerCum.push((acc += c.activity));
  const pickConsumer = (r: Rng) => {
    const x = r.next() * acc;
    let lo = 0;
    let hi = consumerCum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (consumerCum[mid]! > x) hi = mid;
      else lo = mid + 1;
    }
    return w.consumers[lo]!;
  };
  const scopedByRestaurant = new Map<string, BlrCoupon>();
  for (const c of w.coupons) for (const id of c.restaurantIds) scopedByRestaurant.set(id, c);
  const cityCoupons = w.coupons.filter((c) => !c.restaurantIds.length);
  const couponUses = new Map<string, number>(); // `${couponId}|${userId}`
  const membershipsByUser = new Map<string, BlrMembership[]>();
  for (const m of w.memberships) membershipsByUser.set(m.userId, [...(membershipsByUser.get(m.userId) ?? []), m]);
  const codes = new Set<string>();
  const newCode = (r: Rng) => {
    let code: string;
    do code = `TH-${crockford(r, 8)}`;
    while (codes.has(code));
    codes.add(code);
    return code;
  };

  const orderCount = new Map<number, number>();
  const out: BlrCheckout[] = [];
  for (let n = 0; n < slots.length; n++) {
    const r = rng(`checkout:${n}`);
    let { d, m } = slots[n]!;
    // consumer + address + nearby open restaurants (resample the slot's customer / time if nothing fits)
    let consumer: BlrConsumer | null = null;
    let address: BlrAddress | null = null;
    let candidates: { rest: BlrRestaurant; km: number }[] = [];
    for (let attempt = 0; attempt < 40 && !candidates.length; attempt++) {
      if (attempt > 0 && attempt % 8 === 0) m = (m + r.int(30, 180)) % 1440;
      consumer = pickConsumer(r);
      const work = consumer.addresses.find((a) => a.label === 'Work');
      const other = consumer.addresses.find((a) => a.label === 'Other');
      const pWork = m >= 660 && m <= 1020 ? 0.45 : 0.08;
      address = work && r.chance(pWork) ? work : other && r.chance(0.12) ? other : consumer.addresses[0]!;
      const drop = address.location;
      candidates = approved
        .filter((x) => x.createdDaysAgo - 3 > d && restaurantOpenAt(x, m))
        .map((rest) => ({ rest, km: haversineKm(rest.location, drop) }))
        .filter((x) => x.km <= Math.min(x.rest.deliveryRadiusKm, 7));
    }
    if (!candidates.length || !consumer || !address) throw new Error(`blr seed: no restaurant can serve checkout slot ${n}`);
    // nearby + popular first, with diminishing returns so every listed restaurant builds some history
    const weights = candidates.map((x) => (x.rest.popularity * Math.exp(-x.km / 3)) / (1 + (orderCount.get(x.rest.i) ?? 0) / 4) ** 1.5);
    const firstIdx = r.weightedIndex(weights);
    const chosen = [candidates[firstIdx]!];
    if (candidates.length > 1 && r.chance(0.2)) {
      const w2 = weights.map((x, k) => (k === firstIdx ? 0 : x));
      chosen.push(candidates[r.weightedIndex(w2)]!);
    }
    for (const x of chosen) orderCount.set(x.rest.i, (orderCount.get(x.rest.i) ?? 0) + 1);
    const plans: ChildPlan[] = chosen.map(({ rest, km }) => {
      const distanceKm = Math.round(km * 1.3 * 100) / 100;
      const roll = r.next();
      const outcome: BlrOutcome =
        roll < 0.868 ? { kind: 'DELIVERED' } : roll < 0.94 ? { kind: 'REJECTED', reason: r.pick(REJECT_REASONS) } : { kind: 'CANCELLED', reason: r.pick(CANCEL_REASONS) };
      return { restaurant: rest, lines: pickLines(r, rest), distanceKm, deliveryFeePaise: pricing.computeDeliveryFee(distanceKm, BLR_DELIVERY_FEE_RULE), outcome };
    });
    const anyDelivered = plans.some((p) => p.outcome.kind === 'DELIVERED');
    const subtotalOf = (p: ChildPlan) => p.lines.reduce((s, l) => s + (l.unitPricePaise + l.addOns.reduce((a, x) => a + x.pricePaise, 0)) * l.quantity, 0);
    const t = -d * 1440 + m;

    // coupon (only on checkouts that end with at least one delivery: fully cancelled ones release theirs)
    let coupon: BlrCoupon | null = null;
    let couponDiscount = 0;
    if (anyDelivered) {
      const uses = (c: BlrCoupon) => couponUses.get(`${c.id}|${consumer!.id}`) ?? 0;
      const scoped = plans.map((p) => scopedByRestaurant.get(p.restaurant.id)).find((c) => !!c);
      if (scoped && r.chance(0.55)) {
        const eligible = plans.filter((p) => scoped.restaurantIds.includes(p.restaurant.id)).reduce((s, p) => s + subtotalOf(p), 0);
        if (eligible >= scoped.minOrderPaise && uses(scoped) < scoped.perUserLimit) [coupon, couponDiscount] = [scoped, blrCouponDiscount(scoped, eligible)];
      }
      if (!coupon && r.chance(0.11)) {
        const subtotal = plans.reduce((s, p) => s + subtotalOf(p), 0);
        const ok = cityCoupons.filter((c) => subtotal >= c.minOrderPaise && uses(c) < c.perUserLimit);
        if (ok.length) {
          const c = r.pick(ok);
          [coupon, couponDiscount] = [c, blrCouponDiscount(c, subtotal)];
        }
      }
      if (coupon && couponDiscount <= 0) [coupon, couponDiscount] = [null, 0];
      if (coupon) couponUses.set(`${coupon.id}|${consumer.id}`, (couponUses.get(`${coupon.id}|${consumer.id}`) ?? 0) + 1);
    }

    // Thali Plus (structural term window), only for checkouts with a delivery
    let membership: BlrMembership | null = null;
    let benefit: { freeDeliveryRestaurantIds: string[]; extraDiscountBps: number; extraDiscountCapPaise: number } | null = null;
    if (anyDelivered) {
      membership = (membershipsByUser.get(consumer.id) ?? []).find((mm) => t >= mm.startT && t < mm.startT + BLR_PLAN.durationDays * 1440) ?? null;
      if (membership) {
        const left = Math.max(0, BLR_PLAN.benefits.freeDeliveriesPerPeriod - membership.freeDeliveriesUsed);
        const free = plans
          .filter((p) => subtotalOf(p) >= BLR_PLAN.benefits.freeDeliveryMinOrderPaise && p.deliveryFeePaise > 0)
          .map((p) => p.restaurant.id)
          .sort()
          .slice(0, left);
        benefit = { freeDeliveryRestaurantIds: free, extraDiscountBps: BLR_PLAN.benefits.extraDiscountBps, extraDiscountCapPaise: BLR_PLAN.benefits.extraDiscountCapPaise };
      }
    }

    const priced = pricing.priceCheckout(
      plans.map((p) => ({
        restaurantId: p.restaurant.id,
        packagingFeePaise: p.restaurant.packagingFeePaise,
        deliveryFeePaise: p.deliveryFeePaise,
        lines: p.lines.map((l) => ({ itemId: l.itemId, name: l.name, unitPricePaise: l.unitPricePaise, quantity: l.quantity, addOns: l.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise })) })),
      })),
      coupon ? { couponCode: coupon.code, couponDiscountPaise: couponDiscount, ...(coupon.restaurantIds.length ? { couponRestaurantIds: coupon.restaurantIds } : {}) } : { couponDiscountPaise: 0 },
      benefit,
      BLR_PRICING_CONFIG,
    );

    // timestamps: a slot still in progress at the anchor is stamped one (or more) days earlier, same time of day
    let tsDay = d;
    while (w.at(tsDay, m).getTime() + 150 * MIN > anchorMs) tsDay++;
    const placedAt = new Date(w.at(tsDay, m).getTime() + r.int(0, 59) * 1000);
    const createdAt = new Date(placedAt.getTime() - r.int(40, 110) * 1000);
    const id = seedId(`blr:checkout:${n}`);
    const children: BlrChild[] = plans.map((p, c) => {
      const pc = priced.children.find((x) => x.restaurantId === p.restaurant.id)!;
      const lines: BlrLine[] = p.lines.map((l, li) => ({ ...l, lineTotalPaise: pc.lines[li]!.lineTotalPaise }));
      const rc = rng(`child:${n}:${c}`);
      const prepMinutes = Math.max(5, Math.min(45, p.restaurant.avgPrepMinutes + rc.int(-4, 6)));
      const travel = Math.ceil((p.distanceKm / 20) * 60);
      const timeline = childTimeline(rc, createdAt, placedAt, p.outcome, prepMinutes, travel);
      let partner: BlrPartner | null = null;
      if (p.outcome.kind === 'DELIVERED') {
        const near = nearPartners.get(p.restaurant.i)!.filter((x) => x.createdDaysAgo - 2 > tsDay);
        partner = near.length ? rc.weighted(near, (x) => x.activity) : rc.pick(approvedPartners);
      }
      const pickupCode = String(rc.int(0, 9999)).padStart(4, '0');
      let deliveryCode = String(rc.int(0, 9999)).padStart(4, '0');
      while (deliveryCode === pickupCode) deliveryCode = String(rc.int(0, 9999)).padStart(4, '0');
      return {
        c,
        id: seedId(`blr:child:${n}:${c}`),
        code: newCode(rc),
        restaurant: p.restaurant,
        lines,
        breakdown: pc.breakdown,
        distanceKm: p.distanceKm,
        etaMinutes: p.restaurant.avgPrepMinutes + travel,
        prepMinutes,
        outcome: p.outcome,
        partner,
        pickupCode,
        deliveryCode,
        timeline,
        refundPaise: p.outcome.kind === 'DELIVERED' ? 0 : pc.breakdown.totalPaise,
        rating: null,
      };
    });
    const refunded = children.reduce((s, ch) => s + ch.refundPaise, 0);
    const delivered = children.filter((ch) => ch.outcome.kind === 'DELIVERED').length;
    const status = delivered === children.length ? 'COMPLETED' : delivered > 0 ? 'PARTIALLY_COMPLETED' : 'CANCELLED';
    const paymentStatus = refunded === 0 ? 'CAPTURED' : refunded === priced.totals.totalPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const lastEventAt = new Date(
      Math.max(...children.map((ch) => (ch.timeline.deliveredAt ?? ch.timeline.refundSucceededAt ?? ch.timeline.placedAt).getTime())),
    );
    const co: BlrCheckout = {
      n,
      id,
      code: newCode(r),
      consumer,
      address,
      dayAgo: d,
      minuteOfDay: m,
      createdAt,
      placedAt,
      status,
      paymentStatus,
      children,
      totals: priced.totals,
      coupon,
      membership,
      refundedPaise: refunded,
      lastEventAt,
    };
    if (coupon) coupon.usedCount++;
    if (membership) {
      const freeDeliveries = children.filter((ch) => ch.breakdown.deliveryDiscountPaise > 0).length;
      membership.usage.push({ checkoutId: id, freeDeliveries, discountPaise: priced.totals.membershipDiscountPaise, at: placedAt });
      membership.freeDeliveriesUsed += freeDeliveries;
    }
    out.push(co);
  }
  assignRatings(w, out);
  return out;
}

function pickLines(r: Rng, rest: BlrRestaurant): Omit<BlrLine, 'lineTotalPaise'>[] {
  const orderable = rest.items.filter((it) => it.available && !it.trackStock);
  const count = Math.min(orderable.length, r.weighted([1, 2, 3, 4], (x) => ({ 1: 35, 2: 35, 3: 20, 4: 10 })[x]!));
  const picked: BlrItem[] = [];
  const pool = [...orderable];
  for (let x = 0; x < count && pool.length; x++) {
    const k = r.weightedIndex(pool.map((it) => (it.featured ? 3 : 1) * (it.tags.includes('bestseller') ? 2 : 1)));
    picked.push(pool.splice(k, 1)[0]!);
  }
  return picked.map((it) => {
    const addOns: BlrAddOn[] = [];
    for (const g of it.groups) {
      const avail = g.options.filter((o) => o.available);
      if (!avail.length) continue;
      let n = 0;
      if (g.minSelect > 0) n = g.minSelect;
      else if (r.chance(0.25)) n = Math.min(g.maxSelect, avail.length, r.int(1, 2));
      const opts = g.minSelect > 0 && g.maxSelect === 1 ? [r.chance(0.55) ? avail[0]! : r.pick(avail)] : r.sample(avail, n);
      for (const o of opts) addOns.push({ id: o.id, groupId: g.id, name: o.name, pricePaise: o.pricePaise });
    }
    return { itemId: it.id, name: it.name, isVeg: it.isVeg, unitPricePaise: it.pricePaise, addOns, quantity: r.weighted([1, 2, 3], (q) => ({ 1: 80, 2: 17, 3: 3 })[q]!) };
  });
}

function childTimeline(r: Rng, createdAt: Date, placedAt: Date, outcome: BlrOutcome, prepMinutes: number, travel: number): BlrTimeline {
  const t0 = placedAt.getTime();
  const at = (min: number) => new Date(t0 + Math.round(min * 60) * 1000);
  switch (outcome.kind) {
    case 'DELIVERED': {
      const accept = 0.5 + r.next() * 3.5;
      const assigned = accept + 1 + r.next() * 4;
      const ready = accept + prepMinutes;
      const atPickup = Math.max(assigned + 3, ready - r.int(0, 4));
      const pickedUp = Math.max(ready, atPickup) + 1 + r.next() * 2;
      const out = pickedUp + 0.5 + r.next() * 0.5;
      const delivered = out + travel + r.int(1, 6);
      return {
        createdAt, placedAt, acceptedAt: at(accept), preparingAt: at(accept + 0.5 + r.next() * 0.5), readyAt: at(ready), assignedAt: at(assigned),
        atPickupAt: at(atPickup), pickedUpAt: at(pickedUp), outForDeliveryAt: at(out), deliveredAt: at(delivered),
      };
    }
    case 'REJECTED': {
      const rej = 0.5 + r.next() * 3.5;
      return { createdAt, placedAt, rejectedAt: at(rej), refundRequestedAt: at(rej), refundSucceededAt: at(rej + 0.5 + r.next() * 2.5) };
    }
    case 'CANCELLED': {
      const cnl = 0.3 + r.next() * 1.7;
      return { createdAt, placedAt, cancelledAt: at(cnl), refundRequestedAt: at(cnl), refundSucceededAt: at(cnl + 0.5 + r.next() * 2) };
    }
  }
}

/** Ratings only for delivered children; "new" restaurants stay under 5 so the UI shows "New". */
function assignRatings(w: BlrWorld, checkouts: BlrCheckout[]): void {
  const limit = w.anchor.getTime() - MIN;
  for (const co of checkouts) {
    for (const ch of co.children) {
      if (ch.outcome.kind !== 'DELIVERED') continue;
      const rest = ch.restaurant;
      const r = rng(`rating:${co.n}:${ch.c}`);
      if (!r.chance(0.8)) continue;
      if (rest.isNew && rest.ratingCount >= 4) continue;
      const stars = Math.max(1, Math.min(5, Math.round(rest.quality + r.normal(0, 0.75))));
      const comment = r.chance(0.35) ? r.pick(RATING_COMMENTS[stars]!) : '';
      const t = Math.min(limit, ch.timeline.deliveredAt!.getTime() + r.int(5, 240) * MIN);
      ch.rating = { id: seedId(`blr:rating:${co.n}:${ch.c}`), stars, comment, at: new Date(t) };
      rest.ratingSum += stars;
      rest.ratingCount++;
    }
  }
}

// ------------------------------------------------------------------------------------- tickets --
function genTickets(w: BlrWorld): BlrTicket[] {
  const r = rng('tickets');
  const recent = w.checkouts.filter((co) => co.dayAgo <= 14);
  const withIssue = recent.filter((co) => co.children.some((ch) => ch.outcome.kind !== 'DELIVERED'));
  const delivered = recent.filter((co) => co.children.every((ch) => ch.outcome.kind === 'DELIVERED'));
  const out: BlrTicket[] = [];
  const codes = new Set<string>();
  const limit = w.anchor.getTime() - 5 * MIN;
  const templates: { category: BlrTicket['category']; subject: string; body: string; reply: string; needs: 'issue' | 'delivered' | 'none'; priority: BlrTicket['priority'] }[] = [
    { category: 'PAYMENT', subject: 'Refund not received yet', body: 'My order was rejected but I have not received the refund in my account.', reply: 'The refund was processed on our side; UPI refunds can take up to 5 working days to show in your bank.', needs: 'issue', priority: 'HIGH' },
    { category: 'ORDER_ISSUE', subject: 'Item missing from my order', body: 'One of the items I paid for was missing from the bag.', reply: 'Sorry about that. We have flagged it with the restaurant and are checking the packing photo.', needs: 'delivered', priority: 'NORMAL' },
    { category: 'DELIVERY', subject: 'Order arrived late and cold', body: 'The order took much longer than the estimate and the food was cold.', reply: 'Apologies for the delay. We have shared the feedback with the delivery team.', needs: 'delivered', priority: 'NORMAL' },
    { category: 'ORDER_ISSUE', subject: 'Wrong item delivered', body: 'I ordered the veg version but received a different dish.', reply: 'We are sorry. The restaurant has confirmed the mix-up; a refund for the item is being reviewed.', needs: 'delivered', priority: 'HIGH' },
    { category: 'PAYMENT', subject: 'Charged but order was cancelled', body: 'I cancelled within a minute but the amount was debited.', reply: 'The cancellation refund has been initiated and should reflect shortly.', needs: 'issue', priority: 'NORMAL' },
    { category: 'ACCOUNT', subject: 'Unable to update my phone number', body: 'I changed my number and want to move my account to the new one.', reply: 'For security we need to verify both numbers; we will call you on the registered one.', needs: 'none', priority: 'LOW' },
    { category: 'OTHER', subject: 'Request to add a restaurant', body: 'Please add my favourite bakery near home to Thali.', reply: 'Thanks for the suggestion! We have passed it to our restaurant partnerships team.', needs: 'none', priority: 'LOW' },
  ];
  const plan: BlrTicket['status'][] = [...Array(12).fill('OPEN'), ...Array(8).fill('IN_PROGRESS'), ...Array(28).fill('RESOLVED'), ...Array(12).fill('CLOSED')];
  for (let t = 0; t < plan.length; t++) {
    const status = plan[t]!;
    const tpl = r.pick(templates);
    const open = status === 'OPEN' || status === 'IN_PROGRESS';
    const src = tpl.needs === 'issue' ? withIssue : tpl.needs === 'delivered' ? delivered : [];
    const pool = src.filter((co) => (open ? co.dayAgo <= 3 : co.dayAgo > 1));
    const co = pool.length ? r.pick(pool) : null;
    const ch = co ? (co.children.find((x) => (tpl.needs === 'issue' ? x.outcome.kind !== 'DELIVERED' : x.outcome.kind === 'DELIVERED')) ?? co.children[0]!) : null;
    const userId = co ? co.consumer.id : r.pick(w.consumers).id;
    const base = co ? co.lastEventAt.getTime() + r.int(20, 600) * MIN : w.daysAgo(open ? r.int(0, 2) : r.int(3, 20), -r.int(30, 600)).getTime();
    const createdAt = new Date(Math.min(limit - 120 * MIN, base));
    const messages: BlrTicket['messages'] = [{ authorRole: 'CUSTOMER', body: tpl.body, at: createdAt }];
    const history: BlrTicket['history'] = [{ from: null, to: 'OPEN', at: createdAt, actor: 'CUSTOMER' }];
    let last = createdAt.getTime();
    if (status !== 'OPEN') {
      last = Math.min(limit - 60 * MIN, last + r.int(10, 90) * MIN);
      history.push({ from: 'OPEN', to: 'IN_PROGRESS', at: new Date(last), actor: 'ADMIN' });
      messages.push({ authorRole: 'ADMIN', body: tpl.reply, at: new Date(last) });
    }
    if (status === 'RESOLVED' || status === 'CLOSED') {
      last = Math.min(limit - 30 * MIN, last + r.int(30, 600) * MIN);
      history.push({ from: 'IN_PROGRESS', to: 'RESOLVED', at: new Date(last), actor: 'ADMIN' });
      if (status === 'CLOSED') {
        last = Math.min(limit, last + r.int(60, 2000) * MIN);
        messages.push({ authorRole: 'CUSTOMER', body: 'Thanks, that sorted it.', at: new Date(last) });
        history.push({ from: 'RESOLVED', to: 'CLOSED', at: new Date(last), actor: 'CUSTOMER' });
      }
    }
    let code: string;
    do code = `TK-${crockford(r, 8)}`;
    while (codes.has(code));
    codes.add(code);
    out.push({
      t,
      id: seedId(`blr:ticket:${t}`),
      code,
      userId,
      checkout: co,
      child: ch,
      subject: tpl.subject,
      category: tpl.category,
      status,
      priority: tpl.priority,
      messages,
      history,
      createdAt,
      updatedAt: new Date(last),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------- payments helpers --
/** payments `deliveryEarningPaise`: base + ceil(km at 0.01 precision) × per-km. */
export function blrDeliveryEarningPaise(distanceKm: number, basePaise: number, perKmPaise: number): number {
  const hundredths = Math.max(0, Math.round(distanceKm * 100));
  return basePaise + Math.floor((hundredths + 99) / 100) * perKmPaise;
}

export interface BlrLedgerRow {
  key: string;
  kind: 'earning' | 'commission' | 'platform-commission' | 'delivery' | 'payout';
  accountType: 'RESTAURANT' | 'PARTNER' | 'PLATFORM';
  accountId: string;
  entryType: 'ORDER_EARNING' | 'COMMISSION' | 'DELIVERY_EARNING' | 'PAYOUT';
  amountPaise: number;
  dedupeKey: string;
  memo: string;
  childOrderId: string | null;
  deliveryJobId: string | null;
  payoutId: string | null;
  createdBy: string;
  at: Date;
  /** Structural day of the order (payout periods are cut on it). */
  dayAgo: number;
}

/** The four postings `recordDeliveryEarnings` makes for each delivered child (live dedupe keys and memos). */
export function* blrDeliveryLedger(w: BlrWorld, partnerPay: { basePaise: number; perKmPaise: number } = BLR_PARTNER_PAYOUT): Generator<BlrLedgerRow> {
  for (const co of w.checkouts) {
    for (const ch of co.children) {
      if (ch.outcome.kind !== 'DELIVERED') continue;
      const b = ch.breakdown;
      const commission = bpsOf(b.itemsSubtotalPaise, ch.restaurant.commissionBps);
      const jobId = seedId(`blr:delivery-job:${co.n}:${ch.c}`);
      const base = { childOrderId: ch.id, createdBy: 'system:order.delivered', at: ch.timeline.deliveredAt!, dayAgo: co.dayAgo, payoutId: null };
      const k = `${co.n}:${ch.c}`;
      yield { ...base, key: k, kind: 'earning', accountType: 'RESTAURANT', accountId: ch.restaurant.id, entryType: 'ORDER_EARNING', amountPaise: b.itemsSubtotalPaise + b.packagingFeePaise, dedupeKey: `earning:${ch.id}`, memo: `Order earning (items ${b.itemsSubtotalPaise} + packaging ${b.packagingFeePaise}; discounts platform-funded)`, deliveryJobId: null };
      yield { ...base, key: k, kind: 'commission', accountType: 'RESTAURANT', accountId: ch.restaurant.id, entryType: 'COMMISSION', amountPaise: -commission, dedupeKey: `commission:${ch.id}`, memo: `Platform commission ${ch.restaurant.commissionBps} bps of ${b.itemsSubtotalPaise}`, deliveryJobId: null };
      yield { ...base, key: k, kind: 'platform-commission', accountType: 'PLATFORM', accountId: 'platform', entryType: 'COMMISSION', amountPaise: commission, dedupeKey: `platform-commission:${ch.id}`, memo: `Commission from restaurant ${ch.restaurant.id}`, deliveryJobId: null };
      yield {
        ...base, key: k, kind: 'delivery', accountType: 'PARTNER', accountId: ch.partner!.id, entryType: 'DELIVERY_EARNING',
        amountPaise: blrDeliveryEarningPaise(ch.distanceKm, partnerPay.basePaise, partnerPay.perKmPaise), dedupeKey: `delivery:${jobId}`, memo: `Delivery earning (${ch.distanceKm} km)`, deliveryJobId: jobId,
      };
    }
  }
}

export interface BlrPayout {
  id: string;
  k: number;
  accountType: 'RESTAURANT' | 'PARTNER';
  accountId: string;
  amountPaise: number;
  utr: string;
  requestedAt: Date;
  paidAt: Date;
  periodFrom: Date;
  periodTo: Date;
}

/**
 * Weekly settlements: period k covers structural days 7k+1 … 7k+7 ago and is paid (manual bank transfer,
 * UTR) on day 7k at ~10:30 IST (never after the anchor). Amount = the account's net ledger for the period, so
 * balances never go negative and today's / this week's earnings stay "available".
 */
export function blrWeeklyPayouts(w: BlrWorld, partnerPay: { basePaise: number; perKmPaise: number } = BLR_PARTNER_PAYOUT): BlrPayout[] {
  const sums = new Map<string, { accountType: 'RESTAURANT' | 'PARTNER'; accountId: string; byPeriod: Map<number, number> }>();
  for (const e of blrDeliveryLedger(w, partnerPay)) {
    if (e.accountType === 'PLATFORM' || e.dayAgo < 1) continue;
    const k = Math.floor((e.dayAgo - 1) / 7);
    const key = `${e.accountType}:${e.accountId}`;
    let s = sums.get(key);
    if (!s) sums.set(key, (s = { accountType: e.accountType, accountId: e.accountId, byPeriod: new Map() }));
    s.byPeriod.set(k, (s.byPeriod.get(k) ?? 0) + e.amountPaise);
  }
  const banks = ['HDFC', 'ICIC', 'SBIN', 'UTIB', 'KKBK'];
  const out: BlrPayout[] = [];
  const limit = w.anchor.getTime() - 5 * MIN;
  for (const key of [...sums.keys()].sort()) {
    const s = sums.get(key)!;
    for (const k of [...s.byPeriod.keys()].sort((a, b) => a - b)) {
      const amount = s.byPeriod.get(k)!;
      if (amount <= 0) continue;
      const r = rng(`payout:${key}:${k}`);
      const paidAt = new Date(Math.min(limit, w.at(7 * k, 630 + r.int(0, 120)).getTime()));
      const requestedAt = new Date(paidAt.getTime() - r.int(60, 240) * MIN);
      const yd = new Date(paidAt.getTime() + IST_OFFSET);
      const doy = Math.floor((yd.getTime() - Date.UTC(yd.getUTCFullYear(), 0, 1)) / DAY) + 1;
      out.push({
        id: seedId(`blr:payout:${key}:${k}`),
        k,
        accountType: s.accountType,
        accountId: s.accountId,
        amountPaise: amount,
        utr: `${r.pick(banks)}N${String(yd.getUTCFullYear()).slice(2)}${String(doy).padStart(3, '0')}${String(out.length + 1).padStart(7, '0')}`,
        requestedAt,
        paidAt,
        periodFrom: w.at(7 * k + 7, 0),
        periodTo: w.at(7 * k, 0),
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------- summary --
export function blrSummary(w: BlrWorld) {
  const approved = w.restaurants.filter((r) => r.status === 'APPROVED');
  const children = w.checkouts.flatMap((c) => c.children);
  return {
    restaurants: w.restaurants.length,
    approved: approved.length,
    pureVeg: w.restaurants.filter((r) => r.pureVeg).length,
    localities: new Set(w.restaurants.map((r) => r.locality.name)).size,
    owners: w.owners.length,
    multiOwners: w.owners.filter((o) => o.restaurantIdx.length > 1).length,
    items: w.restaurants.reduce((n, r) => n + r.items.length, 0),
    consumers: w.consumers.length,
    addresses: w.consumers.reduce((n, c) => n + c.addresses.length, 0),
    partners: w.partners.length,
    checkouts: w.checkouts.length,
    children: children.length,
    delivered: children.filter((c) => c.outcome.kind === 'DELIVERED').length,
    rejected: children.filter((c) => c.outcome.kind === 'REJECTED').length,
    cancelled: children.filter((c) => c.outcome.kind === 'CANCELLED').length,
    ratings: children.filter((c) => c.rating).length,
    underFiveRatings: approved.filter((r) => r.ratingCount < 5).length,
    couponCheckouts: w.checkouts.filter((c) => c.coupon).length,
    membershipCheckouts: w.checkouts.filter((c) => c.membership).length,
    memberships: w.memberships.length,
    tickets: w.tickets.length,
    gmvPaise: w.checkouts.reduce((n, c) => n + c.totals.totalPaise, 0),
  };
}

/** Sample generated logins (README / report). */
export function blrSampleLogins(w: BlrWorld) {
  return {
    consumers: w.consumers.slice(0, 3).map((c) => ({ phone: c.phone, name: c.name, locality: c.addresses[0]!.locality })),
    owners: w.owners.filter((o) => o.restaurantIdx.length > 1).slice(0, 3).map((o) => ({ phone: o.phone, name: o.name, restaurants: o.restaurantIdx.map((i) => w.restaurants[i]!.name + ' (' + w.restaurants[i]!.locality.name + ')') })),
    partners: w.partners.filter((p) => p.status === 'APPROVED').slice(0, 3).map((p) => ({ phone: p.phone, name: p.name, vehicle: `${p.vehicle.type} ${p.vehicle.registrationNumber}` })),
  };
}

