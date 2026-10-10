/** `ratings` (LLD 3.2): one per child order (unique `childOrderId`). */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const ratingSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, required: true },
    childOrderId: { type: String, required: true },
    userId: { type: String, required: true },
    stars: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
  },
  { timestamps: true, collection: 'ratings' },
);
ratingSchema.index({ childOrderId: 1 }, { unique: true });
ratingSchema.index({ restaurantId: 1, createdAt: -1 });

export type RatingDoc = InferSchemaType<typeof ratingSchema>;
export type RatingModel = Model<RatingDoc>;

export function ratingModel(conn: Connection): RatingModel {
  return (conn.models.Rating as RatingModel) ?? conn.model<RatingDoc>('Rating', ratingSchema);
}
