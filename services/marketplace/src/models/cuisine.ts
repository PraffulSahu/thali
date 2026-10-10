/** `cuisines` (LLD 3.2). */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const cuisineSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    imageKey: { type: String },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'cuisines' },
);

export type CuisineDoc = InferSchemaType<typeof cuisineSchema>;
export type CuisineModel = Model<CuisineDoc>;

export function cuisineModel(conn: Connection): CuisineModel {
  return (conn.models.Cuisine as CuisineModel) ?? conn.model<CuisineDoc>('Cuisine', cuisineSchema);
}
