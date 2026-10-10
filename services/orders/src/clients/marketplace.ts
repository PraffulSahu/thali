/**
 * Marketplace internal client (LLD §8 steps 2, 4, 6 + binding `GET /internal/restaurants/:id`).
 * Interface injected into `buildApp(deps)`; the real implementation signs service tokens via
 * service-kit `internalClient`. Responses are zod-validated (drift → 502 UPSTREAM_ERROR).
 *
 * Where LLD §8 leaves a response shape open, the shape below is what orders codes against
 * (listed under "Contract gaps" in the Task 11 report).
 */
import { z } from 'zod';
import { DomainError, type Selection } from '@thali/contracts';
import { internalClient, UpstreamError } from '@thali/service-kit';
import type { OrdersConfig } from '../config.js';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface QuoteItemInput {
  /** Opaque line reference (the cart line id); marketplace echoes it on the matching quote line. */
  lineRef?: string;
  restaurantId: string;
  itemId: string;
  quantity: number;
  selections: Selection[];
}
/** `drop` is omitted for cart-add validation (no address yet): serviceability/fees are then not evaluated. */
export interface QuoteRequest {
  drop?: LatLng;
  items: QuoteItemInput[];
}

export const QUOTE_PROBLEM_CODES = ['RESTAURANT_CLOSED', 'NOT_SERVICEABLE', 'ITEM_UNAVAILABLE', 'INVALID_SELECTION', 'OUT_OF_STOCK'] as const;
export type QuoteProblemCode = (typeof QUOTE_PROBLEM_CODES)[number];

/** Accepts `{lat,lng}` or a GeoJSON Point and yields `{lat,lng}`. */
const LatLngLike = z.union([
  z.object({ lat: z.number(), lng: z.number() }),
  z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) }).transform((g) => ({
    lat: g.coordinates[1],
    lng: g.coordinates[0],
  })),
]);

const QuoteAddOnSchema = z.object({ id: z.string(), name: z.string(), pricePaise: z.number().int().nonnegative() });
const QuoteLineSchema = z.object({
  lineRef: z.string().optional(),
  itemId: z.string(),
  name: z.string(),
  isVeg: z.boolean().default(false),
  unitPricePaise: z.number().int().nonnegative(),
  addOns: z.array(QuoteAddOnSchema).default([]),
  // required: a missing availability/stock flag is schema drift (→ 502), never "available"
  available: z.boolean(),
  stockOk: z.boolean(),
});
const QuoteRestaurantSchema = z.object({
  restaurantId: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  location: LatLngLike,
  open: z.boolean(),
  serviceable: z.boolean(),
  deliveryFeePaise: z.number().int().nonnegative(),
  distanceKm: z.number().nonnegative().default(0),
  etaMinutes: z.number().nonnegative().default(0),
  etaSource: z.string().default('DEMO_HAVERSINE'),
  packagingFeePaise: z.number().int().nonnegative(),
  lines: z.array(QuoteLineSchema),
});
const QuoteProblemSchema = z.object({
  code: z.enum(QUOTE_PROBLEM_CODES),
  restaurantId: z.string().optional(),
  itemId: z.string().optional(),
  message: z.string().default(''),
});
export const QuoteResponseSchema = z.object({
  restaurants: z.array(QuoteRestaurantSchema).default([]),
  problems: z.array(QuoteProblemSchema).default([]),
});

export type QuoteAddOn = z.output<typeof QuoteAddOnSchema>;
export type QuoteLine = z.output<typeof QuoteLineSchema>;
export type QuoteRestaurant = z.output<typeof QuoteRestaurantSchema>;
export type QuoteProblem = z.output<typeof QuoteProblemSchema>;
export type QuoteResponse = z.output<typeof QuoteResponseSchema>;

export interface CouponValidateRequest {
  code: string;
  userId: string;
  itemsSubtotalPaise: number;
  /** Contract 1 (MKT-8): per-restaurant item subtotals so marketplace can apply a restaurant-scoped coupon. */
  restaurantSubtotals?: { restaurantId: string; subtotalPaise: number }[];
}
const CouponValidateResponseSchema = z.object({
  code: z.string().optional(),
  discountPaise: z.number().int().nonnegative(),
  /** Restaurants the coupon applies to; empty (or absent, pre-MKT-8 marketplace) = all restaurants. */
  restaurantIds: z.array(z.string()).default([]),
  badgeLabel: z.string().nullable().default(null),
});
export type CouponValidateResponse = z.output<typeof CouponValidateResponseSchema>;

export interface MembershipBenefitsRequest {
  userId: string;
  children: { restaurantId: string; itemsSubtotalPaise: number; deliveryFeePaise: number }[];
}
const MembershipBenefitsResponseSchema = z.object({
  membershipId: z.string().nullable().default(null),
  freeDeliveryRestaurantIds: z.array(z.string()).default([]),
  extraDiscountBps: z.number().int().nonnegative().default(0),
  extraDiscountCapPaise: z.number().int().nonnegative().default(0),
});
export type MembershipBenefitsResponse = z.output<typeof MembershipBenefitsResponseSchema>;

export interface ReservationRequest {
  checkoutId: string;
  userId: string;
  lines: { restaurantId: string; itemId: string; qty: number }[];
  couponCode?: string;
  couponDiscountPaise: number;
  membership?: { membershipId: string; freeDeliveries: number; discountPaise: number };
  ttlSec: number;
}
const ReservationResponseSchema = z.object({
  checkoutId: z.string(),
  status: z.string(),
  expiresAt: z.string().optional(),
});
export type ReservationResponse = z.output<typeof ReservationResponseSchema>;

const InternalRestaurantSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  name: z.string(),
  status: z.string(),
  location: LatLngLike,
  address: z.object({ line1: z.string(), line2: z.string().optional(), city: z.string(), pincode: z.string() }),
  phone: z.string().nullable().optional(),
  commissionBps: z.number().int().nonnegative(),
  packagingFeePaise: z.number().int().nonnegative(),
  avgPrepMinutes: z.number().nonnegative(),
});
export type InternalRestaurant = z.output<typeof InternalRestaurantSchema>;

export interface MarketplaceClient {
  /** `POST /internal/quote` */
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  /** `POST /internal/coupons/validate` — invalid coupon → 422 COUPON_INVALID (thrown; `{reason:'NOT_APPLICABLE'}` when no listed restaurant is in the order). */
  validateCoupon(req: CouponValidateRequest): Promise<CouponValidateResponse>;
  /** `POST /internal/memberships/benefits` */
  membershipBenefits(req: MembershipBenefitsRequest): Promise<MembershipBenefitsResponse>;
  /** `POST /internal/reservations` — 409 OUT_OF_STOCK / 422 COUPON_LIMIT_REACHED (thrown); idempotent per checkoutId. */
  reserve(req: ReservationRequest): Promise<ReservationResponse>;
  /** `GET /internal/restaurants/:id` — null on 404. */
  getRestaurant(id: string): Promise<InternalRestaurant | null>;
}

export function createMarketplaceClient(config: OrdersConfig): MarketplaceClient {
  const http = internalClient('marketplace', config.MARKETPLACE_URL, {
    from: 'orders',
    secret: config.INTERNAL_SERVICE_SECRET,
    timeoutMs: config.INTERNAL_HTTP_TIMEOUT_MS,
  });
  return {
    quote: (req) => http.post('/internal/quote', req, { schema: QuoteResponseSchema }),
    validateCoupon: (req) => http.post('/internal/coupons/validate', req, { schema: CouponValidateResponseSchema }),
    membershipBenefits: (req) => http.post('/internal/memberships/benefits', req, { schema: MembershipBenefitsResponseSchema }),
    reserve: (req) => http.post('/internal/reservations', req, { schema: ReservationResponseSchema }),
    async getRestaurant(id) {
      try {
        return await http.get(`/internal/restaurants/${encodeURIComponent(id)}`, { schema: InternalRestaurantSchema });
      } catch (e) {
        if (e instanceof UpstreamError && e.upstreamStatus === 404) return null;
        if (e instanceof DomainError && e.code === 'NOT_FOUND') return null;
        throw e;
      }
    },
  };
}
