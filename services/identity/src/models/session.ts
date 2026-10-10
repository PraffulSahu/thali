/**
 * `sessions` (LLD §3.1, §5.2). One document per login ("family"); `_id` is the `sid` claim and stays
 * stable across refresh rotations. `refreshHash` is the current token's SHA-256; `prevRefreshHash` +
 * `rotatedAt` implement the multi-tab grace window; `oldRefreshHashes` (bounded) lets any older
 * token be recognised as reuse → family revoked.
 */
import { Schema, type Connection, type Types } from 'mongoose';
import { defineModel } from './_model.js';

export const MAX_OLD_REFRESH_HASHES = 50;

export interface SessionDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  familyId: Types.ObjectId;
  kind: 'USER' | 'ADMIN';
  /** False for password-only admin sessions (no refresh cookie issued). */
  refreshable: boolean;
  refreshHash: string;
  prevRefreshHash: string | null;
  oldRefreshHashes: string[];
  rotatedAt: Date | null;
  amr: string[];
  userAgent?: string;
  ip?: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SessionSchema = new Schema<SessionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    familyId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['USER', 'ADMIN'], required: true },
    refreshable: { type: Boolean, default: true },
    refreshHash: { type: String, required: true },
    prevRefreshHash: { type: String, default: null },
    oldRefreshHashes: { type: [String], default: [] },
    rotatedAt: { type: Date, default: null },
    amr: { type: [String], default: [] },
    userAgent: { type: String },
    ip: { type: String },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { collection: 'sessions', timestamps: true },
);
SessionSchema.index({ refreshHash: 1 }, { unique: true });
SessionSchema.index({ prevRefreshHash: 1 }, { sparse: true });
SessionSchema.index({ oldRefreshHashes: 1 });
SessionSchema.index({ userId: 1 });
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = (conn: Connection) => defineModel<SessionDoc>(conn, 'Session', SessionSchema);
