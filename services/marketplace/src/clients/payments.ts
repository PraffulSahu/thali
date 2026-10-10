/**
 * payments internal client (binding shape, service-context "Internal API shapes"):
 *   POST /internal/payment-intents { purpose, referenceId, userId, amountPaise }
 *     → 200/201 { paymentIntentId, provider, providerOrderId, keyId, amountPaise, currency, status, demoPayUrl }
 * Idempotent per purpose+referenceId, so re-calling for the same pending membership is safe.
 *   GET  /internal/payment-intents/by-reference/:purpose/:refId → same shape as create | 404 (→ null)
 *   POST /internal/payment-intents/:id/reconcile → { paymentIntentId, status, capturedPaise }
 * (pending-membership sweeper)
 */
import { z } from 'zod';
import { DomainError } from '@thali/contracts';
import { internalClient, UpstreamError } from '@thali/service-kit';

export const PaymentIntentSchema = z
  .object({
    paymentIntentId: z.string(),
    provider: z.enum(['razorpay', 'mock']),
    providerOrderId: z.string(),
    keyId: z.string().nullable(),
    amountPaise: z.number().int().nonnegative(),
    currency: z.literal('INR'),
    status: z.string(),
    demoPayUrl: z.string().nullable(),
  })
  .meta({ id: 'MembershipPaymentIntent' });
export type PaymentIntentView = z.output<typeof PaymentIntentSchema>;

export interface CreateIntentRequest {
  purpose: 'CHECKOUT' | 'MEMBERSHIP';
  referenceId: string;
  userId: string;
  amountPaise: number;
}

export const ReconcileSchema = z.object({ paymentIntentId: z.string(), status: z.string(), capturedPaise: z.number().int().nonnegative() });
export type ReconcileResult = z.output<typeof ReconcileSchema>;

export interface PaymentsClient {
  createIntent(req: CreateIntentRequest): Promise<PaymentIntentView>;
  /** null when payments has no intent for this reference (404). */
  getByReference(purpose: 'CHECKOUT' | 'MEMBERSHIP', referenceId: string): Promise<PaymentIntentView | null>;
  reconcile(paymentIntentId: string): Promise<ReconcileResult>;
}

export function createPaymentsClient(opts: { baseUrl: string; secret: string; timeoutMs?: number }): PaymentsClient {
  const http = internalClient('payments', opts.baseUrl, { from: 'marketplace', secret: opts.secret, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  return {
    createIntent: (req) => http.post('/internal/payment-intents', req, { schema: PaymentIntentSchema }),
    async getByReference(purpose, referenceId) {
      try {
        return await http.get(`/internal/payment-intents/by-reference/${purpose}/${encodeURIComponent(referenceId)}`, { schema: PaymentIntentSchema });
      } catch (e) {
        if ((e instanceof UpstreamError && e.upstreamStatus === 404) || (e instanceof DomainError && e.code === 'NOT_FOUND')) return null;
        throw e;
      }
    },
    reconcile: (id) => http.post(`/internal/payment-intents/${encodeURIComponent(id)}/reconcile`, undefined, { schema: ReconcileSchema }),
  };
}
