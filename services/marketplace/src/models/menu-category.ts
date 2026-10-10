/** `menu_categories` (LLD 3.2). */
import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const menuCategorySchema = new Schema(
  {
    restaurantId: { type: Types.ObjectId, required: true },
    name: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    /** Demo seed data (APP_MODE=demo). */
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'menu_categories' },
);
menuCategorySchema.index({ restaurantId: 1, sortOrder: 1 });

export type MenuCategoryDoc = InferSchemaType<typeof menuCategorySchema>;
export type MenuCategoryModel = Model<MenuCategoryDoc>;

export function menuCategoryModel(conn: Connection): MenuCategoryModel {
  return (conn.models.MenuCategory as MenuCategoryModel) ?? conn.model<MenuCategoryDoc>('MenuCategory', menuCategorySchema);
}
