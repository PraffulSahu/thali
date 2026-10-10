/** `menu_items` (LLD 3.2, OCC). `reservedQty` is owned by Task 9 reservations. */
import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';

const optionSchema = new Schema({
  name: { type: String, required: true },
  pricePaise: { type: Number, required: true, min: 0 },
  isVeg: { type: Boolean, required: true },
  available: { type: Boolean, default: true },
});

const groupSchema = new Schema({
  name: { type: String, required: true },
  minSelect: { type: Number, required: true, min: 0 },
  maxSelect: { type: Number, required: true, min: 1 },
  options: { type: [optionSchema], default: [] },
});

export const menuItemSchema = new Schema(
  {
    restaurantId: { type: Types.ObjectId, required: true },
    categoryId: { type: Types.ObjectId, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    pricePaise: { type: Number, required: true, min: 0 },
    isVeg: { type: Boolean, required: true },
    imageKey: { type: String },
    available: { type: Boolean, default: true },
    trackStock: { type: Boolean, default: false },
    stockQty: { type: Number, default: 0, min: 0 },
    reservedQty: { type: Number, default: 0, min: 0 },
    customizationGroups: { type: [groupSchema], default: [] },
    tags: { type: [String], default: [] },
    /** Demo seed data (APP_MODE=demo). */
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, optimisticConcurrency: true, collection: 'menu_items' },
);
menuItemSchema.index({ restaurantId: 1, categoryId: 1 });
menuItemSchema.index({ name: 'text', description: 'text', tags: 'text' });

export type MenuItemDoc = InferSchemaType<typeof menuItemSchema>;
export type MenuItemModel = Model<MenuItemDoc>;

export function menuItemModel(conn: Connection): MenuItemModel {
  return (conn.models.MenuItem as MenuItemModel) ?? conn.model<MenuItemDoc>('MenuItem', menuItemSchema);
}
