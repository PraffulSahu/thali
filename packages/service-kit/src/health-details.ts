/**
 * `/internal/health/details` data (HLD 8): every value is measured live, each probe with a timeout;
 * a failing probe yields `'down'` / `null` instead of throwing.
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import { consumerGroup, type AppMode, type ServiceName } from '@thali/contracts';
import { redisKey } from './redis.js';
import { streamKey } from './events/envelope.js';
import { deadLetterModel, outboxModel } from './events/models.js';

const HOUR_MS = 3600_000;

const providerErrorKey = (redis: Redis, service: string) => redisKey(redis, `provider_errors:${service}`);

/**
 * Record one provider failure (sorted set `<prefix>provider_errors:<service>`, score = time; entries
 * older than 1 h are trimmed on every write/read). `provider` e.g. `google-routes`, `twilio`, `razorpay`.
 */
export async function recordProviderError(redis: Redis, service: ServiceName | string, provider: string, at: number = Date.now()): Promise<void> {
  const key = providerErrorKey(redis, service);
  await redis
    .multi()
    .zadd(key, at, `${at}|${provider}|${randomBytes(4).toString('hex')}`)
    .zremrangebyscore(key, '-inf', `(${Date.now() - HOUR_MS}`)
    .pexpire(key, 2 * HOUR_MS)
    .exec();
}

/** Provider errors in the last hour: total + per provider. */
export async function providerErrorStats(redis: Redis, service: ServiceName | string): Promise<{ total: number; byProvider: Record<string, number> }> {
  const key = providerErrorKey(redis, service);
  const since = Date.now() - HOUR_MS;
  const [, members] = (await redis.multi().zremrangebyscore(key, '-inf', `(${since}`).zrangebyscore(key, since, '+inf').exec())!;
  if (members[0]) throw members[0];
  const list = members[1] as string[];
  const byProvider: Record<string, number> = {};
  for (const m of list) {
    const provider = m.slice(m.indexOf('|') + 1, m.lastIndexOf('|'));
    byProvider[provider] = (byProvider[provider] ?? 0) + 1;
  }
  return { total: list.length, byProvider };
}

export interface HealthDetailsOptions {
  conn: Connection;
  redis: Redis;
  service: ServiceName;
  /** `config.APP_MODE` (default `process.env.APP_MODE`, else `demo`). */
  mode?: AppMode;
  /** Logical streams this service consumes (lag reported for group `cg.<service>`). */
  streams?: string[];
  /** `config.EVENT_STREAM_PREFIX`. */
  streamPrefix?: string;
  /** Per-probe timeout. Default 2000 ms. */
  timeoutMs?: number;
}

export interface HealthDetails {
  service: ServiceName;
  mode: AppMode;
  mongo: 'up' | 'down';
  redis: 'up' | 'down';
  /** Unpublished outbox rows (null if Mongo is down). */
  outboxPending: number | null;
  /** Age of the oldest unpublished row in seconds; null if none or Mongo down. */
  outboxOldestAgeSec: number | null;
  /** Per consumed stream: entries not yet delivered to the group (`lag`) + delivered but unacked (`pending`); null if unknown. */
  consumerLag: Record<string, number | null>;
  /** Dead letters not yet replayed (null if Mongo is down). */
  deadLetters: number | null;
  providerErrorsLastHour: number | null;
  providerErrorsByProvider: Record<string, number> | null;
  checkedAt: string;
}

async function probe<T>(fn: () => Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function groupLag(redis: Redis, key: string, group: string): Promise<number | null> {
  const rows = (await redis.xinfo('GROUPS', key)) as unknown[][];
  for (const row of rows) {
    const o: Record<string, unknown> = {};
    for (let i = 0; i + 1 < row.length; i += 2) o[String(row[i])] = row[i + 1];
    if (o.name !== group) continue;
    const pending = Number(o.pending ?? 0);
    if (o.lag === null || o.lag === undefined) return pending; // Redis cannot compute lag (e.g. after XDEL)
    return Number(o.lag) + pending;
  }
  return null;
}

export async function healthDetails(opts: HealthDetailsOptions): Promise<HealthDetails> {
  const { conn, redis, service, timeoutMs = 2000 } = opts;
  const mode = opts.mode ?? ((process.env.APP_MODE as AppMode | undefined) || 'demo');
  const streams = opts.streams ?? [];
  const group = consumerGroup(service);
  const Outbox = outboxModel(conn);

  const [mongo, redisPing, pending, oldest, dead, providers, ...lags] = await Promise.all([
    probe(async () => {
      if (!conn.db) throw new Error('not connected');
      await conn.db.admin().ping();
    }, timeoutMs),
    probe(() => redis.ping(), timeoutMs),
    probe(() => Outbox.countDocuments({ publishedAt: null }).maxTimeMS(timeoutMs), timeoutMs),
    probe(() => Outbox.findOne({ publishedAt: null }).sort({ createdAt: 1 }).select({ createdAt: 1 }).maxTimeMS(timeoutMs).lean(), timeoutMs),
    probe(() => deadLetterModel(conn).countDocuments({ replayedAt: null }).maxTimeMS(timeoutMs), timeoutMs),
    probe(() => providerErrorStats(redis, service), timeoutMs),
    ...streams.map((s) => probe(() => groupLag(redis, streamKey(opts.streamPrefix, s), group), timeoutMs)),
  ]);

  const consumerLag: Record<string, number | null> = {};
  streams.forEach((s, i) => {
    const r = lags[i]!;
    consumerLag[s] = r.ok ? (r.value as number | null) : null;
  });
  const oldestDoc = oldest.ok ? (oldest.value as { createdAt?: Date } | null) : null;

  return {
    service,
    mode,
    mongo: mongo.ok ? 'up' : 'down',
    redis: redisPing.ok ? 'up' : 'down',
    outboxPending: pending.ok ? (pending.value as number) : null,
    outboxOldestAgeSec: oldestDoc?.createdAt ? Math.max(0, Math.floor((Date.now() - new Date(oldestDoc.createdAt).getTime()) / 1000)) : null,
    consumerLag,
    deadLetters: dead.ok ? (dead.value as number) : null,
    providerErrorsLastHour: providers.ok ? (providers.value as { total: number }).total : null,
    providerErrorsByProvider: providers.ok ? (providers.value as { byProvider: Record<string, number> }).byProvider : null,
    checkedAt: new Date().toISOString(),
  };
}
