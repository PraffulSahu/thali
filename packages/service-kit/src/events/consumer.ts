/**
 * Idempotent Redis Streams consumer (HLD 3.2, LLD 2.3).
 *
 * - Setup (retried with backoff until it succeeds; `ready` resolves on the first success): create
 *   the kit collections, then group `cg.<service>` on every `<EVENT_STREAM_PREFIX><stream>` with
 *   `MKSTREAM` from id `0` (a service deployed after its producers still sees retained history;
 *   BUSYGROUP is ignored).
 * - New entries: `XREADGROUP GROUP cg.<service> <consumer> COUNT n BLOCK ms STREAMS ... >` on a
 *   dedicated connection (blocking reads never stall the shared client).
 * - Each entry: parse envelope → unknown type: XACK (ignored) → inbox fast-path check → ONE
 *   `withTransaction`: insert inbox `{ _id: envelope.id, type, stream, processedAt, attempts, deliveries }`
 *   then run `handler(envelope, session)` → commit → XACK. Duplicate inbox `_id` → XACK & skip.
 *   The handler runs with `correlationId` bound as request id.
 * - Handler failure (not infrastructure): no ack; the HANDLER ATTEMPT count is recorded in Redis
 *   (`<REDIS_KEY_PREFIX>consumer:<service>:failures`, field `<stream>|<entryId>`). Reclaim scans
 *   `XPENDING ... IDLE` and `XCLAIM`s the entry once `min(2^(attempt-1) × backoffBaseMs, maxBackoffMs)`
 *   (1 s → 2 s → 4 s …, HLD 3.2) has elapsed since that failure. Entries with no record for their
 *   current delivery (a consumer crashed or is still working) are claimed after `claimIdleMs` idle.
 *   (Per-entry backoff needs XPENDING+XCLAIM; XAUTOCLAIM only supports one global min-idle.)
 * - Attempt `maxAttempts` fails → `dead_letters` doc + XADD `dlq.<service>` + XACK. Malformed entries
 *   (no parseable envelope) are dead-lettered immediately; entries trimmed from the stream while
 *   pending are dead-lettered with `envelope: null`. Crash-loop guard: an entry delivered more than
 *   `maxDeliveries` (default `maxAttempts × 4`) times without success is dead-lettered unprocessed.
 * - Infrastructure errors (Mongo/Redis connectivity, transient-transaction labels — see
 *   `isInfraError`) are NOT handler attempts: the consumer pauses reading and reclaiming, probes
 *   (Mongo ping + Redis ping) with backoff until both answer, then resumes and retries the entry.
 * - `stop()` stops reading, waits for the in-flight handler, and removes this consumer from the
 *   group if it has nothing pending.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ClientSession, Connection } from 'mongoose';
import type { Logger } from 'pino';
import { consumerGroup, type EventEnvelope, type EventType, type ServiceName } from '@thali/contracts';
import { withTransaction } from '../data/transaction.js';
import { isInfraError } from '../infra-errors.js';
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
  /** Handler attempts (infrastructure outages excluded) before dead-lettering. Default 5. */
  maxAttempts?: number;
  /** Crash-loop guard: max stream deliveries without success. Default `maxAttempts * 4`. */
  maxDeliveries?: number;
  /** Min idle before claiming an entry with no recorded failure (crashed/slow consumer). Default 5000 ms. */
  claimIdleMs?: number;
  /** Retry backoff = min(2^(attempt-1) × backoffBaseMs, maxBackoffMs). Default 1000 ms (→ 1 s, 2 s, 4 s, ...). */
  backoffBaseMs?: number;
  /** Default 60 000 ms. */
  maxBackoffMs?: number;
  /** First pause after an infrastructure error (doubles up to 30 s while the probe keeps failing). Default 500 ms. */
  infraBackoffMs?: number;
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
  /** Resolves once collections and consumer groups exist (setup is retried until then); rejects only if stopped first. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

class DuplicateEventError extends Error {
  constructor() {
    super('duplicate event');
  }
}

interface FailureRecord {
  /** Failed handler attempts so far (infrastructure errors excluded). */
  a: number;
  /** Stream delivery count of the delivery that failed. */
  d: number;
  /** Failure time (ms). */
  at: number;
  /** Last failure was an infrastructure error. */
  i?: boolean;
}

const isDuplicateKey = (err: unknown): boolean => {
  const e = err as { code?: number; writeErrors?: { code?: number }[] } | null;
  return e?.code === 11000 || e?.writeErrors?.[0]?.code === 11000;
};
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const MAX_INFRA_PAUSE_MS = 30_000;

export function startConsumer(opts: StartConsumerOptions): ConsumerHandle {
  const { conn, redis, service, handlers } = opts;
  if (!opts.streams.length) throw new Error('startConsumer: streams must not be empty');
  const maxAttempts = opts.maxAttempts ?? 5;
  const maxDeliveries = opts.maxDeliveries ?? maxAttempts * 4;
  const claimIdleMs = opts.claimIdleMs ?? 5000;
  const backoffBaseMs = opts.backoffBaseMs ?? 1000;
  const maxBackoffMs = opts.maxBackoffMs ?? 60_000;
  const infraBackoffMs = opts.infraBackoffMs ?? 500;
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
  /** Wait after the `attempt`-th failed handler attempt: 1 s, 2 s, 4 s, ... capped. */
  const backoff = (attempt: number) => Math.min(2 ** Math.max(attempt - 1, 0) * backoffBaseMs, maxBackoffMs);
  /** Retry delay for an entry whose last failure was an outage (after the consumer resumed). */
  const infraRetryMs = Math.max(1, Math.min(backoffBaseMs, claimIdleMs));
  const minClaimIdle = Math.max(1, Math.min(claimIdleMs, backoff(1), infraRetryMs));
  const reclaimEveryMs = Math.min(Math.max(Math.floor(minClaimIdle / 2), 10), 1000);

  // dedicated connection for blocking reads
  const reader = redis.duplicate();
  reader.on('error', (err) => {
    if (!stopping) log.debug({ err }, 'stream reader connection error');
  });

  let stopping = false;
  let wake: (() => void) | null = null;
  /** Interruptible sleep (stop() wakes it). */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wake = null;
        resolve();
      }
      wake = done;
    });

  // ---- infrastructure pause ----
  let paused = false;
  let pauseDelay = infraBackoffMs;
  let pausedUntil = 0;
  function enterPause(err: unknown): void {
    if (!paused) log.warn({ err: errMessage(err) }, 'infrastructure unavailable; consumer paused');
    paused = true;
    pausedUntil = Date.now() + pauseDelay;
    pauseDelay = Math.min(pauseDelay * 2, MAX_INFRA_PAUSE_MS);
  }
  async function probe(): Promise<boolean> {
    const timeout = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 2000).unref())]);
    try {
      if (!conn.db) throw new Error('mongo not connected');
      await timeout(conn.db.admin().ping());
      await timeout(redis.ping());
      return true;
    } catch (err) {
      enterPause(err);
      return false;
    }
  }

  async function ensureGroups(): Promise<void> {
    for (const key of keys) {
      try {
        await redis.xgroup('CREATE', key, group, '0', 'MKSTREAM');
      } catch (err) {
        if (!errMessage(err).includes('BUSYGROUP')) throw err;
      }
    }
  }

  let markReady!: () => void;
  let failReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  ready.catch(() => undefined); // only rejects when stopped before setup succeeded

  async function ack(key: string, entryId: string): Promise<void> {
    const stream = logicalByKey.get(key)!;
    try {
      await redis.multi().xack(key, group, entryId).hdel(failKey, `${stream}|${entryId}`).exec();
    } catch (err) {
      // stays pending → reclaimed later → inbox dedupes
      log.warn({ err, stream, entryId }, 'XACK failed');
    }
  }

  async function recordFailure(stream: string, entryId: string, value: FailureRecord): Promise<void> {
    try {
      await redis.multi().hset(failKey, `${stream}|${entryId}`, JSON.stringify(value)).pexpire(failKey, FAIL_TTL_MS).exec();
    } catch (err) {
      log.warn({ err: errMessage(err), stream, entryId }, 'could not record failure; entry will be reclaimed after claimIdleMs');
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

  /**
   * @param deliveries stream delivery count of this delivery
   * @param prior      failed handler attempts so far (from the failure record)
   */
  async function processEntry(key: string, entryId: string, fields: string[], deliveries: number, prior: number): Promise<void> {
    const stream = logicalByKey.get(key)!;
    try {
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
      if (await Inbox.exists({ _id: envelope.id })) {
        await ack(key, entryId);
        return;
      }
      if (deliveries > maxDeliveries) {
        await deadLetter(
          key,
          entryId,
          envelope.id,
          envelope,
          `delivered ${deliveries} times without success (crash-loop guard, maxDeliveries ${maxDeliveries})`,
          prior,
        );
        return;
      }
      const attempt = prior + 1;
      try {
        await runWithRequestId(envelope.correlationId || envelope.id, () =>
          withTransaction(conn, async (session) => {
            try {
              await Inbox.create(
                [{ _id: envelope.id, type: envelope.type, stream, processedAt: new Date(), attempts: attempt, deliveries }],
                { session },
              );
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
        if (isInfraError(err)) throw err; // not an attempt — handled below
        log.warn({ err, eventId: envelope.id, type: envelope.type, stream, entryId, attempt, deliveries }, 'event handler failed');
        if (attempt >= maxAttempts) {
          await deadLetter(key, entryId, envelope.id, envelope, errMessage(err), attempt);
          return;
        }
        await recordFailure(stream, entryId, { a: attempt, d: deliveries, at: Date.now() });
      }
    } catch (err) {
      if (!isInfraError(err)) throw err;
      // outage: keep the attempt count, retry once the consumer resumes
      await recordFailure(stream, entryId, { a: prior, d: deliveries, at: Date.now(), i: true });
      enterPause(err);
    }
  }

  async function reclaim(): Promise<void> {
    for (const key of keys) {
      const stream = logicalByKey.get(key)!;
      let start = '-';
      for (let scanned = 0; scanned < 1000 && !stopping && !paused; ) {
        const rows = (await redis.xpending(key, group, 'IDLE', minClaimIdle, start, '+', 100)) as [string, string, number, number][];
        if (!rows.length) break;
        const fails = await redis.hmget(failKey, ...rows.map(([id]) => `${stream}|${id}`));
        for (let i = 0; i < rows.length && !stopping && !paused; i++) {
          const [id, , idle, deliveries] = rows[i]!;
          const f = fails[i] ? (JSON.parse(fails[i]!) as FailureRecord) : null;
          let required: number;
          if (f && f.d === deliveries) {
            // we know how this delivery ended
            required = f.i ? infraRetryMs : backoff(f.a);
            if (Date.now() < f.at + required) continue;
          } else {
            required = claimIdleMs; // crashed or still working
          }
          if (idle < required) continue;
          const claimed = (await redis.xclaim(key, group, consumerName, required, id)) as [string, string[] | null][];
          if (!claimed.length) {
            // another consumer got it first — or the entry was trimmed/deleted (Redis ≥ 7 drops those from the PEL on XCLAIM)
            if ((await redis.xrange(key, id, id)).length === 0) await trimmed(key, id, f);
            continue;
          }
          const [cid, cfields] = claimed[0]!;
          if (!cfields) {
            await trimmed(key, cid, f); // older Redis: returned as nil
            continue;
          }
          await processEntry(key, cid, cfields, deliveries + 1, f?.a ?? 0);
        }
        scanned += rows.length;
        if (rows.length < 100) break;
        start = `(${rows[rows.length - 1]![0]}`;
      }
    }
  }

  /** A pending entry no longer exists in the stream (MAXLEN trim / XDEL): make it visible, never drop silently. */
  async function trimmed(key: string, entryId: string, f: FailureRecord | null): Promise<void> {
    const stream = logicalByKey.get(key)!;
    log.error({ stream, entryId }, 'pending stream entry was trimmed before it was processed');
    await deadLetter(key, entryId, `${stream}:${entryId}`, null, 'stream entry trimmed/deleted before it was processed (event lost from the stream; check the producer outbox)', f?.a ?? 0);
  }

  const loop = (async () => {
    // setup, retried until it succeeds
    let setupDelay = 200;
    while (!stopping) {
      try {
        await initEventCollections(conn);
        await ensureGroups();
        markReady();
        break;
      } catch (err) {
        log.error({ err: errMessage(err) }, 'consumer setup failed; retrying');
        await sleep(setupDelay);
        setupDelay = Math.min(setupDelay * 2, 5000);
      }
    }
    let nextReclaimAt = 0;
    let errorDelay = 200;
    while (!stopping) {
      try {
        if (paused) {
          const wait = pausedUntil - Date.now();
          if (wait > 0) {
            await sleep(wait);
            continue;
          }
          if (!(await probe())) continue;
          paused = false;
          pauseDelay = infraBackoffMs;
          nextReclaimAt = 0;
          log.info('infrastructure back; consumer resumed');
        }
        if (Date.now() >= nextReclaimAt) {
          await reclaim();
          nextReclaimAt = Date.now() + reclaimEveryMs;
        }
        if (stopping || paused) continue;
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
              // unprocessed entries stay pending and are reclaimed later
              if (stopping || paused) break;
              await processEntry(key, entryId, fields, 1, 0);
            }
          }
        }
        errorDelay = 200;
      } catch (err) {
        if (stopping) break;
        if (isInfraError(err)) {
          enterPause(err);
          continue;
        }
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
        wake?.();
        reader.disconnect(); // interrupts a blocking XREADGROUP; in-flight handler is awaited below
        await loop;
        failReady(new Error('consumer stopped before setup completed'));
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
