/**
 * Payments internal client (binding shapes in docs/03-LLD.md):
 *  - `POST /internal/payment-intents {purpose, referenceId, userId, amountPaise}` → intent (idempotent per purpose+referenceId)
 *  - `POST /internal/payment-intents/:id/reconcile` → `{ paymentIntentId, status, capturedPaise, refundedPaise, refundReservedPaise }`
 *  - `GET /internal/payment-intents/by-reference/:purpose/:refId` → intent or 404
 */
import { z } from 'zod';
import { enumValues, PaymentStatus } from '@thali/contracts';
import { internalClient, UpstreamError } from '@thali/service-kit';
import type { OrdersConfig } from '../config.js';

export const PaymentIntentViewSchema = z.object({
  paymentIntentId: z.string(),
  provider: z.enum(['razorpay', 'mock']),
  providerOrderId: z.string(),
  keyId: z.string().nullable().default(null),
  amountPaise: z.number().int().nonnegative(),
  currency: z.literal('INR'),
  status: z.enum(enumValues(PaymentStatus)),
  demoPayUrl: z.string().nullable().default(null),
});
export type PaymentIntentView = z.output<typeof PaymentIntentViewSchema>;

export const ReconcileResultSchema = z.object({
  paymentIntentId: z.string(),
  status: z.enum(enumValues(PaymentStatus)),
  capturedPaise: z.number().int().nonnegative(),
  /** Already refunded / reserved for refunds (older payments builds omit them → 0). */
  refundedPaise: z.number().int().nonnegative().default(0),
  refundReservedPaise: z.number().int().nonnegative().default(0),
});
export type ReconcileResult = z.output<typeof ReconcileResultSchema>;

export interface CreateIntentRequest {
  purpose: 'CHECKOUT' | 'MEMBERSHIP';
  referenceId: string;
  userId: string;
  amountPaise: number;
}

export interface PaymentsClient {
  createIntent(req: CreateIntentRequest): Promise<PaymentIntentView>;
  reconcile(intentId: string): Promise<ReconcileResult>;
  /** null when payments has no intent for the reference (404). */
  getByReference(purpose: 'CHECKOUT' | 'MEMBERSHIP', refId: string): Promise<PaymentIntentView | null>;
}

export function createPaymentsClient(config: OrdersConfig): PaymentsClient {
  const http = internalClient('payments', config.PAYMENTS_URL, {
    from: 'orders',
    secret: config.INTERNAL_SERVICE_SECRET,
    // payments may itself wait PAYMENT_PROVIDER_TIMEOUT_MS on the provider: use the longer payments budget
    timeoutMs: config.PAYMENTS_HTTP_TIMEOUT_MS,
  });
  return {
    createIntent: (req) => http.post('/internal/payment-intents', req, { schema: PaymentIntentViewSchema }),
    reconcile: (id) => http.post(`/internal/payment-intents/${encodeURIComponent(id)}/reconcile`, {}, { schema: ReconcileResultSchema }),
    async getByReference(purpose, refId) {
      try {
        return await http.get(`/internal/payment-intents/by-reference/${purpose}/${encodeURIComponent(refId)}`, {
          schema: PaymentIntentViewSchema,
        });
      } catch (e) {
        if (e instanceof UpstreamError && e.upstreamStatus === 404) return null;
        throw e;
      }
    },
  };
}
