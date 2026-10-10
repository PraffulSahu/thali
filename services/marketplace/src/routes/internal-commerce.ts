/**
 * Internal commerce API for orders (LLD §8 steps 2, 4, 6) — service token, caller `orders` only.
 *   POST /internal/quote                → { restaurants: QuoteRestaurant[], problems: QuoteProblem[] } (200 even with problems)
 *   POST /internal/coupons/validate     → { code, discountPaise, description, restaurantIds, badgeLabel } | 422 COUPON_INVALID | 422 COUPON_LIMIT_REACHED
 *   POST /internal/memberships/benefits → { membershipId|null, freeDeliveryRestaurantIds, extraDiscountBps, extraDiscountCapPaise }
 *   POST /internal/reservations         → { checkoutId, status, expiresAt } | 409 OUT_OF_STOCK | 422 COUPON_LIMIT_REACHED (idempotent per checkoutId)
 */
import { z } from 'zod';
import { ObjectIdSchema } from '@thali/contracts';
import { requireInternal, validate } from '@thali/service-kit';
import type { RouteModule } from '../context.js';
import { validateCoupon } from '../domain/coupons.js';
import { membershipBenefits } from '../domain/memberships.js';
import { buildQuote } from '../domain/quote.js';
import { reserve } from '../domain/reservations.js';
import { json } from './common.js';

const CALLERS = ['orders'] as const;
const LatLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const Paise = z.number().int().nonnegative();

export const QuoteRequest = z
  .object({
    drop: LatLng.optional().describe('Omitted for cart-add validation: serviceability/fees are then not evaluated'),
    items: z
      .array(
        z.object({
          lineRef: z.string().min(1).max(64).optional().describe("Caller's line id (orders cart line); echoed on the returned line and its problems"),
          restaurantId: ObjectIdSchema,
          itemId: ObjectIdSchema,
          quantity: z.number().int().min(1).max(100),
          selections: z.array(z.object({ groupId: z.string().min(1).max(64), optionIds: z.array(z.string().min(1).max(64)).max(50) })).max(50).default([]),
        }),
      )
      .min(1)
      .max(200),
  })
  .meta({ id: 'QuoteRequest' });

const QuoteProblemCode = z.enum(['RESTAURANT_CLOSED', 'NOT_SERVICEABLE', 'ITEM_UNAVAILABLE', 'INVALID_SELECTION', 'OUT_OF_STOCK']);
export const QuoteProblem = z
  .object({
    code: QuoteProblemCode,
    restaurantId: z.string().optional(),
    itemId: z.string().optional(),
    lineRef: z.string().optional(),
    message: z.string(),
    reason: z.string().optional(),
    groupId: z.string().optional(),
    optionId: z.string().optional(),
    availableQty: z.number().int().optional(),
    nextOpenAt: z.string().optional(),
  })
  .meta({ id: 'QuoteProblem' });

export const QuoteResponse = z
  .object({
    restaurants: z.array(
      z.object({
        restaurantId: z.string(),
        name: z.string(),
        ownerUserId: z.string(),
        location: LatLng.nullable(),
        open: z.boolean(),
        closedReason: z.string().optional(),
        serviceable: z.boolean(),
        serviceabilityChecked: z.boolean().describe('false when no drop point was given'),
        deliveryFeePaise: Paise,
        distanceKm: z.number(),
        etaMinutes: z.number(),
        etaSource: z.string().describe('GOOGLE | DEMO_HAVERSINE | HAVERSINE_FALLBACK | NOT_ESTIMATED'),
        packagingFeePaise: Paise,
        lines: z.array(
          z.object({
            lineRef: z.string().optional(),
            itemId: z.string(),
            name: z.string(),
            isVeg: z.boolean(),
            unitPricePaise: Paise,
            addOns: z.array(z.object({ id: z.string(), name: z.string(), pricePaise: Paise })),
            quantity: z.number().int(),
            available: z.boolean(),
            stockOk: z.boolean(),
          }),
        ),
      }),
    ),
    problems: z.array(QuoteProblem),
  })
  .meta({ id: 'QuoteResponse' });

const CouponValidateBody = z
  .object({
    code: z.string().trim().min(1).max(40),
    userId: z.string().min(1).max(64),
    itemsSubtotalPaise: Paise,
    restaurantSubtotals: z
      .array(z.object({ restaurantId: z.string().min(1).max(64), subtotalPaise: Paise }))
      .max(50)
      .optional()
      .describe('Per-restaurant item subtotals (MKT-8). Required for restaurant-scoped coupons; none eligible → 422 COUPON_INVALID NOT_APPLICABLE'),
  })
  .meta({ id: 'CouponValidateRequest' });
const CouponValidateResponse = z
  .object({
    code: z.string(),
    discountPaise: Paise,
    description: z.string(),
    restaurantIds: z.array(z.string()).describe('Coupon scope; empty = all restaurants (pass to priceCheckout as couponRestaurantIds)'),
    badgeLabel: z.string().nullable(),
  })
  .meta({ id: 'CouponValidateResponse' });

const BenefitsBody = z
  .object({
    userId: z.string().min(1).max(64),
    children: z.array(z.object({ restaurantId: z.string().min(1).max(64), itemsSubtotalPaise: Paise, deliveryFeePaise: Paise })).max(50),
  })
  .meta({ id: 'MembershipBenefitsRequest' });
const BenefitsResponse = z
  .object({
    membershipId: z.string().nullable(),
    freeDeliveryRestaurantIds: z.array(z.string()),
    extraDiscountBps: z.number().int(),
    extraDiscountCapPaise: Paise,
    freeDeliveriesRemaining: z.number().int().optional(),
    endsAt: z.string().nullable().optional(),
  })
  .meta({ id: 'MembershipBenefitsResponse' });

const ReservationBody = z
  .object({
    checkoutId: ObjectIdSchema,
    userId: z.string().min(1).max(64),
    lines: z.array(z.object({ restaurantId: ObjectIdSchema, itemId: ObjectIdSchema, qty: z.number().int().min(1).max(1000) })).min(1).max(200),
    couponCode: z.string().trim().min(1).max(40).optional(),
    couponDiscountPaise: Paise.default(0),
    membership: z.object({ membershipId: z.string().min(1).max(64), freeDeliveries: z.number().int().min(0).max(50), discountPaise: Paise }).optional(),
    ttlSec: z.number().int().min(60).max(3600).default(900),
  })
  .meta({ id: 'ReservationRequest' });
const ReservationResponse = z.object({ checkoutId: z.string(), status: z.enum(['HELD', 'COMMITTED', 'RELEASED']), expiresAt: z.string() }).meta({ id: 'ReservationResponse' });

export const internalCommerceRoutes: RouteModule = {
  name: 'internal-commerce',
  register(r, ctx) {
    const guard = requireInternal([...CALLERS]);

    const vQuote = validate({ body: QuoteRequest });
    r.post('/internal/quote', guard, vQuote, async (req, res) => {
      res.json(await buildQuote(ctx, vQuote.get(req).body));
    });

    const vCoupon = validate({ body: CouponValidateBody });
    r.post('/internal/coupons/validate', guard, vCoupon, async (req, res) => {
      res.json(await validateCoupon(ctx, vCoupon.get(req).body));
    });

    const vBenefits = validate({ body: BenefitsBody });
    r.post('/internal/memberships/benefits', guard, vBenefits, async (req, res) => {
      res.json(await membershipBenefits(ctx, vBenefits.get(req).body));
    });

    const vReserve = validate({ body: ReservationBody });
    r.post('/internal/reservations', guard, vReserve, async (req, res) => {
      res.json(await reserve(ctx, vReserve.get(req).body));
    });
  },
  openapi(api) {
    const base = { tags: ['internal'], security: 'internal' as const };
    api.route({
      ...base,
      method: 'post',
      path: '/internal/quote',
      summary: 'Server quote for orders (LLD §8 step 2): DB prices, open/serviceable, selections, stock. Problems are returned, not thrown.',
      request: { body: { content: json(QuoteRequest) } },
      responses: { 200: { description: 'Quote (check `problems`)', content: json(QuoteResponse) } },
    });
    api.route({
      ...base,
      method: 'post',
      path: '/internal/coupons/validate',
      summary: 'Validate a coupon and compute its discount against Σ itemsSubtotal, or the eligible restaurants\' subtotal for a scoped coupon (LLD §8 step 4, MKT-8)',
      request: { body: { content: json(CouponValidateBody) } },
      responses: { 200: { description: 'Discount', content: json(CouponValidateResponse) } },
      errors: ['COUPON_INVALID', 'COUPON_LIMIT_REACHED'],
    });
    api.route({
      ...base,
      method: 'post',
      path: '/internal/memberships/benefits',
      summary: 'Membership benefits for a checkout (LLD §6 free-delivery selection rule)',
      request: { body: { content: json(BenefitsBody) } },
      responses: { 200: { description: 'Benefits (membershipId null = none)', content: json(BenefitsResponse) } },
    });
    api.route({
      ...base,
      method: 'post',
      path: '/internal/reservations',
      summary: 'Atomically hold stock, coupon and membership usage in one transaction (LLD §8 step 6); idempotent per checkoutId',
      request: { body: { content: json(ReservationBody) } },
      responses: { 200: { description: 'Reservation (replayed for a known checkoutId)', content: json(ReservationResponse) } },
      errors: ['OUT_OF_STOCK', 'COUPON_LIMIT_REACHED', 'COUPON_INVALID', 'ITEM_UNAVAILABLE', 'CONFLICT'],
    });
  },
};
