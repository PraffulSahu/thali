/**
 * Service-kit standard collections (every service DB, LLD 3.1 note):
 *  - `outbox`       `{ _id: envelope.id, stream, envelope, createdAt, publishedAt: null, attempts, lastError? }`
 *                   indexes `publishedAt+createdAt`; TTL 7 d on `publishedAt` (published rows only).
 *  - `inbox`        `{ _id: eventId, type, stream, processedAt, attempts }`, TTL 30 d on `processedAt`.
 *  - `dead_letters` `{ _id, stream, entryId, service, envelope, error, attempts, failedAt, replayedAt, replayCount }`.
 */
import { Schema, type Connection, type Model } from 'mongoose';

export const OUTBOX_COLLECTION = 'outbox';
export const INBOX_COLLECTION = 'inbox';
export const DEAD_LETTERS_COLLECTION = 'dead_letters';
export const OUTBOX_PUBLISHED_TTL_SEC = 7 * 24 * 3600;
export const INBOX_TTL_SEC = 30 * 24 * 3600;

export interface OutboxRecord {
  _id: string;
  /** Logical stream (unprefixed), e.g. `events.orders`. */
  stream: string;
  envelope: Record<string, unknown>;
  createdAt: Date;
  publishedAt: Date | null;
  /** Failed publish attempts. */
  attempts: number;
  lastError?: string;
}

export interface InboxRecord {
  _id: string;
  type: string;
  stream: string;
  processedAt: Date;
  /** Handler attempt that succeeded (1 = first try; infrastructure outages do not count). */
  attempts: number;
  /** Stream delivery count of the successful delivery (includes redeliveries after outages/crashes). */
  deliveries?: number;
}

export interface DeadLetterRecord {
  /** envelope id, or `<stream>:<entryId>` for malformed entries. */
  _id: string;
  /** Logical stream (unprefixed) the entry came from — replay target. */
  stream: string;
  entryId: string;
  service: string;
  /** Original envelope; the raw `data` string for malformed entries; `null` when the entry was trimmed from the stream before it could be processed. */
  envelope: unknown;
  error: string;
  attempts: number;
  failedAt: Date;
  replayedAt: Date | null;
  replayCount: number;
}

const outboxSchema = new Schema<OutboxRecord>(
  {
    _id: { type: String, required: true },
    stream: { type: String, required: true },
    envelope: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
    publishedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
  },
  { collection: OUTBOX_COLLECTION, versionKey: false, minimize: false },
);
outboxSchema.index({ publishedAt: 1, createdAt: 1 });
outboxSchema.index({ publishedAt: 1 }, { expireAfterSeconds: OUTBOX_PUBLISHED_TTL_SEC, name: 'publishedAt_ttl' });

const inboxSchema = new Schema<InboxRecord>(
  {
    _id: { type: String, required: true },
    type: { type: String, required: true },
    stream: { type: String, required: true },
    processedAt: { type: Date, required: true },
    attempts: { type: Number, required: true },
    deliveries: { type: Number },
  },
  { collection: INBOX_COLLECTION, versionKey: false },
);
inboxSchema.index({ processedAt: 1 }, { expireAfterSeconds: INBOX_TTL_SEC });

const deadLetterSchema = new Schema<DeadLetterRecord>(
  {
    _id: { type: String, required: true },
    stream: { type: String, required: true },
    entryId: { type: String, required: true },
    service: { type: String, required: true },
    envelope: { type: Schema.Types.Mixed, default: null },
    error: { type: String, required: true },
    attempts: { type: Number, required: true },
    failedAt: { type: Date, required: true },
    replayedAt: { type: Date, default: null },
    replayCount: { type: Number, default: 0 },
  },
  { collection: DEAD_LETTERS_COLLECTION, versionKey: false, minimize: false },
);
deadLetterSchema.index({ failedAt: -1 });
deadLetterSchema.index({ replayedAt: 1, failedAt: -1 });

function model<T>(conn: Connection, name: string, schema: Schema<T>): Model<T> {
  return (conn.models[name] as Model<T> | undefined) ?? conn.model<T>(name, schema);
}

export const outboxModel = (conn: Connection): Model<OutboxRecord> => model(conn, 'KitOutbox', outboxSchema);
export const inboxModel = (conn: Connection): Model<InboxRecord> => model(conn, 'KitInbox', inboxSchema);
export const deadLetterModel = (conn: Connection): Model<DeadLetterRecord> => model(conn, 'KitDeadLetter', deadLetterSchema);

/**
 * Create `outbox`, `inbox`, `dead_letters` and their indexes. Call once at boot (before serving
 * traffic) so the first business transaction does not race collection/index creation.
 * `startRelay` / `startConsumer` also call it.
 */
export async function initEventCollections(conn: Connection): Promise<void> {
  // Not `Model.init()`: mongoose caches its promise forever, including a rejection, so a failed boot
  // (Mongo briefly unavailable) could never be retried. createCollection/createIndexes are idempotent.
  await Promise.all(
    [outboxModel(conn), inboxModel(conn), deadLetterModel(conn)].map(async (m) => {
      try {
        await m.createCollection();
      } catch (err) {
        if ((err as { code?: number }).code !== 48) throw err; // NamespaceExists
      }
      await m.createIndexes();
    }),
  );
}
