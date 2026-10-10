/** `banners` (LLD 3.2). */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const BANNER_LINK_TYPES = ['RESTAURANT', 'CUISINE', 'COUPON'] as const;

export const bannerSchema = new Schema(
  {
    title: { type: String, required: true },
    imageKey: { type: String, required: true },
    linkType: { type: String, enum: BANNER_LINK_TYPES, required: true },
    linkValue: { type: String, required: true },
    activeFrom: { type: Date, required: true },
    activeTo: { type: Date, required: true },
    active: { type: Boolean, default: true },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'banners' },
);
bannerSchema.index({ active: 1, activeFrom: 1 });

export type BannerDoc = InferSchemaType<typeof bannerSchema>;
export type BannerModel = Model<BannerDoc>;

export function bannerModel(conn: Connection): BannerModel {
  return (conn.models.Banner as BannerModel) ?? conn.model<BannerDoc>('Banner', bannerSchema);
}
