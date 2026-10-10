/**
 * `coupons` (LLD 3.2, OCC). `usedCount`/`heldCount` are only ever changed with conditional `$inc`s by
 * reservations / commerce events (never by a read-modify-write), so admin edits (OCC on `__v`) cannot
 * clobber them. `totalLimit` null = unlimited; `perUserLimit` counts HELD + REDEEMED redemptions.
 */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const COUPON_TYPES = ['FLAT', 'PERCENT'] as const;

export const couponSchema = new Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true },
    description: { type: String, default: '' },
    type: { type: String, enum: COUPON_TYPES, required: true },
    valuePaise: { type: Number, min: 0 },
    valueBps: { type: Number, min: 0, max: 10000 },
    maxDiscountPaise: { type: Number, min: 0 },
    minOrderPaise: { type: Number, min: 0, default: 0 },
    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },
    totalLimit: { type: Number, min: 0, default: null },
    perUserLimit: { type: Number, min: 0, default: 1 },
    usedCount: { type: Number, default: 0 },
    heldCount: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    firstOrderOnly: { type: Boolean, default: false },
    /** MKT-8: restaurants the coupon applies to; empty = every restaurant. */
    restaurantIds: { type: [Schema.Types.ObjectId], default: [] },
    /** MKT-8: short card badge ("20% OFF", ≤ 16 chars); shown on scoped restaurants' discovery cards. */
    badgeLabel: { type: String, maxlength: 16 },
    /** Demo seed data (APP_MODE=demo). */
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, optimisticConcurrency: true, collection: 'coupons' },
);
couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ active: 1, validTo: 1 });
couponSchema.index({ restaurantIds: 1, active: 1 });

export type CouponDoc = InferSchemaType<typeof couponSchema>;
export type CouponModel = Model<CouponDoc>;

export function couponModel(conn: Connection): CouponModel {
  return (conn.models.Coupon as CouponModel) ?? conn.model<CouponDoc>('Coupon', couponSchema);
}
