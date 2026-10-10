/**
 * `memberships` (LLD 3.2). `planSnapshot` freezes price/benefits at purchase. Free-delivery quota per
 * membership term = `planSnapshot.benefits.freeDeliveriesPerPeriod`; `freeDeliveriesUsed` (committed) +
 * `freeDeliveriesHeld` (reserved, additive field) are guarded together with `$expr` in reservations.
 */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';
import { planBenefitsSchema } from './membership-plan.js';

export const MEMBERSHIP_STATUSES = ['PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED'] as const;
export const USAGE_STATUSES = ['HELD', 'USED', 'RELEASED'] as const;

const usageSchema = new Schema(
  {
    checkoutId: { type: String, required: true },
    freeDeliveries: { type: Number, required: true, min: 0 },
    discountPaise: { type: Number, required: true, min: 0 },
    status: { type: String, enum: USAGE_STATUSES, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

export const membershipSchema = new Schema(
  {
    userId: { type: String, required: true },
    planId: { type: Schema.Types.ObjectId, required: true },
    planSnapshot: {
      type: new Schema(
        {
          name: { type: String, required: true },
          pricePaise: { type: Number, required: true },
          durationDays: { type: Number, required: true },
          benefits: { type: planBenefitsSchema, required: true },
          terms: { type: String, default: '' },
        },
        { _id: false },
      ),
      required: true,
    },
    status: { type: String, enum: MEMBERSHIP_STATUSES, required: true },
    statusReason: { type: String },
    startsAt: { type: Date },
    endsAt: { type: Date },
    paymentIntentId: { type: String },
    freeDeliveriesUsed: { type: Number, default: 0 },
    freeDeliveriesHeld: { type: Number, default: 0 },
    usage: { type: [usageSchema], default: [] },
  },
  { timestamps: true, collection: 'memberships' },
);
membershipSchema.index({ userId: 1, status: 1 });
membershipSchema.index({ endsAt: 1 });
membershipSchema.index({ planId: 1 });
/** At most one pending purchase per user+plan (concurrent purchases reuse it). */
membershipSchema.index({ userId: 1, planId: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING_PAYMENT' } });

export type MembershipDoc = InferSchemaType<typeof membershipSchema>;
export type MembershipModel = Model<MembershipDoc>;

export function membershipModel(conn: Connection): MembershipModel {
  return (conn.models.Membership as MembershipModel) ?? conn.model<MembershipDoc>('Membership', membershipSchema);
}
