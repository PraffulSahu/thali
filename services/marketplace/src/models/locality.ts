/**
 * `localities` (MKT-1): the demo / fallback gazetteer behind address search. One LOCALITY row per
 * neighbourhood and one ROAD row per main street ("<street>, <locality>", located at the locality
 * centre — the gazetteer has no per-street coordinates). Written only by `upsertLocalities`.
 */
import { Schema, type Connection, type InferSchemaType, type Model } from 'mongoose';

export const LOCALITY_KINDS = ['LOCALITY', 'ROAD', 'LANDMARK'] as const;

const PointSchema = new Schema(
  { type: { type: String, enum: ['Point'], required: true }, coordinates: { type: [Number], required: true } },
  { _id: false },
);

export const localitySchema = new Schema(
  {
    /** Display name: "Indiranagar" or "12th Main Road, Indiranagar". */
    name: { type: String, required: true },
    /** Suggestion headline: the locality name, or the street for ROAD rows. */
    primary: { type: String, required: true },
    aliases: { type: [String], default: [] },
    kind: { type: String, enum: LOCALITY_KINDS, required: true },
    /** Neighbourhood name (= name for LOCALITY rows). */
    locality: { type: String, required: true },
    city: { type: String, required: true, default: 'Bengaluru' },
    pincode: { type: String, default: null },
    location: { type: PointSchema, required: true },
    /** Lower-cased words of name + aliases (prefix-matched through the multikey index). */
    tokens: { type: [String], default: [] },
    isDemo: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'localities' },
);
localitySchema.index({ tokens: 1 });
localitySchema.index({ location: '2dsphere' });
localitySchema.index({ name: 'text', aliases: 'text' });

export type LocalityDoc = InferSchemaType<typeof localitySchema>;
export type LocalityModel = Model<LocalityDoc>;

export function localityModel(conn: Connection): LocalityModel {
  return (conn.models.Locality as LocalityModel) ?? conn.model<LocalityDoc>('Locality', localitySchema);
}
