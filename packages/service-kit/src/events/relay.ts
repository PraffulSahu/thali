/**
 * Outbox relay (HLD 3.2): leader-locked (`lock:relay:<service>`), polls unpublished outbox rows in
 * `createdAt` order and publishes each with
 *   `XADD <EVENT_STREAM_PREFIX><row.stream> MAXLEN ~ <maxLen> * data <envelope JSON>`
 * then sets `publishedAt` — only for rows whose XADD succeeded. A crash between XADD and the mark
 * re-publishes the row on the next cycle; consumers dedupe by envelope id (inbox), so the delivery
 * guarantee is at-least-once with exactly-once effects. A failed XADD increments `attempts` and
 * stores `lastError`; the row stays pending and is retried every cycle.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import type { Logger } from 'pino';
import type { ServiceName } from '@thali/contracts';
import { startScheduler, type SchedulerRunContext } from '../scheduler.js';
import { streamKey } from './envelope.js';
import { initEventCollections, outboxModel, type OutboxRecord } from './models.js';

export const DEFAULT_STREAM_MAXLEN = 100_000;

export interface StartRelayOptions {
  conn: Connection;
  redis: Redis;
  logger: Logger;
  /** This service; leader lock is `<REDIS_KEY_PREFIX>lock:relay:<service>`. */
  service: ServiceName;
  /** `config.EVENT_STREAM_PREFIX` (default `''`). */
  streamPrefix?: string;
  /** Poll interval. Default 500 ms. */
  intervalMs?: number;
  /** Rows per batch. Default 100. */
  batch?: number;
  /** Approximate stream trim (`MAXLEN ~`). Default 100 000; `0` disables trimming. */
  maxLen?: number;
  /** Lock TTL. Default `max(intervalMs * 3, 3000)` (renewed every interval while running). */
  lockTtlMs?: number;
  instanceId?: string;
}

export interface RelayHandle {
  readonly instanceId: string;
  isLeader(): boolean;
  /** Stop polling, wait for the in-flight batch, release the lock. */
  stop(): Promise<void>;
}

/** Max consecutive full batches per tick before yielding to the next tick (renewal keeps running). */
const MAX_BATCHES_PER_TICK = 20;

export function startRelay(opts: StartRelayOptions): RelayHandle {
  const { conn, redis, logger, service } = opts;
  const intervalMs = opts.intervalMs ?? 500;
  const batch = opts.batch ?? 100;
  const maxLen = opts.maxLen ?? DEFAULT_STREAM_MAXLEN;
  const instanceId = opts.instanceId ?? randomUUID();
  const log = logger.child({ component: 'outbox-relay', instanceId });
  const Outbox = outboxModel(conn);
  let initialized: Promise<void> | null = null;

  async function publishBatch(rows: OutboxRecord[]): Promise<{ published: number; failed: number }> {
    const pipeline = redis.pipeline();
    for (const row of rows) {
      const key = streamKey(opts.streamPrefix, row.stream);
      const data = JSON.stringify(row.envelope);
      if (maxLen > 0) pipeline.xadd(key, 'MAXLEN', '~', maxLen, '*', 'data', data);
      else pipeline.xadd(key, '*', 'data', data);
    }
    let results: [Error | null, unknown][];
    try {
      results = ((await pipeline.exec()) ?? []) as [Error | null, unknown][];
    } catch (err) {
      results = rows.map(() => [err as Error, null]);
    }
    const ok: string[] = [];
    const failed: { id: string; error: string }[] = [];
    rows.forEach((row, i) => {
      const [err] = results[i] ?? [new Error('no reply')];
      if (err) failed.push({ id: row._id, error: err.message });
      else ok.push(row._id);
    });
    if (ok.length) await Outbox.updateMany({ _id: { $in: ok }, publishedAt: null }, { $set: { publishedAt: new Date() } });
    if (failed.length) {
      log.warn({ failed: failed.length, error: failed[0]!.error }, 'outbox publish failed; will retry');
      await Outbox.bulkWrite(
        failed.map((f) => ({ updateOne: { filter: { _id: f.id }, update: { $inc: { attempts: 1 }, $set: { lastError: f.error } } } })),
        { ordered: false },
      );
    }
    return { published: ok.length, failed: failed.length };
  }

  async function run(ctx: SchedulerRunContext): Promise<void> {
    initialized ??= initEventCollections(conn).catch((err) => {
      initialized = null;
      throw err;
    });
    await initialized;
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      if (ctx.signal.aborted || !ctx.isLeader()) return;
      const rows = await Outbox.find({ publishedAt: null }).sort({ createdAt: 1, _id: 1 }).limit(batch).lean<OutboxRecord[]>();
      if (!rows.length) return;
      const { failed } = await publishBatch(rows);
      if (failed || rows.length < batch) return;
    }
  }

  const scheduler = startScheduler({
    redis,
    name: `relay:${service}`,
    intervalMs,
    lockTtlMs: opts.lockTtlMs ?? Math.max(intervalMs * 3, 3000),
    instanceId,
    run,
    logger: log,
  });

  return {
    instanceId,
    isLeader: () => scheduler.isLeader(),
    stop: () => scheduler.stop(),
  };
}
