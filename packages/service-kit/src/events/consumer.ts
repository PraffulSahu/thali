/**
 * Idempotent Redis Streams consumer (HLD 3.2, LLD 2.3).
 *
 * - Group `cg.<service>` on every `<EVENT_STREAM_PREFIX><stream>`, created with `MKSTREAM` from id `0`
 *   (a service deployed after its producers still sees retained history; BUSYGROUP is ignored).
 * - New entries: `XREADGROUP GROUP cg.<service> <consumer> COUNT n BLOCK ms STREAMS ... >` on a
 *   dedicated connection (blocking reads never stall the shared client).
 * - Each entry: parse envelope → unknown type: XACK (ignored) → inbox fast-path check → ONE
 *   `withTransaction`: insert inbox `{ _id: envelope.id, type, stream, processedAt, attempts }` then
 *   run `handler(envelope, session)` → commit → XACK. Duplicate inbox `_id` → XACK & skip (the
 *   effects already committed once). The handler runs with `correlationId` bound as request id.
 * - Failure: no ack. The failure is recorded in Redis (`<REDIS_KEY_PREFIX>consumer:<service>:failures`,
 *   field `<stream>|<entryId>` → delivery count + time). Reclaim scans `XPENDING ... IDLE` and
 *   `XCLAIM`s an entry once `min(2^attempt × backoffBaseMs, maxBackoffMs)` has elapsed since its
 *   failure (attempt = XPENDING delivery count). Entries with no recorded failure (a consumer
 *   crashed or is still working) are claimed only after `max(claimIdleMs, backoff)` idle.
 *   (Per-entry backoff needs XPENDING+XCLAIM; XAUTOCLAIM only supports one global min-idle.)
 * - Attempt `maxAttempts` fails (or an entry is delivered more than `maxAttempts` times without
 *   success, e.g. it crashes the process) → `dead_letters` doc + XADD `dlq.<service>` + XACK.
 *   Malformed entries (no parseable envelope) are dead-lettered immediately.
 * - `stop()` stops reading, waits for the in-flight handler, and removes this consumer from the
 *   group if it has nothing pending.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ClientSession, Connection } from 'mongoose';
import type { Logger } from 'pino';
import { consumerGroup, type EventEnvelope, type EventType, type ServiceName } from '@thali/contracts';
import { withTransaction } from '../data/transaction.js';
import { redisKey } from '../redis.js';
import { runWithRequestId } from '../request-id.js';
import { entryField, parseEnvelope, streamKey } from './envelope.js';
import { writeDeadLetter } from './dead-letters.js';
import { inboxModel, initEventCollections } from './models.js';

export type EventHandler<T extends EventType = EventType> = (envelope: EventEnvelope<T>, session: ClientSession) => Promise<void>;
/** Handlers by event type; types without a handler are acked and ignored. */
export type EventHandlers = { [T in EventType]?: EventHandler<T> };

export interface StartConsumerOptions {
  conn: Connection;
  redis: Redis;
  service: ServiceName;
  /** Logical stream names, e.g. `['events.orders', 'events.payments']`. */
  streams: string[];
  handlers: EventHandlers;
  logger: Logger;
  /** `config.EVENT_STREAM_PREFIX` (default `''`). */
  streamPrefix?: string;
  /** Handler attempts before dead-lettering. Default 5. */
  maxAttempts?: number;
  /** Min idle before claiming an entry with no recorded failure (crashed/slow consumer). Default 5000 ms. */
  claimIdleMs?: number;
  /** Retry backoff = min(2^attempt × backoffBaseMs, maxBackoffMs). Default 1000 ms (→ 2 s, 4 s, 8 s, ...). */
  backoffBaseMs?: number;
  /** Default 60 000 ms. */
  maxBackoffMs?: number;
  /** XREADGROUP BLOCK upper bound. Default 2000 ms. */
  blockMs?: number;
  /** XREADGROUP COUNT. Default 10. */
  batch?: number;
  /** Default `<service>-<random>`. */
  consumerName?: string;
  /** DLQ stream trim (`MAXLEN ~`). Default 100 000. */
  maxLen?: number;
}

export interface ConsumerHandle {
  readonly consumerName: string;
  readonly group: string;
  /** Resolves once collections and consumer groups exist. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

class DuplicateEventError extends Error {
  constructor() {
    super('duplicate event');
  }
}

interface FailureRecord {
  /** Delivery count of the failed attempt. */
  d: number;
  /** Failure time (ms). */
  at: number;
}

const isDuplicateKey = (err: unknown): boolean => {
  const e = err as { code?: number; writeErrors?: { code?: number }[] } | null;
  return e?.code === 11000 || e?.writeErrors?.[0]?.code === 11000;
};
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startConsumer(opts: StartConsumerOptions): ConsumerHandle {
  const { conn, redis, service, handlers } = opts;
  if (!opts.streams.length) throw new Error('startConsumer: streams must not be empty');
  const maxAttempts = opts.maxAttempts ?? 5;
  const claimIdleMs = opts.claimIdleMs ?? 5000;
  const backoffBaseMs = opts.backoffBaseMs ?? 1000;
  const maxBackoffMs = opts.maxBackoffMs ?? 60_000;
  const blockMs = opts.blockMs ?? 2000;
  const batch = opts.batch ?? 10;
  const group = consumerGroup(service);
  const consumerName = opts.consumerName ?? `${service}-${randomUUID().slice(0, 8)}`;
  const log = opts.logger.child({ component: 'stream-consumer', group, consumer: consumerName });
  const Inbox = inboxModel(conn);
  const failKey = redisKey(redis, `consumer:${service}:failures`);
  const FAIL_TTL_MS = 24 * 3600_000;

  const keys = opts.streams.map((s) => streamKey(opts.streamPrefix, s));
  const logicalByKey = new Map(keys.map((k, i) => [k, opts.streams[i]!]));
  const backoff = (attempt: number) => Math.min(2 ** attempt * backoffBaseMs, maxBackoffMs);
  const minClaimIdle = Math.max(1, Math.min(claimIdleMs, backoff(1)));
  const reclaimEveryMs = Math.min(Math.max(Math.floor(minClaimIdle / 2), 10), 1000);

  // dedicated connection for blocking reads
  const reader = redis.duplicate();
  reader.on('error', (err) => {
    if (!stopping) log.warn({ err }, 'stream reader connection error');
  });

  let stopping = false;

  async function ensureGroups(): Promise<void> {
    for (const key of keys) {
      try {
        await redis.xgroup('CREATE', key, group, '0', 'MKSTREAM');
      } catch (err) {
        if (!errMessage(err).includes('BUSYGROUP')) throw err;
      }
    }
  }

  const ready = (async () => {
    await initEventCollections(conn);
    await ensureGroups();
  })();
  ready.catch(() => undefined); // surfaced through the loop / awaited by callers

  async function ack(key: string, entryId: string): Promise<void> {
    const stream = logicalByKey.get(key)!;
    try {
      await redis.multi().xack(key, group, entryId).hdel(failKey, `${stream}|${entryId}`).exec();
    } catch (err) {
      // stays pending → reclaimed later → inbox dedupes
      log.warn({ err, stream, entryId }, 'XACK failed');
    }
  }

  async function recordFailure(stream: string, entryId: string, deliveries: number): Promise<void> {
    const value: FailureRecord = { d: deliveries, at: Date.now() };
    try {
      await redis.multi().hset(failKey, `${stream}|${entryId}`, JSON.stringify(value)).pexpire(failKey, FAIL_TTL_MS).exec();
    } catch (err) {
      log.warn({ err, stream, entryId }, 'could not record failure; entry will be reclaimed after claimIdleMs');
    }
  }

  async function deadLetter(key: string, entryId: string, id: string, envelope: unknown, error: string, attempts: number): Promise<void> {
    const stream = logicalByKey.get(key)!;
    await writeDeadLetter(
      conn,
      redis,
      { id, service, stream, entryId, envelope, error, attempts },
      { streamPrefix: opts.streamPrefix, maxLen: opts.maxLen },
    );
    log.error({ stream, entryId, eventId: id, attempts, error }, 'event dead-lettered');
    await ack(key, entryId);
  }

  async function processEntry(key: string, entryId: string, fields: string[], deliveries: number): Promise<void> {
    const stream = logicalByKey.get(key)!;
    const raw = entryField(fields, 'data');
    const envelope = parseEnvelope(raw);
    if (!envelope) {
      await deadLetter(key, entryId, `${stream}:${entryId}`, raw ?? fields, 'malformed stream entry: no parseable envelope in field "data"', deliveries);
      return;
    }
    const handler = handlers[envelope.type] as EventHandler | undefined;
    if (!handler) {
      await ack(key, entryId); // not interested in this type
      return;
    }
    const elog = log.child({ eventId: envelope.id, type: envelope.type, stream, entryId, attempt: deliveries });
    if (await Inbox.exists({ _id: envelope.id })) {
      await ack(key, entryId);
      return;
    }
    if (deliveries > maxAttempts) {
      await deadLetter(key, entryId, envelope.id, envelope, `delivered ${deliveries} times without success (maxAttempts ${maxAttempts})`, deliveries);
      return;
    }
    try {
      await runWithRequestId(envelope.correlationId || envelope.id, () =>
        withTransaction(conn, async (session) => {
          try {
            await Inbox.create([{ _id: envelope.id, type: envelope.type, stream, processedAt: new Date(), attempts: deliveries }], { session });
          } catch (err) {
            if (isDuplicateKey(err)) throw new DuplicateEventError();
            throw err;
          }
          await handler(envelope, session);
        }),
      );
      await ack(key, entryId);
    } catch (err) {
      if (err instanceof DuplicateEventError) {
        await ack(key, entryId);
        return;
      }
      elog.warn({ err }, 'event handler failed');
      if (deliveries >= maxAttempts) {
        await deadLetter(key, entryId, envelope.id, envelope, errMessage(err), deliveries);
        return;
      }
      await recordFailure(stream, entryId, deliveries);
    }
  }

  async function reclaim(): Promise<void> {
    for (const key of keys) {
      const stream = logicalByKey.get(key)!;
      let start = '-';
      for (let scanned = 0; scanned < 1000 && !stopping; ) {
        const rows = (await redis.xpending(key, group, 'IDLE', minClaimIdle, start, '+', 100)) as [string, string, number, number][];
        if (!rows.length) break;
        const fails = await redis.hmget(failKey, ...rows.map(([id]) => `${stream}|${id}`));
        for (let i = 0; i < rows.length && !stopping; i++) {
          const [id, , idle, deliveries] = rows[i]!;
          const f = fails[i] ? (JSON.parse(fails[i]!) as FailureRecord) : null;
          let required: number;
          if (f && f.d === deliveries) {
            required = backoff(deliveries);
            if (Date.now() < f.at + required) continue;
          } else {
            required = Math.max(claimIdleMs, backoff(deliveries));
          }
          if (idle < required) continue;
          const claimed = (await redis.xclaim(key, group, consumerName, required, id)) as [string, string[] | null][];
          if (!claimed.length) continue; // another consumer got it first
          const [cid, cfields] = claimed[0]!;
          if (!cfields) {
            await ack(key, cid); // entry was trimmed/deleted
            continue;
          }
          await processEntry(key, cid, cfields, deliveries + 1);
        }
        scanned += rows.length;
        if (rows.length < 100) break;
        start = `(${rows[rows.length - 1]![0]}`;
      }
    }
  }

  const loop = (async () => {
    let errorDelay = 200;
    while (!stopping) {
      try {
        await ready;
        break;
      } catch (err) {
        log.error({ err }, 'consumer setup failed; retrying');
        await sleep(errorDelay);
        errorDelay = Math.min(errorDelay * 2, 5000);
      }
    }
    let nextReclaimAt = 0;
    errorDelay = 200;
    while (!stopping) {
      try {
        if (Date.now() >= nextReclaimAt) {
          await reclaim();
          nextReclaimAt = Date.now() + reclaimEveryMs;
        }
        if (stopping) break;
        const block = Math.max(1, Math.min(blockMs, nextReclaimAt - Date.now()));
        const res = (await reader.xreadgroup(
          'GROUP',
          group,
          consumerName,
          'COUNT',
          batch,
          'BLOCK',
          block,
          'STREAMS',
          ...keys,
          ...keys.map(() => '>'),
        )) as [string, [string, string[]][]][] | null;
        if (res) {
          for (const [key, entries] of res) {
            for (const [entryId, fields] of entries) {
              if (stopping) break; // unprocessed entries stay pending and are reclaimed later
              await processEntry(key, entryId, fields, 1);
            }
          }
        }
        errorDelay = 200;
      } catch (err) {
        if (stopping) break;
        if (errMessage(err).includes('NOGROUP')) {
          // stream/group deleted underneath us: recreate
          await ensureGroups().catch((e) => log.error({ err: e }, 'could not recreate consumer group'));
        } else {
          log.error({ err }, 'consumer loop error');
        }
        await sleep(errorDelay);
        errorDelay = Math.min(errorDelay * 2, 5000);
      }
    }
  })();

  let stopped: Promise<void> | null = null;
  return {
    consumerName,
    group,
    ready,
    stop() {
      stopped ??= (async () => {
        stopping = true;
        reader.disconnect(); // interrupts a blocking XREADGROUP; in-flight handler is awaited below
        await loop;
        try {
          for (const key of keys) {
            const summary = (await redis.xpending(key, group, '-', '+', 1, consumerName)) as unknown[];
            if (!summary.length) await redis.xgroup('DELCONSUMER', key, group, consumerName);
          }
        } catch {
          // best effort
        }
      })();
      return stopped;
    },
  };
}
