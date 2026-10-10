/**
 * `cancelled_orders`: tombstones for child orders cancelled before delivery ever created a job.
 * `order.cancelled` with no job writes one; `order.accepted` (e.g. a retried delivery of an event that
 * failed before the cancellation was processed) checks it and never creates/dispatches a job for a
 * cancelled order. Kept 30 days (far beyond any consumer retry window).
 */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const CANCELLED_ORDER_TTL_SEC = 30 * 24 * 3600;

export const cancelledOrderSchema = new Schema(
  {
    childOrderId: { type: String, required: true },
    actor: { type: String, default: null },
    reason: { type: String, default: null },
    cancelledAt: { type: Date, required: true },
  },
  { collection: 'cancelled_orders', versionKey: false },
);

cancelledOrderSchema.index({ childOrderId: 1 }, { unique: true });
cancelledOrderSchema.index({ cancelledAt: 1 }, { expireAfterSeconds: CANCELLED_ORDER_TTL_SEC });

export type CancelledOrderFields = InferSchemaType<typeof cancelledOrderSchema>;
export type CancelledOrderModel = Model<CancelledOrderFields>;

export const cancelledOrderModel = (conn: Connection): CancelledOrderModel =>
  (conn.models.CancelledOrder as CancelledOrderModel | undefined) ?? conn.model<CancelledOrderFields>('CancelledOrder', cancelledOrderSchema);
