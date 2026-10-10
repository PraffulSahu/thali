/** `menu_items` (LLD 3.2, OCC). `reservedQty` is owned by Task 9 reservations. */
import { Schema, Types, type Connection, type InferSchemaType, type Model } from 'mongoose';
import { tokenize } from '../domain/search-tokens.js';

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
    /** MKT-9: owner-picked "Recommended" dish (≤ MAX_FEATURED_ITEMS per restaurant). */
    featured: { type: Boolean, default: false },
    /** Discovery search-as-you-type: words of name + tags (set by the validate hook / recomputeSearchTokens). */
    searchTokens: { type: [String], default: [] },
    /** Demo seed data (APP_MODE=demo). */
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true, optimisticConcurrency: true, collection: 'menu_items' },
);
menuItemSchema.index({ restaurantId: 1, categoryId: 1 });
menuItemSchema.index({ name: 'text', description: 'text', tags: 'text' });
/** Discovery item search (MKT-13): anchored prefix regex per word on this multikey index. */
menuItemSchema.index({ searchTokens: 1 });
// every document write (create, save, insertMany, seed ensureDocs/ensureDocsBulk) keeps the tokens current
menuItemSchema.pre('validate', function () {
  this.set('searchTokens', tokenize(this.get('name') as string, ...((this.get('tags') as string[] | undefined) ?? [])));
});
menuItemSchema.index({ restaurantId: 1, featured: 1 });

export type MenuItemDoc = InferSchemaType<typeof menuItemSchema>;
export type MenuItemModel = Model<MenuItemDoc>;

export function menuItemModel(conn: Connection): MenuItemModel {
  return (conn.models.MenuItem as MenuItemModel) ?? conn.model<MenuItemDoc>('MenuItem', menuItemSchema);
}
