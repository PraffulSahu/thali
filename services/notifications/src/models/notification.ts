/** `notifications` collection (LLD §3.6). Recipients are stored masked (`to`) + AES-GCM encrypted (`toEnc`). */
import { Schema, type Connection, type Model, type Types } from 'mongoose';

export const NOTIFICATION_CHANNELS = ['SMS', 'EMAIL', 'IN_APP'] as const;
/**
 * `SKIPPED` is local (contracts' NotificationStatus has no such value): terminal, nothing was sent because the
 * recipient opted out / is blocked / has no address / is unknown (reason in `skipReason`).
 */
export const NOTIFICATION_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'DEAD', 'SKIPPED'] as const;

export interface NotificationDoc {
  _id: Types.ObjectId;
  userId?: string | null;
  /** Recipient not known yet: the user is resolved from the child order at dispatch time (refund events). */
  recipientChildOrderId?: string | null;
  /** `ADMIN` = broadcast to admins (no single user). */
  audience?: 'ADMIN' | null;
  channel: (typeof NOTIFICATION_CHANNELS)[number];
  /** Masked for display. */
  to: string;
  /** Full recipient, `encryptField` format. Absent for IN_APP. */
  toEnc?: string | null;
  template: string;
  /** Non-sensitive template data. */
  data: Record<string, unknown>;
  /** Encrypted JSON of the template's secret keys (OTP code, verification URL), if any. */
  secretEnc?: string | null;
  /** Rendered in-app content. */
  title?: string | null;
  body?: string | null;
  status: (typeof NOTIFICATION_STATUSES)[number];
  attempts: number;
  nextAttemptAt: Date | null;
  provider?: string | null;
  providerMessageId?: string | null;
  lastError?: string | null;
  skipReason?: string | null;
  sourceEventId?: string | null;
  dedupeKey: string;
  readAt?: Date | null;
  sendingAt?: Date | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<NotificationDoc>(
  {
    userId: { type: String, default: null },
    recipientChildOrderId: { type: String, default: null },
    audience: { type: String, default: null },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true },
    to: { type: String, default: '' },
    toEnc: { type: String, default: null },
    template: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: () => ({}) },
    secretEnc: { type: String, default: null },
    title: { type: String, default: null },
    body: { type: String, default: null },
    status: { type: String, enum: NOTIFICATION_STATUSES, required: true, default: 'QUEUED' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    provider: { type: String, default: null },
    providerMessageId: { type: String, default: null },
    lastError: { type: String, default: null },
    skipReason: { type: String, default: null },
    sourceEventId: { type: String, default: null },
    dedupeKey: { type: String, required: true },
    readAt: { type: Date, default: null },
    sendingAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'notifications', minimize: false, versionKey: false, timestamps: false },
);

schema.index({ dedupeKey: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ userId: 1, channel: 1, createdAt: -1, _id: -1 });
schema.index({ providerMessageId: 1 }, { sparse: true });
schema.index({ sourceEventId: 1 }, { sparse: true });
schema.index({ status: 1, createdAt: -1, _id: -1 });

export type NotificationModel = Model<NotificationDoc>;

export function notificationModel(conn: Connection): NotificationModel {
  return (conn.models.Notification as NotificationModel | undefined) ?? conn.model<NotificationDoc>('Notification', schema);
}
