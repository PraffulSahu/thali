/** `provider_callbacks` (LLD §3.6): verified provider status webhooks, kept 30 days; also the replay guard. */
import { Schema, type Connection, type Model } from 'mongoose';

export const PROVIDER_CALLBACK_TTL_SEC = 30 * 24 * 3600;

export interface ProviderCallbackDoc {
  provider: 'twilio' | 'resend';
  /** Replay key: Twilio `<MessageSid>:<MessageStatus>`, Resend `svix-id`. */
  eventKey: string;
  providerMessageId?: string | null;
  /** Our interpretation of the callback: the status to apply to the notification (null = informational). */
  mappedStatus?: 'SENT' | 'DELIVERED' | 'DEAD' | null;
  error?: string | null;
  /** Minimal payload (no recipient addresses / message content). */
  payload: Record<string, unknown>;
  receivedAt: Date;
  verified: boolean;
  /** False while no notification with this providerMessageId exists yet (callback raced the send). */
  applied: boolean;
}

const schema = new Schema<ProviderCallbackDoc>(
  {
    provider: { type: String, enum: ['twilio', 'resend'], required: true },
    eventKey: { type: String, required: true },
    providerMessageId: { type: String, default: null },
    mappedStatus: { type: String, default: null },
    error: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: () => ({}) },
    receivedAt: { type: Date, required: true },
    verified: { type: Boolean, required: true },
    applied: { type: Boolean, default: false },
  },
  { collection: 'provider_callbacks', minimize: false, versionKey: false, timestamps: false },
);
schema.index({ provider: 1, eventKey: 1 }, { unique: true });
schema.index({ receivedAt: 1 }, { expireAfterSeconds: PROVIDER_CALLBACK_TTL_SEC });
schema.index({ provider: 1, providerMessageId: 1, applied: 1 });

export type ProviderCallbackModel = Model<ProviderCallbackDoc>;

export function providerCallbackModel(conn: Connection): ProviderCallbackModel {
  return (conn.models.ProviderCallback as ProviderCallbackModel | undefined) ?? conn.model<ProviderCallbackDoc>('ProviderCallback', schema);
}
