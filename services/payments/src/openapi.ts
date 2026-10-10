/** OpenAPI registry for every payments route (served at /openapi.json, /docs). */
import { z } from 'zod';
import { createOpenApi, registerOpsRoutes } from '@thali/service-kit';
import {
  AccountSummarySchema,
  AdminPaymentViewSchema,
  BalancesQuery,
  ByReferenceParams,
  CheckoutParams,
  DemoPayCompleteBody,
  DemoPayResultSchema,
  DemoPayViewSchema,
  IntentCreateBody,
  IntentIdParams,
  IntentViewSchema,
  LedgerEntryViewSchema,
  ManualRefundBody,
  PageQuery,
  PaymentStatusViewSchema,
  PaymentsSearchQuery,
  PayoutConfirmBody,
  PayoutCreateBody,
  PayoutFailBody,
  PayoutIdParams,
  PayoutListQuery,
  PayoutViewSchema,
  ReconcileResultSchema,
  RefundIdParams,
  RefundListQuery,
  RefundViewSchema,
  RestaurantParams,
  VerifyBody,
  VerifyParams,
  WebhookAckSchema,
  page,
} from './schemas.js';

export const openapi = createOpenApi('payments', {
  description:
    'Payment intents (Razorpay Orders API or demo mock), signed webhooks, reconciliation, refunds, ledger and recorded payouts. Money is integer paise.',
});

const json = (schema: z.ZodType, description: string) => ({ description, content: { 'application/json': { schema } } });
const body = (schema: z.ZodType) => ({ body: { content: { 'application/json': { schema } }, required: true } });

registerOpsRoutes(openapi);

// ---- webhook ----
openapi.route({
  method: 'post',
  path: '/api/v1/webhooks/razorpay',
  tags: ['webhooks'],
  summary: 'Razorpay webhook (raw body; X-Razorpay-Signature = hex HMAC-SHA256 of the exact bytes)',
  description:
    'Verifies the signature over the raw body, dedupes by `x-razorpay-event-id` (or sha256 of the body), checks amount/currency/reference, applies LLD §4.3 transitions. Always 200 once durably recorded; 400 only for signature failures. `x-thali-mock` is accepted only when PAYMENT_PROVIDER=mock.',
  request: {
    headers: z.object({
      'x-razorpay-signature': z.string(),
      'x-razorpay-event-id': z.string().optional(),
      'x-thali-mock': z.string().optional(),
    }),
    body: { content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } }, required: true },
  },
  responses: { 200: json(WebhookAckSchema, 'Recorded (see result)') },
  errors: ['WEBHOOK_SIGNATURE_INVALID'],
});

// ---- customer ----
openapi.route({
  method: 'get',
  path: '/api/v1/payments/checkout/:checkoutId',
  tags: ['payments'],
  summary: 'Payment status for my checkout (polling)',
  security: 'bearer',
  request: { params: CheckoutParams },
  responses: { 200: json(PaymentStatusViewSchema, 'Payment status') },
  errors: ['NOT_FOUND'],
});
openapi.route({
  method: 'post',
  path: '/api/v1/payments/:intentId/verify',
  tags: ['payments'],
  summary: 'Verify the Standard Checkout signature, then reconcile with the provider (never marks paid by itself)',
  security: 'bearer',
  rateLimited: true,
  request: { params: VerifyParams, ...body(VerifyBody) },
  responses: { 200: json(PaymentStatusViewSchema.extend({ reconciled: z.boolean() }), 'Current status after reconciliation') },
  errors: ['NOT_FOUND'],
});

// ---- demo pay ----
openapi.route({
  method: 'get',
  path: '/api/v1/demo-pay/:intentId',
  tags: ['demo'],
  summary: 'Demo pay page data (only when PAYMENT_PROVIDER=mock; 404 otherwise)',
  request: { params: VerifyParams },
  responses: { 200: json(DemoPayViewSchema, 'Intent for the demo pay page') },
  errors: ['NOT_FOUND'],
});
openapi.route({
  method: 'post',
  path: '/api/v1/demo-pay/:intentId/complete',
  tags: ['demo'],
  summary: 'Simulate a payment outcome: emits HMAC-signed mock webhooks through the real webhook pipeline (mock only)',
  request: { params: VerifyParams, ...body(DemoPayCompleteBody) },
  responses: { 200: json(DemoPayResultSchema, 'Webhook results and resulting status') },
  errors: ['NOT_FOUND'],
});

// ---- finance ----
for (const part of ['summary', 'ledger', 'payouts'] as const) {
  const schema = part === 'summary' ? AccountSummarySchema : part === 'ledger' ? page(LedgerEntryViewSchema, 'LedgerPage') : page(PayoutViewSchema, 'PayoutPage');
  openapi.route({
    method: 'get',
    path: `/api/v1/finance/restaurants/:restaurantId/${part}`,
    tags: ['finance'],
    summary: `Restaurant ${part} (owner only; ownership via marketplace)`,
    security: 'bearer',
    request: part === 'summary' ? { params: RestaurantParams } : { params: RestaurantParams, query: PageQuery },
    responses: { 200: json(schema, part) },
    errors: ['NOT_FOUND', 'UPSTREAM_ERROR', 'UPSTREAM_TIMEOUT'],
  });
  openapi.route({
    method: 'get',
    path: `/api/v1/finance/partner/${part}`,
    tags: ['finance'],
    summary: `My delivery-partner ${part}`,
    security: 'bearer',
    ...(part === 'summary' ? {} : { request: { query: PageQuery } }),
    responses: { 200: json(schema, part) },
  });
}

// ---- admin finance ----
const adminErrors = ['MFA_REQUIRED'] as const;
openapi.route({
  method: 'get',
  path: '/api/v1/admin/finance/refunds',
  tags: ['admin-finance'],
  summary: 'List refunds (FINANCE/SUPER_ADMIN + MFA)',
  security: 'bearer',
  request: { query: RefundListQuery },
  responses: { 200: json(page(RefundViewSchema, 'RefundPage'), 'Refunds') },
  errors: [...adminErrors],
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/finance/refunds/:id/retry',
  tags: ['admin-finance'],
  summary: 'Manually retry a FAILED refund (audited)',
  security: 'bearer',
  request: { params: RefundIdParams },
  responses: { 200: json(RefundViewSchema, 'Refund after the retry attempt') },
  errors: [...adminErrors, 'NOT_FOUND', 'REFUND_INVALID_TRANSITION', 'REFUND_EXCEEDS_CAPTURED'],
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/finance/refunds',
  tags: ['admin-finance'],
  summary: 'Create a manual refund ≤ remaining captured amount (Idempotency-Key, audited)',
  security: 'bearer',
  idempotent: true,
  request: body(ManualRefundBody),
  responses: { 201: json(RefundViewSchema, 'Refund REQUESTED') },
  errors: [...adminErrors, 'NOT_FOUND', 'REFUND_EXCEEDS_CAPTURED'],
});
openapi.route({
  method: 'get',
  path: '/api/v1/admin/finance/balances',
  tags: ['admin-finance'],
  summary: 'Account balances by type',
  security: 'bearer',
  request: { query: BalancesQuery },
  responses: { 200: json(page(AccountSummarySchema, 'BalancePage'), 'Balances') },
  errors: [...adminErrors],
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/finance/payouts',
  tags: ['admin-finance'],
  summary: 'Request a payout ≤ available balance (Idempotency-Key, audited)',
  security: 'bearer',
  idempotent: true,
  request: body(PayoutCreateBody),
  responses: {
    201: json(PayoutViewSchema, 'Payout REQUESTED'),
    422: json(z.object({ error: z.object({ code: z.literal('PAYOUT_EXCEEDS_AVAILABLE'), message: z.string(), details: z.unknown(), requestId: z.string() }) }), 'Exceeds available'),
  },
  errors: [...adminErrors],
});
openapi.route({
  method: 'get',
  path: '/api/v1/admin/finance/payouts',
  tags: ['admin-finance'],
  summary: 'List payouts',
  security: 'bearer',
  request: { query: PayoutListQuery },
  responses: { 200: json(page(PayoutViewSchema, 'AdminPayoutPage'), 'Payouts') },
  errors: [...adminErrors],
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/finance/payouts/:id/confirm',
  tags: ['admin-finance'],
  summary: 'Confirm a manual bank settlement with its UTR → PAID + PAYOUT ledger entry (audited)',
  security: 'bearer',
  request: { params: PayoutIdParams, ...body(PayoutConfirmBody) },
  responses: { 200: json(PayoutViewSchema, 'Payout PAID') },
  errors: [...adminErrors, 'NOT_FOUND', 'INVALID_TRANSITION', 'CONFLICT'],
});
openapi.route({
  method: 'post',
  path: '/api/v1/admin/finance/payouts/:id/fail',
  tags: ['admin-finance'],
  summary: 'Mark a payout failed (releases the pending amount; audited)',
  security: 'bearer',
  request: { params: PayoutIdParams, ...body(PayoutFailBody) },
  responses: { 200: json(PayoutViewSchema, 'Payout FAILED') },
  errors: [...adminErrors, 'NOT_FOUND', 'INVALID_TRANSITION'],
});
openapi.route({
  method: 'get',
  path: '/api/v1/admin/finance/payments',
  tags: ['admin-finance'],
  summary: 'Search payments by id / reference / provider ids / user',
  security: 'bearer',
  request: { query: PaymentsSearchQuery },
  responses: { 200: json(page(AdminPaymentViewSchema, 'AdminPaymentPage'), 'Payments') },
  errors: [...adminErrors],
});

// ---- internal ----
openapi.route({
  method: 'post',
  path: '/internal/payment-intents',
  tags: ['internal'],
  summary: 'Create (or return) the payment intent for purpose+referenceId (callers: orders, marketplace)',
  security: 'internal',
  request: body(IntentCreateBody),
  responses: { 200: json(IntentViewSchema, 'Existing intent'), 201: json(IntentViewSchema, 'Created') },
  errors: ['CONFLICT', 'PAYMENT_PROVIDER_UNAVAILABLE'],
});
openapi.route({
  method: 'post',
  path: '/internal/payment-intents/:id/reconcile',
  tags: ['internal'],
  summary: 'Reconcile an intent with the provider',
  security: 'internal',
  request: { params: IntentIdParams },
  responses: { 200: json(ReconcileResultSchema, 'Status after reconciliation') },
  errors: ['NOT_FOUND', 'PAYMENT_PROVIDER_UNAVAILABLE'],
});
openapi.route({
  method: 'get',
  path: '/internal/payment-intents/by-reference/:purpose/:refId',
  tags: ['internal'],
  summary: 'Find an intent by purpose and reference id',
  security: 'internal',
  request: { params: ByReferenceParams },
  responses: { 200: json(IntentViewSchema, 'Intent') },
  errors: ['NOT_FOUND'],
});
