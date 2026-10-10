/**
 * Request/response schemas shared by route validation and the OpenAPI document.
 */
import { z } from 'zod';
import {
  DemoPayCompleteSchema,
  LedgerAccountType,
  LedgerEntryType,
  ObjectIdSchema,
  PaginationQuerySchema,
  PaymentPurposeSchema,
  PaymentStatus,
  PayoutStatus,
  RefundReasonSchema,
  RefundStatus,
  enumValues,
} from '@thali/contracts';

const Paise = z.number().int().nonnegative();
const PositivePaise = z.number().int().positive().max(100_000_000_00);
const Iso = z.string();
const Id = z.string().min(1).max(64);

export const PaymentStatusSchema = z.enum(enumValues(PaymentStatus));
export const RefundStatusSchema = z.enum(enumValues(RefundStatus));
export const PayoutStatusSchema = z.enum(enumValues(PayoutStatus));
export const LedgerAccountTypeSchema = z.enum(enumValues(LedgerAccountType));
export const PayoutAccountTypeSchema = z.enum(['RESTAURANT', 'PARTNER']);

// ---- intents (internal) ----
export const IntentCreateBody = z
  .object({ purpose: PaymentPurposeSchema, referenceId: Id, userId: Id, amountPaise: PositivePaise })
  .meta({ id: 'PaymentIntentCreate' });

export const IntentViewSchema = z
  .object({
    paymentIntentId: z.string(),
    provider: z.enum(['razorpay', 'mock']),
    providerOrderId: z.string(),
    keyId: z.string().nullable(),
    amountPaise: Paise,
    currency: z.literal('INR'),
    status: PaymentStatusSchema,
    demoPayUrl: z.string().nullable(),
  })
  .meta({ id: 'PaymentIntent' });

export const ReconcileResultSchema = z
  .object({ paymentIntentId: z.string(), status: PaymentStatusSchema, capturedPaise: Paise, refundedPaise: Paise, refundReservedPaise: Paise })
  .meta({ id: 'ReconcileResult' });

export const IntentIdParams = z.object({ id: Id });
export const ByReferenceParams = z.object({ purpose: PaymentPurposeSchema, refId: Id });

// ---- customer ----
export const PaymentStatusViewSchema = IntentViewSchema.extend({
  purpose: PaymentPurposeSchema,
  referenceId: z.string(),
  capturedPaise: Paise,
  refundedPaise: Paise,
  failureReason: z.string().nullable(),
  isDemo: z.boolean(),
}).meta({ id: 'PaymentStatus' });

export const CheckoutParams = z.object({ checkoutId: Id });
export const VerifyParams = z.object({ intentId: ObjectIdSchema });
export const VerifyBody = z
  .object({
    razorpay_payment_id: z.string().min(1).max(64),
    razorpay_order_id: z.string().min(1).max(64),
    razorpay_signature: z.string().min(1).max(256),
  })
  .meta({ id: 'PaymentVerifyBody' });

// ---- demo pay ----
export const DemoPayViewSchema = z
  .object({
    paymentIntentId: z.string(),
    purpose: PaymentPurposeSchema,
    referenceId: z.string(),
    amountPaise: Paise,
    currency: z.literal('INR'),
    status: PaymentStatusSchema,
    providerOrderId: z.string(),
    isDemo: z.literal(true),
  })
  .meta({ id: 'DemoPayIntent' });
export const DemoPayCompleteBody = DemoPayCompleteSchema.meta({ id: 'DemoPayComplete' });
export const DemoPayResultSchema = z
  .object({
    paymentIntentId: z.string(),
    status: PaymentStatusSchema,
    simulated: z.literal(true),
    webhooks: z.array(z.object({ eventId: z.string(), type: z.string(), result: z.string() })),
  })
  .meta({ id: 'DemoPayResult' });

// ---- webhook ----
export const WebhookAckSchema = z
  .object({
    status: z.literal('ok'),
    eventId: z.string(),
    result: z.enum(['APPLIED', 'IGNORED_DUPLICATE', 'IGNORED_STALE', 'REJECTED_MISMATCH', 'IGNORED_UNKNOWN']),
  })
  .meta({ id: 'WebhookAck' });

// ---- finance ----
/** PAY-1: optional earnings window (ISO instants; default today in Asia/Kolkata). */
export const SummaryWindowQuery = z
  .object({ from: z.iso.datetime({ offset: true }).pipe(z.coerce.date()).optional(), to: z.iso.datetime({ offset: true }).pipe(z.coerce.date()).optional() })
  .meta({ id: 'SummaryWindowQuery' });

export const EarningsWindowSchema = z
  .object({
    from: Iso,
    to: Iso,
    earningsPaise: z.number().int(),
    entriesByType: z.record(z.enum(enumValues(LedgerEntryType)), z.number().int()),
    deliveries: z.number().int().nonnegative(),
  })
  .meta({ id: 'EarningsWindow' });

export const AccountSummarySchema = z
  .object({
    accountType: LedgerAccountTypeSchema,
    accountId: z.string(),
    balancePaise: z.number().int(),
    availablePaise: z.number().int(),
    pendingPayoutPaise: Paise,
    paidOutPaise: Paise,
    holdDays: z.number().int(),
    totalsByType: z.record(z.enum(enumValues(LedgerEntryType)), z.number().int()),
    asOf: Iso,
  })
  .meta({ id: 'AccountSummary' });

/** Owner/partner finance summary: the account summary plus the PAY-1 earnings window. */
export const FinanceSummarySchema = AccountSummarySchema.extend({ window: EarningsWindowSchema }).meta({ id: 'FinanceSummary' });

export const LedgerEntryViewSchema = z
  .object({
    id: z.string(),
    accountType: LedgerAccountTypeSchema,
    accountId: z.string(),
    entryType: z.enum(enumValues(LedgerEntryType)),
    amountPaise: z.number().int(),
    childOrderId: z.string().nullable(),
    deliveryJobId: z.string().nullable(),
    payoutId: z.string().nullable(),
    refundId: z.string().nullable(),
    memo: z.string(),
    isDemo: z.boolean(),
    createdAt: Iso,
  })
  .meta({ id: 'LedgerEntry' });

export const PayoutViewSchema = z
  .object({
    id: z.string(),
    accountType: PayoutAccountTypeSchema,
    accountId: z.string(),
    amountPaise: Paise,
    status: PayoutStatusSchema,
    method: z.literal('MANUAL_BANK_TRANSFER'),
    utr: z.string().nullable(),
    requestedBy: z.string(),
    confirmedBy: z.string().nullable(),
    confirmedAt: Iso.nullable(),
    failureReason: z.string().nullable(),
    notes: z.string().nullable(),
    isDemo: z.boolean(),
    createdAt: Iso,
    updatedAt: Iso,
  })
  .meta({ id: 'Payout' });

export const RefundViewSchema = z
  .object({
    id: z.string(),
    paymentIntentId: z.string(),
    checkoutGroupId: z.string(),
    childOrderId: z.string().nullable(),
    restaurantId: z.string().nullable(),
    amountPaise: Paise,
    reason: RefundReasonSchema,
    status: RefundStatusSchema,
    providerRefundId: z.string().nullable(),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    nextAttemptAt: Iso.nullable(),
    lastError: z.string().nullable(),
    requestedBy: z.string(),
    note: z.string().nullable(),
    chargeRestaurantPaise: Paise,
    isDemo: z.boolean(),
    statusHistory: z.array(z.object({ from: z.string().nullable(), to: z.string(), at: Iso, source: z.string().optional() })),
    createdAt: Iso,
    updatedAt: Iso,
  })
  .meta({ id: 'Refund' });

export const AdminPaymentViewSchema = PaymentStatusViewSchema.extend({
  userId: z.string(),
  providerPaymentId: z.string().nullable(),
  refundReservedPaise: Paise,
  lastReconciledAt: Iso.nullable(),
  createdAt: Iso,
}).meta({ id: 'AdminPayment' });

export const page = <T extends z.ZodType>(item: T, id: string) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() }).meta({ id });

export const RestaurantParams = z.object({ restaurantId: Id });
export const PageQuery = PaginationQuerySchema;

// ---- admin ----
export const ManualRefundBody = z
  .object({
    paymentIntentId: ObjectIdSchema,
    childOrderId: Id.optional(),
    restaurantId: Id.optional(),
    amountPaise: PositivePaise,
    reason: z.enum(['ADMIN', 'DELIVERY_FAILED', 'CUSTOMER_CANCELLED']).default('ADMIN'),
    note: z.string().trim().min(1).max(500),
    chargeRestaurantPaise: Paise.default(0),
  })
  .refine((b) => b.chargeRestaurantPaise <= b.amountPaise, { message: 'chargeRestaurantPaise cannot exceed amountPaise', path: ['chargeRestaurantPaise'] })
  .refine((b) => b.chargeRestaurantPaise === 0 || !!b.restaurantId, { message: 'restaurantId is required when charging the restaurant', path: ['restaurantId'] })
  .meta({ id: 'ManualRefundBody' });

export const RefundIdParams = z.object({ id: ObjectIdSchema });
export const RefundListQuery = PaginationQuerySchema.extend({ status: RefundStatusSchema.optional() });
export const BalancesQuery = z.object({
  accountType: LedgerAccountTypeSchema,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
});
export const PayoutCreateBody = z
  .object({ accountType: PayoutAccountTypeSchema, accountId: Id, amountPaise: PositivePaise, notes: z.string().trim().max(500).optional() })
  .meta({ id: 'PayoutCreateBody' });
export const PayoutIdParams = z.object({ id: ObjectIdSchema });
export const PayoutConfirmBody = z
  .object({ utr: z.string().trim().regex(/^[A-Za-z0-9]{6,32}$/, 'UTR must be 6–32 letters/digits') })
  .meta({ id: 'PayoutConfirmBody' });
export const PayoutFailBody = z.object({ reason: z.string().trim().min(3).max(500) }).meta({ id: 'PayoutFailBody' });
export const PayoutListQuery = PaginationQuerySchema.extend({
  status: PayoutStatusSchema.optional(),
  accountType: PayoutAccountTypeSchema.optional(),
  accountId: Id.optional(),
});
export const PaymentsSearchQuery = PaginationQuerySchema.extend({ q: z.string().trim().max(64).optional(), status: PaymentStatusSchema.optional() });
