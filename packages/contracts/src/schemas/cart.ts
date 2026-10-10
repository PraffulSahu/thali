import { z } from 'zod';
import { ObjectIdSchema } from './common.js';

/** One customization group selection: chosen option ids within a group. */
export const SelectionSchema = z.object({
  groupId: ObjectIdSchema,
  optionIds: z.array(ObjectIdSchema).max(50),
});
export type Selection = z.infer<typeof SelectionSchema>;

export const CART_MAX_QUANTITY = 20;

/** `POST /cart/items` body. Same item with different selections = different cart line. */
export const CartItemInputSchema = z.object({
  restaurantId: ObjectIdSchema,
  itemId: ObjectIdSchema,
  quantity: z.number().int().min(1).max(CART_MAX_QUANTITY),
  selections: z.array(SelectionSchema).max(50).default([]),
  note: z.string().trim().max(200).optional(),
});
export type CartItemInput = z.infer<typeof CartItemInputSchema>;

/** `PATCH /cart/items/:lineId` body (at least one field). */
export const CartItemUpdateSchema = z
  .object({
    quantity: z.number().int().min(1).max(CART_MAX_QUANTITY).optional(),
    selections: z.array(SelectionSchema).max(50).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type CartItemUpdate = z.infer<typeof CartItemUpdateSchema>;
