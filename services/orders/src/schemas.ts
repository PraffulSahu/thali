/**
 * Request/response zod schemas for orders routes (validation + OpenAPI). Named with `.meta({ id })`
 * so zod-to-openapi emits components.
 */
import { z } from 'zod';
import {
  AddressSchema,
  BreakdownSchema,
  CartItemInputSchema,
  CartItemUpdateSchema,
  CheckoutStatusSchema,
  ChildOrderStatusSchema,
  CreateCheckoutBodySchema,
  GeoPointSchema,
  ObjectIdSchema,
  RestaurantIdsSubsetSchema,
  SelectionSchema,
} from '@thali/contracts';
import { QUOTE_PROBLEM_CODES } from './clients/marketplace.js';

export const Breakdown = BreakdownSchema.meta({ id: 'Breakdown' });
export const CartItemInput = CartItemInputSchema.meta({ id: 'CartItemInput' });
export const CartItemUpdate = CartItemUpdateSchema.meta({ id: 'CartItemUpdate' });
/**
 * Contracts body + `couponCode: null` (= no coupon, like the cart preview). Absent = the cart's coupon;
 * on a subset checkout a cart coupon that does not apply to the selected restaurants is dropped.
 */
export const CreateCheckoutBody = z
  .object({
    ...CreateCheckoutBodySchema.shape,
    couponCode: z.string().trim().min(1).max(40).nullable().optional().meta({ description: 'null = no coupon; absent = the cart coupon' }),
  })
  .refine((v) => (v.addressId === undefined) !== (v.address === undefined), {
    message: 'Provide exactly one of addressId or address',
    path: ['addressId'],
  })
  .meta({ id: 'CreateCheckoutBody' });
export type CreateCheckoutBody = z.infer<typeof CreateCheckoutBody>;

export const AddOnView = z.object({ id: z.string(), name: z.string(), pricePaise: z.number().int() }).meta({ id: 'AddOn' });

export const AddressView = z
  .object({
    addressId: z.string().nullable(),
    label: z.string().nullable(),
    line1: z.string(),
    line2: z.string().nullable(),
    landmark: z.string().nullable(),
    locality: z.string().nullable().meta({ description: 'Neighbourhood, e.g. "Indiranagar" (null for addresses saved before it existed)' }),
    city: z.string(),
    pincode: z.string(),
    location: GeoPointSchema,
  })
  .meta({ id: 'AddressSnapshot' });

export const DeliveryMode = z
  .object({ mode: z.literal('SEPARATE'), note: z.string().meta({ example: 'Delivered separately by restaurant' }) })
  .meta({ id: 'DeliveryMode' });

export const CartLineView = z
  .object({
    lineId: z.string(),
    restaurantId: z.string(),
    itemId: z.string(),
    name: z.string(),
    isVeg: z.boolean(),
    unitPricePaise: z.number().int(),
    addOns: z.array(AddOnView),
    selections: z.array(SelectionSchema),
    quantity: z.number().int().min(1).max(20),
    note: z.string().nullable(),
    lineTotalPaise: z.number().int(),
  })
  .meta({ id: 'CartLine' });

export const CartView = z
  .object({
    id: z.string().nullable(),
    ownerType: z.enum(['USER', 'GUEST']),
    cartVersion: z.number().int(),
    groups: z.array(
      z.object({
        restaurantId: z.string(),
        restaurantName: z.string(),
        lines: z.array(CartLineView),
        subtotalPaise: z.number().int(),
        itemCount: z.number().int(),
        delivery: DeliveryMode,
      }),
    ),
    restaurantCount: z.number().int(),
    itemCount: z.number().int(),
    subtotalPaise: z.number().int(),
    deliveryAddress: AddressView.nullable(),
    couponCode: z.string().nullable(),
    expiresAt: z.string().nullable(),
    deliveryExplanation: z.string().nullable(),
  })
  .meta({ id: 'Cart' });

export const AddItemResponse = z.object({ lineId: z.string(), cart: CartView }).meta({ id: 'AddCartItemResponse' });
export const GuestTokenResponse = z
  .object({ guestToken: z.string().meta({ description: '32 random bytes, base64url; send as X-Guest-Cart' }), expiresAt: z.string() })
  .meta({ id: 'GuestCartToken' });
export const SetAddressBody = z.object({ addressId: z.string().min(1).max(64).optional(), address: AddressSchema }).meta({ id: 'SetCartAddressBody' });
export const SetCouponBody = z.object({ couponCode: z.string().trim().min(1).max(40).nullable() }).meta({ id: 'SetCartCouponBody' });
export const MergeBody = z.object({ guestToken: z.string().min(1).max(128) }).meta({ id: 'CartMergeBody' });
export const MergeResponse = z.object({ merged: z.boolean(), lineCount: z.number().int() }).meta({ id: 'CartMergeResponse' });
export const InternalMergeBody = z.object({ userId: z.string().min(1).max(64), guestToken: z.string().min(1).max(128) }).meta({ id: 'InternalCartMergeBody' });
export const PreviewBody = z
  .object({
    addressId: z.string().optional(),
    address: AddressSchema.optional(),
    couponCode: z.string().trim().min(1).max(40).nullable().optional(),
    useMembership: z.boolean().optional(),
    restaurantIds: RestaurantIdsSubsetSchema.optional().meta({
      description: 'Preview only these restaurants of the cart (1–10, e.g. "Checkout only Spice Route"); absent = the whole cart',
    }),
  })
  .meta({ id: 'CartPreviewBody' });

export const QuoteProblemView = z
  .object({ code: z.enum(QUOTE_PROBLEM_CODES), restaurantId: z.string().optional(), itemId: z.string().optional(), message: z.string() })
  .meta({ id: 'QuoteProblem' });

const PricedChild = z.object({
  restaurantId: z.string(),
  restaurantName: z.string(),
  lines: z.array(
    z.object({
      lineId: z.string(),
      itemId: z.string(),
      name: z.string(),
      unitPricePaise: z.number().int(),
      addOns: z.array(AddOnView),
      quantity: z.number().int(),
      lineTotalPaise: z.number().int(),
    }),
  ),
  breakdown: Breakdown,
  distanceKm: z.number(),
  etaMinutes: z.number(),
  etaSource: z.string(),
  delivery: DeliveryMode,
});

export const PreviewResponse = z
  .object({
    cartVersion: z.number().int(),
    deliveryAddress: AddressView.nullable(),
    pricing: Breakdown,
    children: z.array(PricedChild),
    problems: z.array(QuoteProblemView),
    canCheckout: z.boolean(),
    coupon: z
      .object({
        code: z.string(),
        valid: z.boolean(),
        discountPaise: z.number().int(),
        restaurantIds: z.array(z.string()).meta({ description: 'Restaurants the coupon applies to; empty = every restaurant in the order' }),
        message: z.string().optional(),
      })
      .nullable(),
    membership: z.object({ applied: z.boolean(), membershipId: z.string().nullable() }).nullable(),
    deliveryExplanation: z.string().nullable(),
  })
  .meta({ id: 'CartPreview' });

export const ChildOrderView = z
  .object({
    id: z.string(),
    code: z.string().meta({ example: 'TH-7K3M9QXA' }),
    restaurantId: z.string(),
    restaurantName: z.string(),
    status: ChildOrderStatusSchema,
    lines: z.array(
      z.object({
        itemId: z.string(),
        name: z.string(),
        isVeg: z.boolean(),
        unitPricePaise: z.number().int(),
        addOns: z.array(AddOnView),
        selections: z.array(SelectionSchema),
        quantity: z.number().int(),
        note: z.string().nullable(),
        lineTotalPaise: z.number().int(),
      }),
    ),
    breakdown: Breakdown,
    acceptBy: z.string().nullable(),
    placedAt: z.string().nullable(),
    deliveryCode: z.string().meta({ description: 'Share with the delivery partner at drop-off' }),
    refundStatus: z.string(),
    refundedPaise: z.number().int(),
    deliveryStatus: z.string().nullable(),
    eta: z.object({ distanceKm: z.number().nullable(), etaMinutes: z.number().nullable(), etaSource: z.string().nullable() }),
    delivery: DeliveryMode,
  })
  .meta({ id: 'ChildOrder' });

export const CheckoutView = z
  .object({
    id: z.string(),
    code: z.string(),
    status: CheckoutStatusSchema,
    cartVersion: z.number().int(),
    createdAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    placedAt: z.string().nullable(),
    deliveryAddress: AddressView.nullable(),
    pricing: Breakdown,
    couponCode: z.string().nullable(),
    membershipId: z.string().nullable(),
    paymentIntentId: z.string().nullable(),
    paymentStatus: z.string(),
    isDemo: z.boolean(),
    deliveryExplanation: z.string().nullable(),
    children: z.array(ChildOrderView),
  })
  .meta({ id: 'Checkout' });

export const PaymentView = z
  .object({
    intentId: z.string(),
    provider: z.enum(['razorpay', 'mock']),
    providerOrderId: z.string(),
    keyId: z.string().nullable(),
    amountPaise: z.number().int(),
    currency: z.literal('INR'),
    demoPayUrl: z.string().nullable(),
  })
  .meta({ id: 'CheckoutPayment' });

export const CheckoutResponse = z.object({ checkout: CheckoutView, payment: PaymentView }).meta({ id: 'CheckoutResponse' });
export const CheckoutGetResponse = z.object({ checkout: CheckoutView, payment: PaymentView.nullable() }).meta({ id: 'CheckoutWithPayment' });

export const CheckoutStatusResponse = z
  .object({ id: z.string(), status: CheckoutStatusSchema, paymentIntentId: z.string().nullable() })
  .meta({ id: 'InternalCheckoutStatus' });

export const IdParams = z.object({ id: ObjectIdSchema });
export const LineIdParams = z.object({ lineId: ObjectIdSchema });

export const GuestHeader = z.object({
  'x-guest-cart': z.string().optional().meta({ description: 'Guest cart token (when not signed in)' }),
});
