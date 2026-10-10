/** `admin_credentials` (LLD §3.1, §5.3): argon2id password hash + AES-GCM encrypted TOTP secret + reset-token hash (IDN-1). */
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
  /** IDN-1: SHA-256 (hex) of the one outstanding password-reset token; the raw token is never stored. */
  resetTokenHash: string | null;
  resetExpiresAt: Date | null;
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
    resetTokenHash: { type: String, default: null },
    resetExpiresAt: { type: Date, default: null },
  },
  { collection: 'admin_credentials', timestamps: true },
);
AdminCredentialSchema.index({ userId: 1 }, { unique: true });
AdminCredentialSchema.index({ resetTokenHash: 1 }, { unique: true, partialFilterExpression: { resetTokenHash: { $type: 'string' } } });

export const AdminCredentialModel = (conn: Connection) =>
  defineModel<AdminCredentialDoc>(conn, 'AdminCredential', AdminCredentialSchema);
