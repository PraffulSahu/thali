import { Schema, type Connection, type HydratedDocument, type Model, type Types } from 'mongoose';
import { RefundReason, RefundStatus, enumValues } from '@thali/contracts';
import type { StatusHistoryEntry } from './payment-intent.js';

export interface RefundAttrs {
  _id: Types.ObjectId;
  paymentIntentId: string;
  checkoutGroupId: string;
  childOrderId?: string | null;
  /** Restaurant charged for an admin refund after delivery (REFUND_ADJUSTMENT). */
  restaurantId?: string | null;
  amountPaise: number;
  reason: RefundReason;
  /** Natural idempotency key, e.g. `refund:<childOrderId>:<reason>` (unique). */
  idempotencyKey: string;
  status: RefundStatus;
  providerRefundId?: string | null;
  /** Bumped after a definitive provider rejection so the next attempt uses a fresh provider key. */
  providerKeySeq: number;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  /** Worker claim lease while a provider call is in flight. */
  lockedUntil: Date | null;
  processingSince: Date | null;
  lastPolledAt: Date | null;
  lastError?: string | null;
  requestedBy: string;
  note?: string | null;
  chargeRestaurantPaise: number;
  /** True while `amountPaise` is reserved against the intent's `refundReservedPaise`. */
  reserved: boolean;
  statusHistory: StatusHistoryEntry<RefundStatus>[];
  /** Demo data: seeded, or refunding a demo payment intent. */
  isDemo: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}
export type RefundDoc = HydratedDocument<RefundAttrs>;

const historySchema = new Schema(
  { from: { type: String, default: null }, to: { type: String, required: true }, at: { type: Date, required: true }, source: String },
  { _id: false },
);

const schema = new Schema<RefundAttrs>(
  {
    paymentIntentId: { type: String, required: true },
    checkoutGroupId: { type: String, required: true },
    childOrderId: { type: String, default: null },
    restaurantId: { type: String, default: null },
    amountPaise: { type: Number, required: true, min: 1, validate: Number.isInteger },
    reason: { type: String, enum: enumValues(RefundReason), required: true },
    idempotencyKey: { type: String, required: true },
    status: { type: String, enum: enumValues(RefundStatus), required: true },
    providerRefundId: { type: String, default: null },
    providerKeySeq: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    processingSince: { type: Date, default: null },
    lastPolledAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    requestedBy: { type: String, required: true },
    note: { type: String, default: null },
    chargeRestaurantPaise: { type: Number, default: 0 },
    reserved: { type: Boolean, default: false },
    statusHistory: { type: [historySchema], default: [] },
    isDemo: { type: Boolean, default: false },
  },
  { collection: 'refunds', timestamps: true, versionKey: 'version', optimisticConcurrency: true },
);
schema.index({ idempotencyKey: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ childOrderId: 1 });
schema.index({ paymentIntentId: 1 });
schema.index({ providerRefundId: 1 }, { unique: true, partialFilterExpression: { providerRefundId: { $type: 'string' } } });

export function refundModel(conn: Connection): Model<RefundAttrs> {
  return (conn.models.Refund as Model<RefundAttrs> | undefined) ?? conn.model<RefundAttrs>('Refund', schema);
}
