/** `membership_plans` (LLD 3.2). Prepaid plans; `terms` is markdown shown before purchase. */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const planBenefitsSchema = new Schema(
  {
    freeDeliveryMinOrderPaise: { type: Number, required: true, min: 0 },
    freeDeliveriesPerPeriod: { type: Number, required: true, min: 0 },
    extraDiscountBps: { type: Number, required: true, min: 0, max: 10000 },
    extraDiscountCapPaise: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

export const membershipPlanSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    pricePaise: { type: Number, required: true, min: 0 },
    durationDays: { type: Number, required: true, min: 1 },
    benefits: { type: planBenefitsSchema, required: true },
    terms: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'membership_plans' },
);

export type MembershipPlanDoc = InferSchemaType<typeof membershipPlanSchema>;
export type MembershipPlanModel = Model<MembershipPlanDoc>;

export function membershipPlanModel(conn: Connection): MembershipPlanModel {
  return (conn.models.MembershipPlan as MembershipPlanModel) ?? conn.model<MembershipPlanDoc>('MembershipPlan', membershipPlanSchema);
}
