/** `coupon_redemptions` (LLD 3.2): one per checkout (unique `checkoutId`), HELD → REDEEMED | RELEASED. */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const REDEMPTION_STATUSES = ['HELD', 'REDEEMED', 'RELEASED'] as const;

export const couponRedemptionSchema = new Schema(
  {
    couponId: { type: Schema.Types.ObjectId, required: true },
    code: { type: String, required: true },
    userId: { type: String, required: true },
    checkoutId: { type: String, required: true },
    status: { type: String, enum: REDEMPTION_STATUSES, required: true, default: 'HELD' },
    discountPaise: { type: Number, required: true, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'coupon_redemptions' },
);
couponRedemptionSchema.index({ checkoutId: 1 }, { unique: true });
couponRedemptionSchema.index({ couponId: 1, userId: 1, status: 1 });

export type CouponRedemptionDoc = InferSchemaType<typeof couponRedemptionSchema>;
export type CouponRedemptionModel = Model<CouponRedemptionDoc>;

export function couponRedemptionModel(conn: Connection): CouponRedemptionModel {
  return (conn.models.CouponRedemption as CouponRedemptionModel) ?? conn.model<CouponRedemptionDoc>('CouponRedemption', couponRedemptionSchema);
}
