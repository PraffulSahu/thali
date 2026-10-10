import { Schema, type Connection, type Model } from 'mongoose';

export const PaymentEventResult = {
  APPLIED: 'APPLIED',
  IGNORED_DUPLICATE: 'IGNORED_DUPLICATE',
  IGNORED_STALE: 'IGNORED_STALE',
  REJECTED_MISMATCH: 'REJECTED_MISMATCH',
  /** Additive: unknown provider order/refund or unsupported event type (stored + acknowledged). */
  IGNORED_UNKNOWN: 'IGNORED_UNKNOWN',
} as const;
export type PaymentEventResult = (typeof PaymentEventResult)[keyof typeof PaymentEventResult];

export interface PaymentEventAttrs {
  /** Provider event id (`x-razorpay-event-id`) or sha256 of the raw body when absent. */
  _id: string;
  provider: 'razorpay' | 'mock';
  type: string;
  providerOrderId?: string | null;
  providerPaymentId?: string | null;
  providerRefundId?: string | null;
  /** Redacted: normalized fields only (no customer contact / instrument details). */
  payload: Record<string, unknown>;
  receivedAt: Date;
  processedAt?: Date | null;
  result: PaymentEventResult;
  resultDetail?: string | null;
}

const schema = new Schema<PaymentEventAttrs>(
  {
    _id: { type: String, required: true },
    provider: { type: String, required: true },
    type: { type: String, required: true },
    providerOrderId: { type: String, default: null },
    providerPaymentId: { type: String, default: null },
    providerRefundId: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    receivedAt: { type: Date, required: true },
    processedAt: { type: Date, default: null },
    result: { type: String, enum: Object.values(PaymentEventResult), required: true },
    resultDetail: { type: String, default: null },
  },
  { collection: 'payment_events', versionKey: false, minimize: false },
);
schema.index({ providerOrderId: 1 });
schema.index({ providerRefundId: 1 }, { sparse: true });

export function paymentEventModel(conn: Connection): Model<PaymentEventAttrs> {
  return (conn.models.PaymentEvent as Model<PaymentEventAttrs> | undefined) ?? conn.model<PaymentEventAttrs>('PaymentEvent', schema);
}
