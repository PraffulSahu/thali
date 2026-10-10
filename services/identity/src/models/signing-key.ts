/**
 * `signing_keys`: auto-generated Ed25519 access-token signing key for demo/sandbox when
 * `JWT_PRIVATE_KEY_PEM` is absent (production requires env). Private key stored AES-GCM encrypted
 * with FIELD_ENCRYPTION_KEY; `_id` = `kid`.
 */
import { Schema, type Connection } from 'mongoose';
import { defineModel } from './_model.js';

export interface SigningKeyDoc {
  _id: string;
  alg: 'EdDSA';
  /** Singleton marker for the active key (unique) — concurrent first boots converge on one key. */
  slot: 'active' | null;
  publicJwk: Record<string, unknown>;
  privateKeyEnc: string;
  createdAt: Date;
  updatedAt: Date;
}

const SigningKeySchema = new Schema<SigningKeyDoc>(
  {
    _id: { type: String, required: true },
    alg: { type: String, enum: ['EdDSA'], default: 'EdDSA' },
    slot: { type: String, default: 'active' },
    publicJwk: { type: Schema.Types.Mixed, required: true },
    privateKeyEnc: { type: String, required: true },
  },
  { collection: 'signing_keys', timestamps: true },
);
SigningKeySchema.index({ slot: 1 }, { unique: true, partialFilterExpression: { slot: { $type: 'string' } } });

export const SigningKeyModel = (conn: Connection) => defineModel<SigningKeyDoc>(conn, 'SigningKey', SigningKeySchema);
