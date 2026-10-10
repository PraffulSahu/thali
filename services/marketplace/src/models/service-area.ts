/** `service_areas` (LLD 3.2). */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const serviceAreaSchema = new Schema(
  {
    name: { type: String, required: true },
    polygon: {
      type: new Schema(
        { type: { type: String, enum: ['Polygon'], required: true }, coordinates: { type: [[[Number]]], required: true } },
        { _id: false },
      ),
      required: true,
    },
    active: { type: Boolean, default: true },
    deliveryFee: {
      type: new Schema(
        {
          basePaise: { type: Number, required: true, min: 0 },
          baseKm: { type: Number, required: true, min: 0 },
          perKmPaise: { type: Number, required: true, min: 0 },
          maxPaise: { type: Number, required: true, min: 0 },
        },
        { _id: false },
      ),
      required: true,
    },
    minOrderPaise: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, collection: 'service_areas' },
);
serviceAreaSchema.index({ polygon: '2dsphere' });

export type ServiceAreaDoc = InferSchemaType<typeof serviceAreaSchema>;
export type ServiceAreaModel = Model<ServiceAreaDoc>;

export function serviceAreaModel(conn: Connection): ServiceAreaModel {
  return (conn.models.ServiceArea as ServiceAreaModel) ?? conn.model<ServiceAreaDoc>('ServiceArea', serviceAreaSchema);
}
