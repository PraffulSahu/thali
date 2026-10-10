/**
 * payments internal client (binding shape, service-context "Internal API shapes"):
 *   POST /internal/payment-intents { purpose, referenceId, userId, amountPaise }
 *     → 200/201 { paymentIntentId, provider, providerOrderId, keyId, amountPaise, currency, status, demoPayUrl }
 * Idempotent per purpose+referenceId, so re-calling for the same pending membership is safe.
 */
import { z } from 'zod';
import { internalClient } from '@thali/service-kit';

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

export interface PaymentsClient {
  createIntent(req: CreateIntentRequest): Promise<PaymentIntentView>;
}

export function createPaymentsClient(opts: { baseUrl: string; secret: string; timeoutMs?: number }): PaymentsClient {
  const http = internalClient('payments', opts.baseUrl, { from: 'marketplace', secret: opts.secret, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  return {
    createIntent: (req) => http.post('/internal/payment-intents', req, { schema: PaymentIntentSchema }),
  };
}
