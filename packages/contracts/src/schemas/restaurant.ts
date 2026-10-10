import { z } from 'zod';
import { RestaurantStatus, enumValues } from '../enums.js';
import { PincodeSchema } from './address.js';

export const RestaurantStatusSchema = z.enum(enumValues(RestaurantStatus));

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Opening hours slot. `day` 0=Sunday..6=Saturday in restaurant timezone; close may be < open (past midnight). */
export const HoursSlotSchema = z.object({
  day: z.number().int().min(0).max(6),
  open: z.string().regex(HHMM, 'Use HH:mm'),
  close: z.string().regex(HHMM, 'Use HH:mm'),
});
export type HoursSlot = z.infer<typeof HoursSlotSchema>;

export const HoursSchema = z.array(HoursSlotSchema).max(21);

export const RestaurantAddressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(80),
  pincode: PincodeSchema,
});
export type RestaurantAddress = z.infer<typeof RestaurantAddressSchema>;
