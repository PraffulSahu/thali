/** `delivery_offers` (LLD 3.5). */
import { Schema, type Connection, type InferSchemaType, type Model, type Types } from 'mongoose';
import { OfferStatus, enumValues } from '@thali/contracts';

export const deliveryOfferSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, required: true },
    partnerId: { type: Schema.Types.ObjectId, required: true },
    /** Realtime target (`partner:<partnerUserId>`). */
    partnerUserId: { type: String, required: true },
    status: { type: String, enum: enumValues(OfferStatus), required: true, default: 'OFFERED' },
    expiresAt: { type: Date, required: true },
    batchEvaluation: {
      type: new Schema(
        {
          eligible: { type: Boolean, required: true },
          reasons: { type: [String], default: [] },
          extraMinutes: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      required: true,
    },
    /** Straight-line distance partner → pickup when offered. */
    distanceToPickupKm: { type: Number, required: true },
    round: { type: Number, required: true },
    respondedAt: { type: Date, default: null },
  },
  { collection: 'delivery_offers', timestamps: true },
);

deliveryOfferSchema.index({ jobId: 1, partnerId: 1, round: 1 }, { unique: true });
deliveryOfferSchema.index({ partnerId: 1, status: 1 });
deliveryOfferSchema.index({ status: 1, expiresAt: 1 });
deliveryOfferSchema.index({ jobId: 1, status: 1 });

export type OfferFields = InferSchemaType<typeof deliveryOfferSchema>;
export type OfferLean = OfferFields & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export type OfferModel = Model<OfferFields>;

export const offerModel = (conn: Connection): OfferModel =>
  (conn.models.DeliveryOffer as OfferModel | undefined) ?? conn.model<OfferFields>('DeliveryOffer', deliveryOfferSchema);
