/** `partners` (LLD 3.5, OCC). */
import { Schema, type Connection, type HydratedDocument, type InferSchemaType, type Model, type Types } from 'mongoose';
import { PartnerStatus, VehicleType, enumValues } from '@thali/contracts';

export const PARTNER_DOC_TYPES = ['ID_PROOF', 'DRIVING_LICENSE', 'VEHICLE_RC'] as const;
export type PartnerDocType = (typeof PARTNER_DOC_TYPES)[number];

const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true },
  },
  { _id: false },
);

const statusHistorySchema = new Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    at: { type: Date, required: true },
    actor: { type: String, required: true },
    actorId: { type: String, default: null },
    reason: { type: String, default: null },
  },
  { _id: false },
);

const documentSchema = new Schema({
  type: { type: String, enum: PARTNER_DOC_TYPES, required: true },
  key: { type: String, required: true },
  contentType: { type: String, default: null },
  size: { type: Number, default: null },
  demoVerified: { type: Boolean, default: false },
  uploadedAt: { type: Date, required: true },
});

export const partnerSchema = new Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    phone: { type: String, default: null },
    vehicle: {
      type: new Schema(
        {
          type: { type: String, enum: enumValues(VehicleType), required: true },
          registrationNumber: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    status: { type: String, enum: enumValues(PartnerStatus), required: true, default: 'DRAFT' },
    statusReason: { type: String, default: null },
    statusHistory: { type: [statusHistorySchema], default: [] },
    documents: { type: [documentSchema], default: [] },
    online: { type: Boolean, default: false },
    lastLocation: { type: pointSchema, default: undefined },
    lastLocationAt: { type: Date, default: null },
    activeJobIds: { type: [Schema.Types.ObjectId], default: [] },
    maxActive: { type: Number, required: true },
    isDemo: { type: Boolean, default: false },
  },
  { collection: 'partners', timestamps: true, optimisticConcurrency: true, versionKey: 'version' },
);

partnerSchema.index({ userId: 1 }, { unique: true });
partnerSchema.index({ lastLocation: '2dsphere' });
partnerSchema.index({ status: 1, online: 1 });

export type PartnerFields = InferSchemaType<typeof partnerSchema>;
export type PartnerDoc = HydratedDocument<PartnerFields>;
export type PartnerLean = PartnerFields & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export type PartnerModel = Model<PartnerFields>;

export const partnerModel = (conn: Connection): PartnerModel =>
  (conn.models.Partner as PartnerModel | undefined) ?? conn.model<PartnerFields>('Partner', partnerSchema);
