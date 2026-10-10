/**
 * `child_orders` (OCC) — LLD §3.3. One per restaurant per checkout. Carries every snapshot later
 * steps need (Task 12 lifecycle, `order.accepted` pickup/drop, delivery codes, ledger commission).
 */
import { Schema, type Connection, type HydratedDocument, type Model, type Types } from 'mongoose';
import { enumValues, ChildOrderStatus, ChildRefundStatus, type Breakdown, type GeoJsonPoint } from '@thali/contracts';
import {
  AddOnDocSchema,
  AddressSnapshotSchema,
  BreakdownDocSchema,
  PointSchema,
  SelectionDocSchema,
  StatusHistorySchema,
  type AddOnDoc,
  type AddressSnapshot,
  type SelectionDoc,
  type StatusHistoryEntry,
} from './common.js';

export interface ChildOrderLine {
  /** Cart line this was purchased from (cart clean-up after placement). */
  cartLineId?: string | null;
  lineKey: string;
  itemId: string;
  name: string;
  isVeg: boolean;
  unitPricePaise: number;
  addOns: AddOnDoc[];
  selections: SelectionDoc[];
  quantity: number;
  note?: string | null;
  lineTotalPaise: number;
}

export interface RestaurantAddress {
  line1: string;
  line2?: string;
  city: string;
  pincode: string;
}

export interface ChildRefundEntry {
  refundId: string;
  amountPaise: number;
  reason: string;
  status: 'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  updatedAt: Date;
}

export interface ChildPartner {
  partnerId: string;
  partnerUserId: string;
  name: string;
  vehicle: { type: string; registrationNumber: string };
}

export interface ChildOrder {
  _id: Types.ObjectId;
  code: string;
  checkoutGroupId: Types.ObjectId;
  userId: string;
  restaurantId: string;
  restaurantOwnerId: string;
  restaurantName: string;
  restaurantLocation: GeoJsonPoint;
  restaurantAddress: RestaurantAddress;
  restaurantPhone?: string | null;
  commissionBps: number;
  avgPrepMinutes: number;
  lines: ChildOrderLine[];
  breakdown: Breakdown;
  status: ChildOrderStatus;
  statusHistory: StatusHistoryEntry<ChildOrderStatus>[];
  acceptBy?: Date | null;
  prepMinutes?: number | null;
  readyEta?: Date | null;
  rejectionReason?: string | null;
  cancellationReason?: string | null;
  refundStatus: ChildRefundStatus;
  refundedPaise: number;
  deliveryJobId?: string | null;
  deliveryStatus?: string | null;
  /** 4 digits, shown to the restaurant; partner enters it at pickup. */
  pickupCode: string;
  /** 4 digits, shown to the customer; partner enters it at drop. */
  deliveryCode: string;
  /** `phoneLast4` (ORD-7): indexed admin phone search; null when unknown. Backfilled by `orders:contact-backfill`. */
  customerContact: { name: string; phoneMasked: string; phoneLast4?: string | null };
  /** Customer drop address snapshot (with location). */
  dropAddress: AddressSnapshot;
  distanceKm?: number | null;
  etaMinutes?: number | null;
  etaSource?: string | null;
  isDemo: boolean;
  placedAt?: Date | null;
  acceptedAt?: Date | null;
  readyAt?: Date | null;
  pickedUpAt?: Date | null;
  deliveredAt?: Date | null;
  cancelledAt?: Date | null;
  // ---- Task 12 (lifecycle, refunds, delivery mirror) ----
  /** Total refund orders has requested for this child (rejection / cancellation), or seen from payments. */
  refundRequestedPaise: number;
  /** Mirror of payments refunds for this child (from `refund.*`), one entry per refundId. */
  refunds: ChildRefundEntry[];
  /** Actor that cancelled (CUSTOMER / ADMIN). */
  cancelledBy?: string | null;
  deliveryFailureReason?: string | null;
  /** Partner from `delivery.assigned` (cleared on `delivery.unassigned`). */
  partner?: ChildPartner | null;
  /** From `delivery.delivered.distanceKm` (payments partner earning). */
  deliveryDistanceKm?: number | null;
  /** `occurredAt` of the last applied delivery mirror update (assigned / unassigned ordering). */
  deliveryUpdatedAt?: Date | null;
  /** Acceptance-timeout sweeper backoff after failures (not retried before this time). */
  timeoutRetryAt?: Date | null;
  timeoutFailures?: number;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
export type ChildOrderDoc = HydratedDocument<ChildOrder>;

const ChildOrderLineSchema = new Schema<ChildOrderLine>(
  {
    cartLineId: { type: String, default: null },
    lineKey: { type: String, required: true },
    itemId: { type: String, required: true },
    name: { type: String, required: true },
    isVeg: { type: Boolean, default: false },
    unitPricePaise: { type: Number, required: true },
    addOns: { type: [AddOnDocSchema], default: [] },
    selections: { type: [SelectionDocSchema], default: [] },
    quantity: { type: Number, required: true },
    note: { type: String, default: null },
    lineTotalPaise: { type: Number, required: true },
  },
  { _id: false },
);

export const ChildOrderSchema = new Schema<ChildOrder>(
  {
    code: { type: String, required: true },
    checkoutGroupId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: String, required: true },
    restaurantId: { type: String, required: true },
    restaurantOwnerId: { type: String, required: true },
    restaurantName: { type: String, required: true },
    restaurantLocation: { type: PointSchema, required: true },
    restaurantAddress: {
      type: new Schema<RestaurantAddress>({ line1: String, line2: String, city: String, pincode: String }, { _id: false }),
      required: true,
    },
    restaurantPhone: { type: String, default: null },
    commissionBps: { type: Number, required: true },
    avgPrepMinutes: { type: Number, default: 20 },
    lines: { type: [ChildOrderLineSchema], default: [] },
    breakdown: { type: BreakdownDocSchema, required: true },
    status: { type: String, enum: enumValues(ChildOrderStatus), required: true },
    statusHistory: { type: [StatusHistorySchema], default: [] },
    acceptBy: { type: Date, default: null },
    prepMinutes: { type: Number, default: null },
    readyEta: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    cancellationReason: { type: String, default: null },
    refundStatus: { type: String, enum: enumValues(ChildRefundStatus), default: 'NONE' },
    refundedPaise: { type: Number, default: 0 },
    deliveryJobId: { type: String, default: null },
    deliveryStatus: { type: String, default: null },
    pickupCode: { type: String, required: true },
    deliveryCode: { type: String, required: true },
    customerContact: {
      type: new Schema({ name: String, phoneMasked: String, phoneLast4: { type: String, default: undefined } }, { _id: false }),
      required: true,
    },
    dropAddress: { type: AddressSnapshotSchema, required: true },
    distanceKm: { type: Number, default: null },
    etaMinutes: { type: Number, default: null },
    etaSource: { type: String, default: null },
    isDemo: { type: Boolean, default: false },
    placedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    refundRequestedPaise: { type: Number, default: 0 },
    refunds: {
      type: [
        new Schema<ChildRefundEntry>(
          { refundId: String, amountPaise: Number, reason: String, status: String, updatedAt: Date },
          { _id: false },
        ),
      ],
      default: [],
    },
    cancelledBy: { type: String, default: null },
    deliveryFailureReason: { type: String, default: null },
    partner: {
      type: new Schema<ChildPartner>(
        {
          partnerId: String,
          partnerUserId: String,
          name: String,
          vehicle: { type: new Schema({ type: { type: String }, registrationNumber: String }, { _id: false }) },
        },
        { _id: false },
      ),
      default: null,
    },
    deliveryDistanceKm: { type: Number, default: null },
    deliveryUpdatedAt: { type: Date, default: null },
    timeoutRetryAt: { type: Date, default: null },
    timeoutFailures: { type: Number, default: 0 },
    schemaVersion: { type: Number, default: 1 },
  },
  { collection: 'child_orders', timestamps: true, optimisticConcurrency: true },
);
ChildOrderSchema.index({ code: 1 }, { unique: true });
ChildOrderSchema.index({ checkoutGroupId: 1 });
ChildOrderSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });
ChildOrderSchema.index({ restaurantOwnerId: 1, createdAt: -1 });
ChildOrderSchema.index({ userId: 1, createdAt: -1 });
ChildOrderSchema.index({ status: 1, acceptBy: 1 });
ChildOrderSchema.index({ 'customerContact.phoneLast4': 1 });
// gap-analysis §5.2.9: overview "today" counts, owner stats window, unfiltered admin list, refunds today
ChildOrderSchema.index({ placedAt: 1 });
ChildOrderSchema.index({ deliveredAt: 1 });
ChildOrderSchema.index({ refundStatus: 1 });
ChildOrderSchema.index({ restaurantId: 1, placedAt: -1 });
ChildOrderSchema.index({ createdAt: -1, _id: -1 });
ChildOrderSchema.index({ 'refunds.updatedAt': 1 });

export const childOrderModel = (conn: Connection): Model<ChildOrder> =>
  (conn.models.ChildOrder as Model<ChildOrder> | undefined) ?? conn.model<ChildOrder>('ChildOrder', ChildOrderSchema);
