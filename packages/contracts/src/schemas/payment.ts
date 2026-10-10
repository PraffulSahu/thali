import { z } from 'zod';
import { CURRENCY, PaymentPurpose, RefundReason, enumValues } from '../enums.js';
import { PaiseSchema } from './common.js';

export const PaymentPurposeSchema = z.enum(enumValues(PaymentPurpose));
export const RefundReasonSchema = z.enum(enumValues(RefundReason));

/** Result of creating a payment intent (LLD 8 step 8). */
export const PaymentInitSchema = z.object({
  paymentIntentId: z.string(),
  provider: z.enum(['razorpay', 'mock']),
  providerOrderId: z.string(),
  keyId: z.string().optional(),
  amountPaise: PaiseSchema,
  currency: z.literal(CURRENCY),
  demoPayUrl: z.string().optional(),
});
export type PaymentInit = z.infer<typeof PaymentInitSchema>;

export const DemoPayCompleteSchema = z.object({ outcome: z.enum(['success', 'failure']) });
