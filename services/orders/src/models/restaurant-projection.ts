/**
 * `restaurant_projection` — `_id` = restaurantId (LLD §3.3). Upserted from `restaurant.*` events
 * (consumer added by Task 12 `events/restaurant-handlers.ts`); Task 11 only defines the model.
 */
import { Schema, type Connection, type Model } from 'mongoose';
import type { GeoJsonPoint } from '@thali/contracts';
import { PointSchema } from './common.js';

export interface RestaurantProjection {
  _id: string;
  ownerUserId: string;
  name: string;
  status: string;
  location?: GeoJsonPoint | null;
  /** `occurredAt` of the last applied restaurant.* event (older events are ignored). */
  eventAt?: Date | null;
  updatedAt: Date;
}

export const RestaurantProjectionSchema = new Schema<RestaurantProjection>(
  {
    _id: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    name: { type: String, required: true },
    status: { type: String, required: true },
    location: { type: PointSchema, default: null },
    eventAt: { type: Date, default: null },
  },
  { collection: 'restaurant_projection', timestamps: { createdAt: false, updatedAt: true }, versionKey: false },
);
RestaurantProjectionSchema.index({ ownerUserId: 1 });

export const restaurantProjectionModel = (conn: Connection): Model<RestaurantProjection> =>
  (conn.models.RestaurantProjection as Model<RestaurantProjection> | undefined) ??
  conn.model<RestaurantProjection>('RestaurantProjection', RestaurantProjectionSchema);
