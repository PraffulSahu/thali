/** `delivery_jobs` (LLD 3.5, OCC). Plain handover codes are never stored — only sha256 hashes. */
import { Schema, type Connection, type HydratedDocument, type InferSchemaType, type Model, type Types } from 'mongoose';
import { DeliveryStatus, EstimateSource, enumValues } from '@thali/contracts';

const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true },
  },
  { _id: false },
);

const placeSchema = new Schema(
  {
    name: { type: String, required: true },
    address: { type: String, required: true },
    location: { type: pointSchema, required: true },
    /** DLV-1: restaurant phone from order.accepted (never exposed in views; revealed via /contact). */
    phone: { type: String, default: null },
  },
  { _id: false },
);

const dropSchema = new Schema(
  {
    name: { type: String, required: true },
    address: { type: String, required: true },
    location: { type: pointSchema, required: true },
    phoneMasked: { type: String, default: '' },
    /** DLV-2: locality shown on offers instead of the address (fallback: pincode parsed from `address`). */
    area: { type: String, default: null },
    /** DLV-2: address label (Home / Work / …), shown only after assignment. */
    label: { type: String, default: null },
  },
  { _id: false },
);

const statusHistorySchema = new Schema(
  {
    from: { type: String, default: null },
    to: { type: String, required: true },
    at: { type: Date, required: true },
    actor: { type: String, required: true },
    actorId: { type: String, default: null },
    reason: { type: String, default: null },
  },
  { _id: false },
);

export const deliveryJobSchema = new Schema(
  {
    childOrderId: { type: String, required: true },
    checkoutGroupId: { type: String, required: true },
    restaurantId: { type: String, required: true },
    /** Customer (order owner) — tracking ownership + `delivery.location` realtime target. */
    customerUserId: { type: String, required: true },
    /** DLV-4 human order codes (order.accepted; older jobs backfilled from orders at startup). */
    childOrderCode: { type: String, default: null },
    checkoutCode: { type: String, default: null },
    /** DLV-4 backfill marker: set once orders was asked for the codes (found or 404). */
    codesCheckedAt: { type: Date, default: null },
    pickup: { type: placeSchema, required: true },
    drop: { type: dropSchema, required: true },
    status: { type: String, enum: enumValues(DeliveryStatus), required: true, default: 'PENDING_ASSIGNMENT' },
    partnerId: { type: Schema.Types.ObjectId, default: null },
    partnerUserId: { type: String, default: null },
    dispatchRound: { type: Number, default: 0 },
    /** Earliest time the dispatcher may start the next round (round start + OFFER_TTL_SEC). */
    nextDispatchAt: { type: Date, default: null },
    /** LLD 4.5: MAX_DISPATCH_ROUNDS exceeded (status unchanged) → admin attention. */
    exception: { type: Boolean, default: false },
    exceptionReason: { type: String, default: null },
    distanceKm: { type: Number, required: true },
    estimatedMinutes: { type: Number, required: true },
    estimateSource: { type: String, enum: enumValues(EstimateSource), required: true },
    prepMinutes: { type: Number, default: null },
    readyEta: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    pickupCodeHash: { type: String, required: true },
    deliveryCodeHash: { type: String, required: true },
    /** Wrong attempts on the current handover code (reset after a successful pickup / admin reassign). */
    codeAttempts: { type: Number, default: 0 },
    failureReason: { type: String, default: null },
    statusHistory: { type: [statusHistorySchema], default: [] },
    lastLocation: { type: pointSchema, default: undefined },
    lastLocationAt: { type: Date, default: null },
    locationSimulated: { type: Boolean, default: false },
    assignedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    /** Demo seed data (APP_MODE=demo). */
    isDemo: { type: Boolean, default: false },
  },
  { collection: 'delivery_jobs', timestamps: true, optimisticConcurrency: true, versionKey: 'version' },
);

deliveryJobSchema.index({ childOrderId: 1 }, { unique: true });
deliveryJobSchema.index({ status: 1, createdAt: -1 });
deliveryJobSchema.index({ partnerId: 1, status: 1 });
deliveryJobSchema.index({ status: 1, exception: 1, nextDispatchAt: 1 });
// DLV-4: admin search by code (prefix) + the backfill's "still missing" scan
deliveryJobSchema.index({ childOrderCode: 1, codesCheckedAt: 1 });
deliveryJobSchema.index({ checkoutCode: 1 });
// partner history pagination (partnerUserId + PAGE_SORT)
deliveryJobSchema.index({ partnerUserId: 1, createdAt: -1, _id: -1 });

export type JobFields = InferSchemaType<typeof deliveryJobSchema>;
export type JobDoc = HydratedDocument<JobFields>;
export type JobLean = JobFields & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export type JobModel = Model<JobFields>;

export const ACTIVE_JOB_STATUSES = ['ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'OUT_FOR_DELIVERY'] as const;
export const UNASSIGNED_JOB_STATUSES = ['PENDING_ASSIGNMENT', 'OFFERED'] as const;
export const TERMINAL_JOB_STATUSES = ['DELIVERED', 'FAILED', 'CANCELLED'] as const;

export const jobModel = (conn: Connection): JobModel =>
  (conn.models.DeliveryJob as JobModel | undefined) ?? conn.model<JobFields>('DeliveryJob', deliveryJobSchema);
