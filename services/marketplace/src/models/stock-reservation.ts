/**
 * `stock_reservations` (LLD 3.2, ADR-004). One document per checkout (unique `checkoutId`) holding the
 * stock, coupon and membership holds taken in one transaction by `POST /internal/reservations`.
 * Lines carry `restaurantId` (per-child restock on order.rejected/cancelled) and `tracked` (whether the
 * item's stock was reserved). `childOrderIds`/`closedChildIds` drive the "all children rejected →
 * release coupon" rule (LLD 6).
 */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const RESERVATION_STATUSES = ['HELD', 'COMMITTED', 'RELEASED'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

const lineSchema = new Schema(
  {
    restaurantId: { type: String, required: true },
    itemId: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    tracked: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

export const stockReservationSchema = new Schema(
  {
    checkoutId: { type: String, required: true },
    userId: { type: String, required: true },
    lines: { type: [lineSchema], default: [] },
    couponCode: { type: String },
    couponId: { type: Schema.Types.ObjectId },
    couponDiscountPaise: { type: Number, default: 0 },
    membershipId: { type: Schema.Types.ObjectId },
    membershipFreeDeliveries: { type: Number, default: 0 },
    membershipDiscountPaise: { type: Number, default: 0 },
    status: { type: String, enum: RESERVATION_STATUSES, required: true, default: 'HELD' },
    expiresAt: { type: Date, required: true },
    childOrderIds: { type: [String], default: [] },
    closedChildIds: { type: [String], default: [] },
    restockedChildIds: { type: [String], default: [] },
    committedAt: { type: Date },
    releasedAt: { type: Date },
    releaseReason: { type: String },
    /** Number of times the sweeper extended the hold because orders still awaited payment. */
    extensions: { type: Number, default: 0 },
    /** Sweeper back-off: an unresolved hold is not re-checked before this time (prevents starvation). */
    nextCheckAt: { type: Date },
  },
  { timestamps: true, collection: 'stock_reservations' },
);
stockReservationSchema.index({ checkoutId: 1 }, { unique: true });
stockReservationSchema.index({ status: 1, expiresAt: 1 });
stockReservationSchema.index({ userId: 1, status: 1 });

export type StockReservationDoc = InferSchemaType<typeof stockReservationSchema>;
export type StockReservationModel = Model<StockReservationDoc>;

export function stockReservationModel(conn: Connection): StockReservationModel {
  return (conn.models.StockReservation as StockReservationModel) ?? conn.model<StockReservationDoc>('StockReservation', stockReservationSchema);
}
