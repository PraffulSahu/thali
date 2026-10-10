import { z } from 'zod';
import { GeoPointSchema } from './common.js';

/** Indian PIN code: 6 digits, first non-zero. */
export const PincodeSchema = z.string().regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit pincode');

/** Delivery address as exchanged over the API (location as `{lat, lng}`). */
export const AddressSchema = z.object({
  label: z.string().trim().max(40).optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  landmark: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1).max(80),
  pincode: PincodeSchema,
  location: GeoPointSchema,
  isDefault: z.boolean().optional(),
});
export type Address = z.infer<typeof AddressSchema>;

/** A saved address (has an id). */
export const SavedAddressSchema = AddressSchema.extend({ id: z.string() });
export type SavedAddress = z.infer<typeof SavedAddressSchema>;
