/** `admin_credentials` (LLD §3.1, §5.3): argon2id password hash + AES-GCM encrypted TOTP secret. */
import { Schema, type Connection, type Types } from 'mongoose';
import { defineModel } from './_model.js';

export interface AdminCredentialDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  passwordHash: string;
  totpSecretEnc: string | null;
  totpEnabled: boolean;
  /** Last accepted TOTP time-step (replay protection). */
  lastTotpStep: number | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const AdminCredentialSchema = new Schema<AdminCredentialDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    passwordHash: { type: String, required: true },
    totpSecretEnc: { type: String, default: null },
    totpEnabled: { type: Boolean, default: false },
    lastTotpStep: { type: Number, default: null },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { collection: 'admin_credentials', timestamps: true },
);
AdminCredentialSchema.index({ userId: 1 }, { unique: true });

export const AdminCredentialModel = (conn: Connection) =>
  defineModel<AdminCredentialDoc>(conn, 'AdminCredential', AdminCredentialSchema);
