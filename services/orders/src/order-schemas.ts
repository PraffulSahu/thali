/**
 * Request / response schemas for Task 12 routes (orders, owner, admin, support, internal orders).
 * Validation at the boundary + OpenAPI components (`.meta({ id })`).
 */
import { z } from 'zod';
import {
  AcceptOrderBodySchema,
  ChildOrderStatusSchema,
  CheckoutStatusSchema,
  enumValues,
  ObjectIdSchema,
  PaginationQuerySchema,
  ReasonBodySchema,
  TicketCategory,
  TicketStatus,
} from '@thali/contracts';
import { AddressView, Breakdown, CartView, CheckoutView, ChildOrderView } from './schemas.js';
import { TICKET_PRIORITIES } from './models/support-ticket.js';

const isoString = z.string().meta({ example: '2026-10-10T12:30:00.000Z' });
const nullableIso = isoString.nullable();

// ------------------------------------------------------------------------- params / queries
export const ChildIdParams = z.object({ childId: ObjectIdSchema });
export const CheckoutIdParams = z.object({ checkoutId: ObjectIdSchema });
export const TicketIdParams = z.object({ id: ObjectIdSchema });
export const InternalChildParams = z.object({ id: z.string().min(1).max(64) });

const statusList = z
  .string()
  .trim()
  .min(1)
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(ChildOrderStatusSchema).min(1).max(13))
  .meta({ description: 'Child order status, or a comma-separated list', example: 'PLACED,ACCEPTED' });

export const OwnerOrdersQuery = PaginationQuerySchema.extend({
  restaurantId: z.string().min(1).max(64).optional(),
  status: statusList.optional(),
});

export const StatsQuery = z
  .object({
    restaurantId: z.string().min(1).max(64),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .refine((q) => new Date(q.from).getTime() <= new Date(q.to).getTime(), { message: 'from must not be after to', path: ['from'] });

export const MyOrdersQuery = PaginationQuerySchema.extend({ status: CheckoutStatusSchema.optional() });

export const AdminOrdersQuery = PaginationQuerySchema.extend({
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .meta({
      description:
        'Child or checkout code (TH-…), child/checkout/user id, restaurant name prefix, or a phone (4–13 digits → last-4 match; a digit-only term is always a phone search, and `phone` wins when both are given)',
    }),
  status: statusList.optional(),
  restaurantId: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(64).optional(),
  phone: z.string().trim().min(4).max(20).optional().meta({ description: 'Customer phone (or its last 4+ digits); matched on the last 4 digits of the contact snapshot' }),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

const checkoutStatusList = z
  .string()
  .trim()
  .min(1)
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(CheckoutStatusSchema).min(1).max(8))
  .meta({ description: 'Checkout status, or a comma-separated list (default: every placed checkout)', example: 'PAID_PLACED,IN_PROGRESS' });

export const AdminCheckoutsQuery = PaginationQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  q: AdminOrdersQuery.shape.q.meta({
    description: 'Checkout or child code (TH-…), checkout/child/user/restaurant id, restaurant name prefix, or a phone (4–13 digits → last-4 match)',
  }),
  status: checkoutStatusList.optional(),
  phone: AdminOrdersQuery.shape.phone,
  restaurantId: z.string().min(1).max(64).optional(),
  from: z.iso.datetime({ offset: true }).optional().meta({ description: 'placedAt ≥ from (createdAt for never-placed checkouts)' }),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const TicketsQuery = PaginationQuerySchema.extend({ status: z.enum(enumValues(TicketStatus)).optional() });
export const AdminTicketsQuery = TicketsQuery.extend({
  category: z.enum(enumValues(TicketCategory)).optional(),
  assigneeId: z.string().min(1).max(64).optional(),
});

// ------------------------------------------------------------------------- bodies
export const AcceptBody = AcceptOrderBodySchema.meta({ id: 'AcceptOrderBody' });
export const PrepTimeBody = AcceptOrderBodySchema.meta({ id: 'PrepTimeBody', description: 'Minutes from now until the order is ready (5–120)' });
export const RejectBody = ReasonBodySchema.meta({ id: 'RejectOrderBody' });
export const CustomerCancelBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).meta({ id: 'CustomerCancelBody' });
export const AdminCancelBody = z
  .object({ reason: z.string().trim().min(1).max(500), refundPaise: z.number().int().min(0) })
  .meta({ id: 'AdminCancelBody', description: 'refundPaise must not exceed what is still refundable for the child' });
export const AdminTransitionBody = z
  .object({
    to: ChildOrderStatusSchema,
    reason: z.string().trim().min(1).max(500),
    prepMinutes: z.number().int().min(5).max(120).optional().meta({ description: 'to=ACCEPTED (default: restaurant average)' }),
    refundPaise: z.number().int().min(0).optional().meta({ description: 'Required for to=CANCELLED' }),
  })
  .meta({ id: 'AdminTransitionBody', description: 'Only transitions allowed for ADMIN by the LLD §4.1 table' });

export const CreateTicketBody = z
  .object({
    subject: z.string().trim().min(1).max(200),
    category: z.enum(enumValues(TicketCategory)),
    body: z.string().trim().min(1).max(5000),
    childOrderId: ObjectIdSchema.optional(),
    checkoutGroupId: ObjectIdSchema.optional(),
  })
  .meta({ id: 'CreateTicketBody' });
export const TicketMessageBody = z.object({ body: z.string().trim().min(1).max(5000) }).meta({ id: 'TicketMessageBody' });
export const AdminTicketPatch = z
  .object({
    status: z.enum(enumValues(TicketStatus)).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .meta({ id: 'AdminTicketPatch' });

// ------------------------------------------------------------------------- views
const HistoryEntry = z.object({ from: z.string().nullable(), to: z.string(), actor: z.string(), reason: z.string().nullable(), at: nullableIso });
const PartnerSummary = z.object({ name: z.string(), vehicleType: z.string().nullable() }).nullable();
const Customer = z.object({ name: z.string(), phoneMasked: z.string() });
const Timestamps = {
  placedAt: nullableIso,
  acceptedAt: nullableIso,
  readyAt: nullableIso,
  pickedUpAt: nullableIso,
  deliveredAt: nullableIso,
  cancelledAt: nullableIso,
};

export const OwnerOrderView = z
  .object({
    id: z.string(),
    code: z.string(),
    restaurantId: z.string(),
    restaurantName: z.string(),
    status: ChildOrderStatusSchema,
    lines: ChildOrderView.shape.lines,
    breakdown: Breakdown,
    customer: Customer,
    pickupCode: z.string().meta({ description: 'Give to the delivery partner at pickup' }),
    acceptBy: nullableIso,
    prepMinutes: z.number().int().nullable(),
    readyEta: nullableIso,
    rejectionReason: z.string().nullable(),
    cancellationReason: z.string().nullable(),
    refundStatus: z.string(),
    deliveryStatus: z.string().nullable(),
    partner: PartnerSummary,
    allowedTransitions: z.array(ChildOrderStatusSchema),
    statusHistory: z.array(HistoryEntry),
    ...Timestamps,
    createdAt: nullableIso,
  })
  .meta({ id: 'OwnerOrder' });
export const OwnerOrderPage = z.object({ items: z.array(OwnerOrderView), nextCursor: z.string().nullable() }).meta({ id: 'OwnerOrderPage' });

const RestaurantPoint = z
  .object({
    location: z.object({ lat: z.number(), lng: z.number() }).nullable(),
    address: z.object({ line1: z.string(), locality: z.string().nullable(), city: z.string() }),
  })
  .meta({ id: 'RestaurantPoint', description: 'Where this part of the order is prepared (tracking map origin); no phone' });

export const CustomerChildView = ChildOrderView.extend({
  restaurant: RestaurantPoint,
  prepMinutes: z.number().int().nullable(),
  readyEta: nullableIso,
  rejectionReason: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  refundRequestedPaise: z.number().int(),
  partner: PartnerSummary,
  canCancel: z.boolean(),
  statusHistory: z.array(HistoryEntry),
  ...Timestamps,
}).meta({ id: 'CustomerChildOrder' });

export const Explanation = z
  .object({
    childOrderId: z.string(),
    restaurantName: z.string(),
    kind: z.enum(['REJECTED', 'CANCELLED', 'DELIVERY_FAILED']),
    reason: z.string().nullable(),
    refundPaise: z.number().int(),
    refundStatus: z.string(),
    message: z.string().meta({ example: 'Spice Route declined your order (Out of stock). ₹536.96 refund initiated.' }),
  })
  .meta({ id: 'OrderExplanation' });

export const AdjustedTotals = z
  .object({ paidPaise: z.number().int(), refundedPaise: z.number().int(), refundPendingPaise: z.number().int(), netPaise: z.number().int() })
  .meta({ id: 'AdjustedTotals' });

export const OrderDetail = z
  .object({
    checkout: CheckoutView.extend({ children: z.array(CustomerChildView) }),
    explanations: z.array(Explanation),
    adjustedTotals: AdjustedTotals,
  })
  .meta({ id: 'OrderDetail' });

export const OrderSummary = z
  .object({
    id: z.string(),
    code: z.string(),
    status: CheckoutStatusSchema,
    createdAt: nullableIso,
    placedAt: nullableIso,
    totalPaise: z.number().int(),
    adjustedTotals: AdjustedTotals,
    children: z.array(
      z.object({
        id: z.string(),
        code: z.string(),
        restaurantId: z.string(),
        restaurantName: z.string(),
        status: ChildOrderStatusSchema,
        itemCount: z.number().int(),
        totalPaise: z.number().int(),
        refundStatus: z.string(),
      }),
    ),
  })
  .meta({ id: 'OrderSummary' });
export const OrderPage = z.object({ items: z.array(OrderSummary), nextCursor: z.string().nullable() }).meta({ id: 'OrderPage' });

export const ReorderResponse = z
  .object({
    cart: CartView,
    addedCount: z.number().int(),
    changes: z.array(
      z.object({
        kind: z.enum(['PRICE_CHANGED', 'ITEM_UNAVAILABLE', 'OUT_OF_STOCK', 'INVALID_SELECTION', 'RESTAURANT_CLOSED', 'QUANTITY_LIMIT']),
        restaurantId: z.string(),
        restaurantName: z.string(),
        itemId: z.string(),
        name: z.string(),
        quantity: z.number().int(),
        added: z.boolean(),
        oldUnitPricePaise: z.number().int().optional(),
        newUnitPricePaise: z.number().int().optional(),
        message: z.string(),
      }),
    ),
  })
  .meta({ id: 'ReorderResult' });

export const RestaurantStatsView = z
  .object({
    restaurantId: z.string(),
    from: isoString,
    to: isoString,
    ordersTotal: z.number().int(),
    byStatus: z.record(ChildOrderStatusSchema, z.number().int()),
    acceptanceRate: z.number().nullable(),
    avgAcceptSeconds: z.number().nullable(),
    grossPaise: z.number().int(),
    netRevenuePaise: z.number().int(),
  })
  .meta({ id: 'RestaurantOrderStats' });

export const AdminChildRow = z
  .object({
    id: z.string(),
    code: z.string(),
    checkoutId: z.string(),
    userId: z.string(),
    customer: Customer,
    restaurantId: z.string(),
    restaurantName: z.string(),
    status: ChildOrderStatusSchema,
    totalPaise: z.number().int(),
    refundStatus: z.string(),
    refundedPaise: z.number().int(),
    deliveryStatus: z.string().nullable(),
    acceptBy: nullableIso,
    createdAt: nullableIso,
  })
  .meta({ id: 'AdminOrderRow' });
export const AdminOrderPage = z.object({ items: z.array(AdminChildRow), nextCursor: z.string().nullable() }).meta({ id: 'AdminOrderPage' });

export const AdminCheckoutRow = z
  .object({
    id: z.string(),
    code: z.string().meta({ example: 'TH-DEMOMULTI' }),
    status: CheckoutStatusSchema,
    userId: z.string(),
    placedAt: nullableIso,
    createdAt: nullableIso,
    customer: Customer,
    restaurants: z.array(
      z.object({
        id: z.string().meta({ description: 'Restaurant id' }),
        childOrderId: z.string(),
        childCode: z.string(),
        name: z.string(),
        childStatus: ChildOrderStatusSchema,
        deliveryStatus: z.string().nullable(),
        refundStatus: z.string(),
      }),
    ),
    totalPaise: z.number().int(),
    paidPaise: z.number().int(),
    refundedPaise: z.number().int(),
    refundPendingPaise: z.number().int(),
    attention: z
      .enum(['DELIVERY_FAILED', 'REFUND_FAILED', 'FINDING_PARTNER', 'AWAITING_ACCEPTANCE'])
      .nullable()
      .meta({
        description:
          'Most urgent issue: a child delivery failed › a refund failed › an accepted child has no partner yet › a child awaits restaurant acceptance; null = nothing to do',
      }),
  })
  .meta({ id: 'AdminCheckoutRow' });
export const AdminCheckoutPage = z.object({ items: z.array(AdminCheckoutRow), nextCursor: z.string().nullable() }).meta({ id: 'AdminCheckoutPage' });

export const AdminChildView = CustomerChildView.extend({
  userId: z.string(),
  restaurantOwnerId: z.string(),
  customer: Customer,
  dropAddress: AddressView.nullable(),
  pickupCode: z.string(),
  commissionBps: z.number().int(),
  deliveryJobId: z.string().nullable(),
  deliveryDistanceKm: z.number().nullable(),
  deliveryFailureReason: z.string().nullable(),
  partner: z
    .object({ partnerId: z.string(), partnerUserId: z.string(), name: z.string(), vehicle: z.object({ type: z.string(), registrationNumber: z.string() }) })
    .nullable(),
  refunds: z.array(z.object({ refundId: z.string(), amountPaise: z.number().int(), reason: z.string(), status: z.string(), updatedAt: nullableIso })),
  statusHistory: z.array(HistoryEntry.extend({ actorId: z.string().nullable() })),
}).meta({ id: 'AdminChildOrder' });

export const AdminOrderDetail = z
  .object({
    checkout: CheckoutView.extend({ userId: z.string(), statusHistory: z.array(HistoryEntry), children: z.array(AdminChildView) }),
    explanations: z.array(Explanation),
    adjustedTotals: AdjustedTotals,
    timeline: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        childOrderId: z.string().nullable(),
        actor: z.string(),
        actorId: z.string().nullable(),
        data: z.record(z.string(), z.unknown()),
        at: nullableIso,
      }),
    ),
  })
  .meta({ id: 'AdminOrderDetail' });

export const OrdersOverview = z
  .object({
    generatedAt: isoString,
    today: z.object({
      since: isoString,
      checkouts: z.number().int(),
      placed: z.number().int(),
      delivered: z.number().int(),
      rejected: z.number().int(),
      cancelled: z.number().int(),
      gmvPaise: z.number().int(),
      byStatus: z
        .record(ChildOrderStatusSchema, z.number().int())
        .meta({ description: 'Child orders placed today (IST) by their current status — every status key present' }),
      refundedPaise: z.number().int().meta({ description: 'Refunds that succeeded today (child refund mirror entries)' }),
    }),
    activeByStatus: z.record(z.string(), z.number().int()),
    awaitingAcceptance: z.number().int(),
    overdueAcceptance: z.number().int(),
    deliveryFailed: z.number().int(),
    refundsPending: z.number().int().meta({ description: 'All-time: child orders whose refund is REQUESTED / PROCESSING / FAILED' }),
    refundsPendingPaise: z
      .number()
      .int()
      .meta({ description: 'All-time: outstanding refund amount (requested − refunded) of the same children counted by refundsPending' }),
    refundsFailed: z.number().int(),
    support: z.object({ open: z.number().int(), inProgress: z.number().int() }).meta({ description: 'Support ticket counts (sidebar badge)' }),
  })
  .meta({ id: 'OrdersOverview' });

export const TicketView = z
  .object({
    id: z.string(),
    code: z.string().meta({ example: 'TK-7K3M9QXA' }),
    userId: z.string(),
    childOrderId: z.string().nullable(),
    checkoutGroupId: z.string().nullable(),
    subject: z.string(),
    category: z.enum(enumValues(TicketCategory)),
    status: z.enum(enumValues(TicketStatus)),
    priority: z.enum(TICKET_PRIORITIES),
    assigneeId: z.string().nullable(),
    messages: z.array(z.object({ authorId: z.string(), authorRole: z.enum(['CUSTOMER', 'ADMIN']), body: z.string(), at: nullableIso })),
    createdAt: nullableIso,
    updatedAt: nullableIso,
  })
  .meta({ id: 'SupportTicket' });
export const TicketPage = z.object({ items: z.array(TicketView), nextCursor: z.string().nullable() }).meta({ id: 'SupportTicketPage' });

export const InternalChildOrder = z
  .object({
    id: z.string(),
    code: z.string(),
    checkoutGroupId: z.string(),
    /** Parent checkout code (TH-…) — delivery's fallback for `order.accepted.checkoutCode`. */
    checkoutCode: z.string().nullable(),
    userId: z.string(),
    restaurantId: z.string(),
    restaurantOwnerId: z.string(),
    status: ChildOrderStatusSchema,
    deliveredAt: nullableIso,
    /** Child total (paise) — the per-child refund cap. */
    totalPaise: z.number().int(),
    /** max(refundRequestedPaise, non-FAILED refunds seen) for this child. */
    committedRefundPaise: z.number().int(),
  })
  .meta({ id: 'InternalChildOrder' });

export const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
