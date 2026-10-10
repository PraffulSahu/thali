/**
 * `checkout_groups` (OCC) — LLD §3.3. Parent of one child order per restaurant; status derived
 * from children (LLD §4.2). Duplicate-submit guard: unique partial index
 * `{userId, cartVersion, restaurantSetKey}` where `status = AWAITING_PAYMENT` (ORD-3: one active
 * checkout per cart version AND restaurant subset; `'*'` = whole cart). The pre-redesign index
 * `{userId, cartVersion}` is dropped by `initOrdersDb` (`migrateCheckoutIndexes`).
 */
import { Schema, type Connection, type HydratedDocument, type Model, type Types } from 'mongoose';
import { enumValues, CheckoutStatus, type Breakdown } from '@thali/contracts';
import { AddressSnapshotSchema, BreakdownDocSchema, StatusHistorySchema, type AddressSnapshot, type StatusHistoryEntry } from './common.js';

export interface PaymentSnapshot {
  paymentIntentId: string;
  provider: 'razorpay' | 'mock';
  providerOrderId: string;
  keyId: string | null;
  amountPaise: number;
  currency: 'INR';
  demoPayUrl: string | null;
}

export interface CheckoutGroup {
  _id: Types.ObjectId;
  code: string;
  userId: string;
  cartId?: Types.ObjectId | null;
  cartVersion: number;
  /**
   * ORD-3: `restaurantSetKey(restaurantIds)` of a subset checkout, `'*'` for the whole cart. Groups
   * written before the redesign lack it and are treated as `'*'`.
   */
  restaurantSetKey?: string;
  status: CheckoutStatus;
  deliveryAddress: AddressSnapshot;
  childOrderIds: Types.ObjectId[];
  pricing: Breakdown;
  couponCode?: string | null;
  membershipId?: string | null;
  paymentIntentId?: string | null;
  providerOrderId?: string | null;
  /** Mirror of the payment intent status as last seen by orders. */
  paymentStatus: string;
  payment?: PaymentSnapshot | null;
  expiresAt: Date;
  statusHistory: StatusHistoryEntry<CheckoutStatus>[];
  idempotencyKey?: string | null;
  isDemo: boolean;
  placedAt?: Date | null;
  /** Set once when a capture arrived after EXPIRED/PAYMENT_FAILED (refund requested via event). */
  latePayment?: { paymentIntentId: string | null; amountPaise: number; at: Date } | null;
  /** Last captured-amount mismatch seen (alert; not placed). */
  paymentMismatch?: { expectedPaise: number; receivedPaise: number; at: Date } | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}
export type CheckoutGroupDoc = HydratedDocument<CheckoutGroup>;

const PaymentSnapshotSchema = new Schema<PaymentSnapshot>(
  {
    paymentIntentId: String,
    provider: String,
    providerOrderId: String,
    keyId: { type: String, default: null },
    amountPaise: Number,
    currency: { type: String, default: 'INR' },
    demoPayUrl: { type: String, default: null },
  },
  { _id: false },
);

export const CheckoutGroupSchema = new Schema<CheckoutGroup>(
  {
    code: { type: String, required: true },
    userId: { type: String, required: true },
    cartId: { type: Schema.Types.ObjectId, default: null },
    cartVersion: { type: Number, required: true },
    restaurantSetKey: { type: String, default: '*' },
    status: { type: String, enum: enumValues(CheckoutStatus), required: true },
    deliveryAddress: { type: AddressSnapshotSchema, required: true },
    childOrderIds: { type: [Schema.Types.ObjectId], default: [] },
    pricing: { type: BreakdownDocSchema, required: true },
    couponCode: { type: String, default: null },
    membershipId: { type: String, default: null },
    paymentIntentId: { type: String, default: null },
    providerOrderId: { type: String, default: null },
    paymentStatus: { type: String, default: 'PENDING' },
    payment: { type: PaymentSnapshotSchema, default: null },
    expiresAt: { type: Date, required: true },
    statusHistory: { type: [StatusHistorySchema], default: [] },
    idempotencyKey: { type: String, default: null },
    isDemo: { type: Boolean, default: false },
    placedAt: { type: Date, default: null },
    latePayment: { type: new Schema({ paymentIntentId: String, amountPaise: Number, at: Date }, { _id: false }), default: null },
    paymentMismatch: {
      type: new Schema({ expectedPaise: Number, receivedPaise: Number, at: Date }, { _id: false }),
      default: null,
    },
    schemaVersion: { type: Number, default: 1 },
  },
  { collection: 'checkout_groups', timestamps: true, optimisticConcurrency: true },
);
CheckoutGroupSchema.index({ code: 1 }, { unique: true });
CheckoutGroupSchema.index({ userId: 1, createdAt: -1 });
CheckoutGroupSchema.index({ status: 1, expiresAt: 1 });
/** Pre-redesign duplicate-submit index (`{userId, cartVersion}`), dropped at boot by `migrateCheckoutIndexes`. */
export const LEGACY_ACTIVE_CHECKOUT_INDEX = 'uniq_active_checkout_per_cart_version';
export const ACTIVE_CHECKOUT_INDEX = 'uniq_active_checkout_per_cart_version_set';
CheckoutGroupSchema.index(
  { userId: 1, cartVersion: 1, restaurantSetKey: 1 },
  { unique: true, partialFilterExpression: { status: 'AWAITING_PAYMENT' }, name: ACTIVE_CHECKOUT_INDEX },
);

export const checkoutGroupModel = (conn: Connection): Model<CheckoutGroup> =>
  (conn.models.CheckoutGroup as Model<CheckoutGroup> | undefined) ?? conn.model<CheckoutGroup>('CheckoutGroup', CheckoutGroupSchema);
