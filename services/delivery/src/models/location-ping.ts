/** `location_pings` (LLD 3.5; TTL 7 days on `at`, LLD 14). */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const LOCATION_PING_TTL_SEC = 7 * 24 * 3600;

export const locationPingSchema = new Schema(
  {
    /** null for demo-simulator pings on a job without a real device. */
    partnerId: { type: Schema.Types.ObjectId, default: null },
    jobId: { type: Schema.Types.ObjectId, default: null },
    location: {
      type: new Schema(
        {
          type: { type: String, enum: ['Point'], required: true },
          coordinates: { type: [Number], required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    accuracyM: { type: Number, default: null },
    simulated: { type: Boolean, default: false },
    at: { type: Date, required: true },
  },
  { collection: 'location_pings', versionKey: false },
);

locationPingSchema.index({ at: 1 }, { expireAfterSeconds: LOCATION_PING_TTL_SEC });
locationPingSchema.index({ jobId: 1, at: -1 });

export type LocationPingFields = InferSchemaType<typeof locationPingSchema>;
export type LocationPingModel = Model<LocationPingFields>;

export const locationPingModel = (conn: Connection): LocationPingModel =>
  (conn.models.LocationPing as LocationPingModel | undefined) ?? conn.model<LocationPingFields>('LocationPing', locationPingSchema);
