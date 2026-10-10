import { Schema, type Connection, type Model, type Types } from 'mongoose';
import { LedgerAccountType, LedgerEntryType, enumValues } from '@thali/contracts';

export const PLATFORM_ACCOUNT_ID = 'platform';

/** Append-only: never updated or deleted. */
export interface LedgerEntryAttrs {
  _id: Types.ObjectId;
  accountType: LedgerAccountType;
  /** RESTAURANT → restaurantId, PARTNER → partnerUserId, PLATFORM → 'platform'. */
  accountId: string;
  entryType: LedgerEntryType;
  /** Signed paise. */
  amountPaise: number;
  childOrderId?: string | null;
  deliveryJobId?: string | null;
  payoutId?: string | null;
  refundId?: string | null;
  dedupeKey: string;
  memo: string;
  createdBy: string;
  /** Demo seed data (APP_MODE=demo) — lets finance views tell demo money apart. */
  isDemo: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<LedgerEntryAttrs>(
  {
    accountType: { type: String, enum: enumValues(LedgerAccountType), required: true },
    accountId: { type: String, required: true },
    entryType: { type: String, enum: enumValues(LedgerEntryType), required: true },
    amountPaise: { type: Number, required: true, validate: Number.isInteger },
    childOrderId: { type: String, default: null },
    deliveryJobId: { type: String, default: null },
    payoutId: { type: String, default: null },
    refundId: { type: String, default: null },
    dedupeKey: { type: String, required: true },
    memo: { type: String, default: '' },
    createdBy: { type: String, required: true },
    isDemo: { type: Boolean, default: false },
  },
  { collection: 'ledger_entries', timestamps: true, versionKey: false },
);
schema.index({ dedupeKey: 1 }, { unique: true });
schema.index({ accountType: 1, accountId: 1, createdAt: -1, _id: -1 });
schema.index({ childOrderId: 1 }, { sparse: true });
schema.index({ payoutId: 1 }, { sparse: true });

export function ledgerEntryModel(conn: Connection): Model<LedgerEntryAttrs> {
  return (conn.models.LedgerEntry as Model<LedgerEntryAttrs> | undefined) ?? conn.model<LedgerEntryAttrs>('LedgerEntry', schema);
}
