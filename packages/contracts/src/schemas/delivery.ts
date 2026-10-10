import { z } from 'zod';
import { VehicleType, enumValues } from '../enums.js';
import { GeoPointSchema } from './common.js';

export const VehicleTypeSchema = z.enum(enumValues(VehicleType));

export const VehicleSchema = z.object({
  type: VehicleTypeSchema,
  registrationNumber: z.string().trim().min(4).max(20),
});
export type Vehicle = z.infer<typeof VehicleSchema>;

/** 4-digit pickup / delivery code. */
export const HandoverCodeSchema = z.string().regex(/^[0-9]{4}$/, 'Enter the 4-digit code');

/** Partner location ping body: `{lat, lng, accuracyM}`. */
export const LocationPingSchema = GeoPointSchema.extend({
  accuracyM: z.number().min(0).max(100_000).optional(),
});
export type LocationPing = z.infer<typeof LocationPingSchema>;
