/**
 * Dead letters: events a consumer gave up on (handler failed `maxAttempts` times, or the stream
 * entry was malformed). Stored in `dead_letters` AND appended to the `dlq.<service>` stream; visible
 * in admin health with a replay action.
 */
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import { DomainError, dlqStream, type ServiceName } from '@thali/contracts';
import { streamKey } from './envelope.js';
import { deadLetterModel, type DeadLetterRecord } from './models.js';
import { DEFAULT_STREAM_MAXLEN } from './relay.js';

export interface WriteDeadLetterInput {
  id: string;
  service: ServiceName;
  /** Logical stream (unprefixed). */
  stream: string;
  entryId: string;
  envelope: unknown;
  error: string;
  attempts: number;
}

/**
 * Upsert the `dead_letters` doc (resets `replayedAt` to null if the event dead-letters again after a
 * replay) and XADD `<prefix>dlq.<service>` with fields `data stream entryId error attempts`.
 * Idempotent: safe to repeat if the process dies before the source entry is acked.
 */
export async function writeDeadLetter(
  conn: Connection,
  redis: Redis,
  input: WriteDeadLetterInput,
  opts: { streamPrefix?: string; maxLen?: number } = {},
): Promise<void> {
  await deadLetterModel(conn).updateOne(
    { _id: input.id },
    {
      $set: {
        stream: input.stream,
        entryId: input.entryId,
        service: input.service,
        envelope: input.envelope,
        error: input.error,
        attempts: input.attempts,
        failedAt: new Date(),
        replayedAt: null,
      },
      $setOnInsert: { replayCount: 0 },
    },
    { upsert: true },
  );
  const data = typeof input.envelope === 'string' ? input.envelope : JSON.stringify(input.envelope);
  const maxLen = opts.maxLen ?? DEFAULT_STREAM_MAXLEN;
  const fields = ['data', data, 'stream', input.stream, 'entryId', input.entryId, 'error', input.error, 'attempts', String(input.attempts)];
  const key = streamKey(opts.streamPrefix, dlqStream(input.service));
  if (maxLen > 0) await redis.xadd(key, 'MAXLEN', '~', maxLen, '*', ...fields);
  else await redis.xadd(key, '*', ...fields);
}

export interface ListDeadLettersOptions {
  /** Default 50, max 500. */
  limit?: number;
  /** Include already replayed entries (default true). */
  includeReplayed?: boolean;
}

/** Newest first. */
export async function listDeadLetters(conn: Connection, opts: ListDeadLettersOptions = {}): Promise<DeadLetterRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const filter = opts.includeReplayed === false ? { replayedAt: null } : {};
  return deadLetterModel(conn).find(filter).sort({ failedAt: -1 }).limit(limit).lean<DeadLetterRecord[]>();
}

export interface ReplayResult {
  id: string;
  stream: string;
  /** New stream entry id. */
  entryId: string;
}

/**
 * Re-XADD the original envelope (same envelope id) to its original stream
 * `<streamPrefix><dl.stream>`, then set `replayedAt` (only after the XADD succeeded).
 * Every consumer group on that stream sees it again; groups that already processed it skip it via
 * their inbox. Throws `NOT_FOUND` for unknown ids and `CONFLICT` for malformed (unparseable) entries.
 */
export async function replayDeadLetter(
  conn: Connection,
  redis: Redis,
  id: string,
  opts: { streamPrefix?: string } = {},
): Promise<ReplayResult> {
  const DeadLetters = deadLetterModel(conn);
  const dl = await DeadLetters.findById(id).lean<DeadLetterRecord>();
  if (!dl) throw new DomainError('NOT_FOUND', 'Dead letter not found');
  if (!dl.envelope || typeof dl.envelope !== 'object') {
    throw new DomainError('CONFLICT', 'Malformed stream entry cannot be replayed');
  }
  const entryId = await redis.xadd(streamKey(opts.streamPrefix, dl.stream), '*', 'data', JSON.stringify(dl.envelope));
  await DeadLetters.updateOne({ _id: id }, { $set: { replayedAt: new Date() }, $inc: { replayCount: 1 } });
  return { id, stream: dl.stream, entryId: entryId! };
}
