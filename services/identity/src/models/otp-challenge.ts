/** `otp_challenges` (LLD §3.1, §5.1). The raw code is never stored — only `codeHash` (HMAC-SHA256 with OTP_PEPPER). */
import { Schema, type Connection, type Types } from 'mongoose';
import { defineModel } from './_model.js';

export interface OtpChallengeDoc {
  _id: Types.ObjectId;
  phone: string;
  codeHash: string;
  purpose: 'LOGIN';
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
  /** Set when a newer request supersedes this challenge. */
  invalidatedAt: Date | null;
  /** When the code was handed to the SMS provider (null = not sent; demo challenges are never sent). */
  sentAt: Date | null;
  lastSentAt: Date | null;
  sendCount: number;
  /** Demo challenge (code 123456, not sent) — only valid while demo OTP is allowed for this phone. */
  demo: boolean;
  ip?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OtpChallengeSchema = new Schema<OtpChallengeDoc>(
  {
    phone: { type: String, required: true },
    codeHash: { type: String, required: true },
    purpose: { type: String, enum: ['LOGIN'], default: 'LOGIN', required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0, required: true },
    maxAttempts: { type: Number, default: 5, required: true },
    consumedAt: { type: Date, default: null },
    invalidatedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: null },
    sendCount: { type: Number, default: 0 },
    demo: { type: Boolean, default: false },
    ip: { type: String },
  },
  { collection: 'otp_challenges', timestamps: true },
);
OtpChallengeSchema.index({ phone: 1, createdAt: -1 });
// LLD §14: OTP challenges live 1 day past expiry.
OtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

export const OtpChallengeModel = (conn: Connection) => defineModel<OtpChallengeDoc>(conn, 'OtpChallenge', OtpChallengeSchema);
