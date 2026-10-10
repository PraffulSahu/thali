/** `restaurants` (LLD 3.2, OCC). */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';
import { RestaurantStatus, enumValues } from '@thali/contracts';

const PointSchema = new Schema(
  { type: { type: String, enum: ['Point'], required: true }, coordinates: { type: [Number], required: true } },
  { _id: false },
);

export const restaurantSchema = new Schema(
  {
    ownerUserId: { type: String, required: true, index: true },
    businessName: { type: String },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    description: { type: String },
    cuisines: { type: [String], default: [] },
    phone: { type: String },
    businessEmail: { type: String },
    emailVerifiedAt: { type: Date },
    emailVerification: {
      type: new Schema(
        { tokenHash: { type: String, required: true }, expiresAt: { type: Date, required: true }, sentAt: { type: Date, required: true }, usedAt: { type: Date } },
        { _id: false },
      ),
    },
    /** Verification-email send log (survives email changes): 60 s cooldown + daily cap. */
    emailVerificationLog: {
      type: new Schema({ windowStart: { type: Date, required: true }, count: { type: Number, required: true }, lastSentAt: { type: Date, required: true } }, { _id: false }),
    },
    address: {
      // MKT-5: `locality` = neighbourhood shown next to the name ("Indiranagar")
      type: new Schema({ line1: String, line2: String, locality: String, city: String, pincode: String }, { _id: false }),
    },
    location: { type: PointSchema },
    deliveryRadiusKm: { type: Number, default: 6 },
    hours: {
      type: [new Schema({ day: { type: Number, min: 0, max: 6, required: true }, open: { type: String, required: true }, close: { type: String, required: true } }, { _id: false })],
      default: [],
    },
    timezone: { type: String, default: 'Asia/Kolkata' },
    pausedUntil: { type: Date },
    status: { type: String, enum: enumValues(RestaurantStatus), default: 'DRAFT', index: true },
    statusReason: { type: String },
    statusHistory: {
      type: [
        new Schema(
          { from: String, to: String, actorId: String, reason: String, at: { type: Date, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    images: { type: new Schema({ cover: String, logo: String }, { _id: false }), default: {} },
    documents: {
      type: [new Schema({ type: { type: String, required: true }, key: { type: String, required: true }, verified: { type: Boolean, default: false }, uploadedAt: Date })],
      default: [],
    },
    settlement: {
      type: new Schema(
        { accountHolder: String, accountNumberEnc: String, ifsc: String, last4: String, updatedAt: Date },
        { _id: false },
      ),
    },
    /** MKT-4: owner-declared pure-veg kitchen (admin can override). Only `true` is ever shown as "Pure veg". */
    pureVeg: { type: Boolean, default: false },
    packagingFeePaise: { type: Number, default: 0, min: 0 },
    avgPrepMinutes: { type: Number, default: 20, min: 1 },
    commissionBps: { type: Number, default: 1800, min: 0, max: 10000 },
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    isDemo: { type: Boolean, default: false },
    /** MKT-13: denormalised menu numbers (domain/menu-stats.ts), written in the menu-write transaction. */
    menuStats: {
      type: new Schema(
        {
          itemCount: { type: Number, default: 0 },
          availableItemCount: { type: Number, default: 0 },
          nonVegCount: { type: Number, default: 0 },
          avgItemPricePaise: { type: Number, default: null },
          priceBand: { type: Number, default: null },
          updatedAt: { type: Date },
        },
        { _id: false },
      ),
    },
  },
  { timestamps: true, optimisticConcurrency: true, collection: 'restaurants' },
);
restaurantSchema.index({ location: '2dsphere' });
/** MKT-13: discovery candidate query (`status: 'APPROVED'` + `$geoWithin`). */
restaurantSchema.index({ status: 1, location: '2dsphere' });
restaurantSchema.index({ status: 1, createdAt: -1, _id: -1 });
restaurantSchema.index({ name: 'text', cuisines: 'text', description: 'text' });
restaurantSchema.index({ 'emailVerification.tokenHash': 1 }, { sparse: true });

export type RestaurantDoc = InferSchemaType<typeof restaurantSchema>;
export type RestaurantModel = Model<RestaurantDoc>;

export function restaurantModel(conn: Connection): RestaurantModel {
  return (conn.models.Restaurant as RestaurantModel) ?? conn.model<RestaurantDoc>('Restaurant', restaurantSchema);
}
