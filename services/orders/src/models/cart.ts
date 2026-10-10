/**
 * `carts` (OCC) — LLD §3.3. One USER cart per userId, one GUEST cart per guest token hash.
 * Line identity = itemId + canonical(selections) (`lineKey`).
 */
import { Schema, type Connection, type HydratedDocument, type Model, type Types } from 'mongoose';
import { AddOnDocSchema, AddressSnapshotSchema, SelectionDocSchema, type AddOnDoc, type AddressSnapshot, type SelectionDoc } from './common.js';

export interface CartLine {
  _id: Types.ObjectId;
  restaurantId: string;
  restaurantName: string;
  itemId: string;
  name: string;
  isVeg: boolean;
  /** Display snapshot from the latest marketplace quote; checkout always re-prices. */
  unitPricePaise: number;
  quantity: number;
  selections: SelectionDoc[];
  addOns: AddOnDoc[];
  note?: string | null;
  lineKey: string;
  addedAt: Date;
}

export interface Cart {
  _id: Types.ObjectId;
  ownerType: 'USER' | 'GUEST';
  userId?: string;
  guestTokenHash?: string;
  items: CartLine[];
  addressId?: string | null;
  deliveryAddress?: AddressSnapshot | null;
  couponCode?: string | null;
  cartVersion: number;
  /** cartVersion at the time of the latest checkout (LLD §8 step 7). */
  checkedOutVersion?: number | null;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export type CartDoc = HydratedDocument<Cart>;

const CartLineSchema = new Schema<CartLine>(
  {
    restaurantId: { type: String, required: true },
    restaurantName: { type: String, required: true },
    itemId: { type: String, required: true },
    name: { type: String, required: true },
    isVeg: { type: Boolean, default: false },
    unitPricePaise: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1, max: 20 },
    selections: { type: [SelectionDocSchema], default: [] },
    addOns: { type: [AddOnDocSchema], default: [] },
    note: { type: String, default: null },
    lineKey: { type: String, required: true },
    addedAt: { type: Date, required: true },
  },
  { _id: true },
);

export const CartSchema = new Schema<Cart>(
  {
    ownerType: { type: String, enum: ['USER', 'GUEST'], required: true },
    userId: { type: String },
    guestTokenHash: { type: String },
    items: { type: [CartLineSchema], default: [] },
    addressId: { type: String, default: null },
    deliveryAddress: { type: AddressSnapshotSchema, default: null },
    couponCode: { type: String, default: null },
    cartVersion: { type: Number, required: true, default: 0 },
    checkedOutVersion: { type: Number, default: null },
    expiresAt: { type: Date, default: null },
  },
  { collection: 'carts', timestamps: true, optimisticConcurrency: true },
);
CartSchema.index({ userId: 1 }, { unique: true, sparse: true });
CartSchema.index({ guestTokenHash: 1 }, { unique: true, sparse: true });
CartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const cartModel = (conn: Connection): Model<Cart> =>
  (conn.models.Cart as Model<Cart> | undefined) ?? conn.model<Cart>('Cart', CartSchema);
