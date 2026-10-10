import { Schema, type Connection, type HydratedDocument, type Model, type Types } from 'mongoose';
import { PayoutStatus, enumValues } from '@thali/contracts';
import type { StatusHistoryEntry } from './payment-intent.js';

export interface PayoutAttrs {
  _id: Types.ObjectId;
  accountType: 'RESTAURANT' | 'PARTNER';
  accountId: string;
  amountPaise: number;
  status: PayoutStatus;
  method: 'MANUAL_BANK_TRANSFER';
  /** Bank UTR of the verified manual settlement (unique: one transfer cannot settle two payouts). */
  utr?: string | null;
  requestedBy: string;
  confirmedBy?: string | null;
  confirmedAt?: Date | null;
  failureReason?: string | null;
  notes?: string | null;
  statusHistory: StatusHistoryEntry<PayoutStatus>[];
  /** Demo seed data (APP_MODE=demo). */
  isDemo: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}
export type PayoutDoc = HydratedDocument<PayoutAttrs>;

const historySchema = new Schema(
  { from: { type: String, default: null }, to: { type: String, required: true }, at: { type: Date, required: true }, source: String },
  { _id: false },
);

const schema = new Schema<PayoutAttrs>(
  {
    accountType: { type: String, enum: ['RESTAURANT', 'PARTNER'], required: true },
    accountId: { type: String, required: true },
    amountPaise: { type: Number, required: true, min: 1, validate: Number.isInteger },
    status: { type: String, enum: enumValues(PayoutStatus), required: true },
    method: { type: String, enum: ['MANUAL_BANK_TRANSFER'], default: 'MANUAL_BANK_TRANSFER' },
    utr: { type: String, default: null },
    requestedBy: { type: String, required: true },
    confirmedBy: { type: String, default: null },
    confirmedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    notes: { type: String, default: null },
    statusHistory: { type: [historySchema], default: [] },
    isDemo: { type: Boolean, default: false },
  },
  { collection: 'payouts', timestamps: true, versionKey: 'version', optimisticConcurrency: true },
);
schema.index({ accountType: 1, accountId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ utr: 1 }, { unique: true, partialFilterExpression: { utr: { $type: 'string' } } });

export function payoutModel(conn: Connection): Model<PayoutAttrs> {
  return (conn.models.Payout as Model<PayoutAttrs> | undefined) ?? conn.model<PayoutAttrs>('Payout', schema);
}

/** Per-account serialization point for payout requests (write-conflict on concurrent txns). */
export interface AccountLockAttrs {
  _id: string;
  seq: number;
}
const lockSchema = new Schema<AccountLockAttrs>({ _id: String, seq: { type: Number, default: 0 } }, { collection: 'account_locks', versionKey: false });
export function accountLockModel(conn: Connection): Model<AccountLockAttrs> {
  return (conn.models.AccountLock as Model<AccountLockAttrs> | undefined) ?? conn.model<AccountLockAttrs>('AccountLock', lockSchema);
}
