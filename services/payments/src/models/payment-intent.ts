import { Schema, type Connection, type HydratedDocument, type Model, type Types } from 'mongoose';
import { PaymentPurpose, PaymentStatus, enumValues } from '@thali/contracts';

export interface StatusHistoryEntry<S extends string> {
  from: S | null;
  to: S;
  at: Date;
  /** What caused it: `webhook:<eventId>`, `reconcile`, `refund:<id>`, `create`. */
  source: string;
}

export interface PaymentIntentAttrs {
  _id: Types.ObjectId;
  purpose: PaymentPurpose;
  referenceId: string;
  userId: string;
  amountPaise: number;
  currency: 'INR';
  provider: 'razorpay' | 'mock';
  /** Null until the provider order is created (see intents.ts claim protocol). */
  providerOrderId: string | null;
  providerPaymentId?: string;
  status: PaymentStatus;
  capturedPaise: number;
  /** Sum of SUCCEEDED refunds (drives PARTIALLY_REFUNDED / REFUNDED). */
  refundedPaise: number;
  /** Sum of all refunds not definitively released (REQUESTED/PROCESSING/SUCCEEDED/FAILED) — the cap check. */
  refundReservedPaise: number;
  statusHistory: StatusHistoryEntry<PaymentStatus>[];
  /** When `status` last changed (service clock; drives the reconcile job). */
  statusChangedAt: Date;
  lastReconciledAt?: Date | null;
  failureReason?: string | null;
  isDemo: boolean;
  orderCreateAttempts: number;
  orderCreateLockedUntil?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}
export type PaymentIntentDoc = HydratedDocument<PaymentIntentAttrs>;

const historySchema = new Schema(
  { from: { type: String, default: null }, to: { type: String, required: true }, at: { type: Date, required: true }, source: String },
  { _id: false },
);

export const paymentIntentSchema = new Schema<PaymentIntentAttrs>(
  {
    purpose: { type: String, enum: enumValues(PaymentPurpose), required: true },
    referenceId: { type: String, required: true },
    userId: { type: String, required: true },
    amountPaise: { type: Number, required: true, min: 1, validate: Number.isInteger },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    provider: { type: String, enum: ['razorpay', 'mock'], required: true },
    providerOrderId: { type: String, default: null },
    providerPaymentId: { type: String },
    status: { type: String, enum: enumValues(PaymentStatus), required: true },
    capturedPaise: { type: Number, default: 0 },
    refundedPaise: { type: Number, default: 0 },
    refundReservedPaise: { type: Number, default: 0 },
    statusHistory: { type: [historySchema], default: [] },
    statusChangedAt: { type: Date, required: true },
    lastReconciledAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    isDemo: { type: Boolean, default: false },
    orderCreateAttempts: { type: Number, default: 0 },
    orderCreateLockedUntil: { type: Date, default: null },
  },
  { collection: 'payment_intents', timestamps: true, versionKey: 'version', optimisticConcurrency: true },
);
paymentIntentSchema.index({ purpose: 1, referenceId: 1 }, { unique: true });
paymentIntentSchema.index({ providerOrderId: 1 }, { unique: true, partialFilterExpression: { providerOrderId: { $type: 'string' } } });
paymentIntentSchema.index({ providerPaymentId: 1 }, { sparse: true });
paymentIntentSchema.index({ status: 1, statusChangedAt: 1 });
paymentIntentSchema.index({ userId: 1, createdAt: -1 });

export function paymentIntentModel(conn: Connection): Model<PaymentIntentAttrs> {
  return (conn.models.PaymentIntent as Model<PaymentIntentAttrs> | undefined) ?? conn.model<PaymentIntentAttrs>('PaymentIntent', paymentIntentSchema);
}
