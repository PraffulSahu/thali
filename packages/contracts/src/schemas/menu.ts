import { z } from 'zod';
import { PaiseSchema, ObjectIdSchema } from './common.js';

export const CustomizationOptionSchema = z.object({
  id: ObjectIdSchema,
  name: z.string().trim().min(1).max(80),
  pricePaise: PaiseSchema,
  isVeg: z.boolean(),
  available: z.boolean(),
});
export type CustomizationOption = z.infer<typeof CustomizationOptionSchema>;

export const CustomizationGroupSchema = z
  .object({
    id: ObjectIdSchema,
    name: z.string().trim().min(1).max(80),
    minSelect: z.number().int().min(0),
    maxSelect: z.number().int().min(1),
    options: z.array(CustomizationOptionSchema).min(1),
  })
  .refine((g) => g.minSelect <= g.maxSelect, { message: 'minSelect must be <= maxSelect', path: ['minSelect'] })
  .refine((g) => g.maxSelect <= g.options.length, { message: 'maxSelect exceeds option count', path: ['maxSelect'] });
export type CustomizationGroup = z.infer<typeof CustomizationGroupSchema>;

/** Public menu item as returned to clients. */
export const MenuItemSchema = z.object({
  id: ObjectIdSchema,
  restaurantId: ObjectIdSchema,
  categoryId: ObjectIdSchema,
  name: z.string(),
  description: z.string().optional(),
  pricePaise: PaiseSchema,
  isVeg: z.boolean(),
  imageUrl: z.string().optional(),
  available: z.boolean(),
  customizationGroups: z.array(CustomizationGroupSchema),
  tags: z.array(z.string()),
});
export type MenuItem = z.infer<typeof MenuItemSchema>;
