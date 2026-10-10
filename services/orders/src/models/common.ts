/** Shared sub-schemas for orders models. */
import { Schema } from 'mongoose';
import type { Breakdown, GeoJsonPoint } from '@thali/contracts';

export const PointSchema = new Schema<GeoJsonPoint>(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
  { _id: false },
);

export interface AddressSnapshot {
  addressId?: string;
  label?: string;
  line1: string;
  line2?: string;
  landmark?: string;
  /** Neighbourhood ("Indiranagar") from the identity address (contract 4); drop area for the partner offer. */
  locality?: string;
  city: string;
  pincode: string;
  location: GeoJsonPoint;
}

export const AddressSnapshotSchema = new Schema<AddressSnapshot>(
  {
    addressId: String,
    label: String,
    line1: { type: String, required: true },
    line2: String,
    landmark: String,
    locality: String,
    city: { type: String, required: true },
    pincode: { type: String, required: true },
    location: { type: PointSchema, required: true },
  },
  { _id: false },
);

export interface SelectionDoc {
  groupId: string;
  optionIds: string[];
}
export const SelectionDocSchema = new Schema<SelectionDoc>({ groupId: String, optionIds: [String] }, { _id: false });

export interface AddOnDoc {
  id: string;
  name: string;
  pricePaise: number;
}
export const AddOnDocSchema = new Schema<AddOnDoc>({ id: String, name: String, pricePaise: Number }, { _id: false });

const money = { type: Number, required: true, default: 0 };
export const BreakdownDocSchema = new Schema<Breakdown>(
  {
    itemsSubtotalPaise: money,
    couponDiscountPaise: money,
    membershipDiscountPaise: money,
    packagingFeePaise: money,
    deliveryFeePaise: money,
    deliveryDiscountPaise: money,
    platformFeePaise: money,
    foodTaxPaise: money,
    feeTaxPaise: money,
    totalPaise: money,
  },
  { _id: false },
);

export interface StatusHistoryEntry<S extends string = string> {
  from: S | null;
  to: S;
  actor: string;
  actorId?: string | null;
  reason?: string | null;
  at: Date;
}
export const StatusHistorySchema = new Schema<StatusHistoryEntry>(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    actor: { type: String, required: true },
    actorId: { type: String, default: null },
    reason: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { _id: false },
);

export const BREAKDOWN_KEYS: (keyof Breakdown)[] = [
  'itemsSubtotalPaise',
  'couponDiscountPaise',
  'membershipDiscountPaise',
  'packagingFeePaise',
  'deliveryFeePaise',
  'deliveryDiscountPaise',
  'platformFeePaise',
  'foodTaxPaise',
  'feeTaxPaise',
  'totalPaise',
];

/** Plain Breakdown (strips mongoose internals). */
export function plainBreakdown(b: Breakdown | null | undefined): Breakdown {
  const out = {} as Breakdown;
  for (const k of BREAKDOWN_KEYS) out[k] = b?.[k] ?? 0;
  return out;
}
