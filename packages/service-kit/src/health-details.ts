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
/** Hash `<prefix>provider_last_error:<service>`: field = provider, value = JSON `{message, at}` (at = epoch ms). */
const providerLastErrorKey = (redis: Redis, service: string) => redisKey(redis, `provider_last_error:${service}`);

/** Max stored length of a provider error message. */
export const PROVIDER_MESSAGE_MAX = 300;

/**
 * Make a provider error message safe to show on the admin health page: removes e-mail addresses,
 * phone numbers (10+ digits, optional +), bearer tokens and secret-looking query/header values
 * (`key=`, `token=`, `secret=`, `password=`, `signature=`, `api_key=`, ...). Keeps infra detail
 * such as hosts/IPs/ports. Caps the result at `PROVIDER_MESSAGE_MAX` chars.
 */
export function scrubProviderMessage(message: string): string {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [redacted]')
    .replace(/\b((?:api[_-]?)?key|token|access_token|secret|password|passwd|pwd|signature|sig|auth)=([^&\s"']+)/gi, '$1=[redacted]')
    .replace(/(?<![\w.:])\+?\d[\d -]{8,}\d(?![\w.:])/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[phone]' : m))
    .slice(0, PROVIDER_MESSAGE_MAX);
}

// Keep the newest message per provider: an older `at` never replaces a newer one.
const SET_LAST_ERROR_LUA = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local ok, obj = pcall(cjson.decode, cur)
  if ok and type(obj) == 'table' and tonumber(obj.at) and tonumber(obj.at) > tonumber(ARGV[2]) then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
`;

/**
 * Record one provider failure (sorted set `<prefix>provider_errors:<service>`, score = time; entries
 * older than 1 h are trimmed on every write/read). `provider` e.g. `google-routes`, `twilio`, `razorpay`.
 * The last message per provider (scrubbed, `null` when not given) is kept in
 * `<prefix>provider_last_error:<service>` (1 h TTL) and surfaced as `healthDetails().lastProviderErrors` (GW-1).
 */
export async function recordProviderError(
  redis: Redis,
  service: ServiceName | string,
  provider: string,
  at: number = Date.now(),
  message?: string | null,
): Promise<void> {
  const key = providerErrorKey(redis, service);
  await redis
    .multi()
    .zadd(key, at, `${at}|${provider}|${randomBytes(4).toString('hex')}`)
    .zremrangebyscore(key, '-inf', `(${Date.now() - HOUR_MS}`)
    .pexpire(key, 2 * HOUR_MS)
    .exec();
  if (at < Date.now() - HOUR_MS) return; // already outside the reporting window
  const value = JSON.stringify({ message: message ? scrubProviderMessage(String(message)) : null, at });
  await redis.eval(SET_LAST_ERROR_LUA, 1, providerLastErrorKey(redis, service), provider, String(at), value, String(HOUR_MS));
}

export interface ProviderLastError {
  /** Scrubbed message, or null when the failure was recorded without one. */
  message: string | null;
  /** ISO time of the failure. */
  at: string;
}

/** Last error per provider within the last hour (`{}` when none). */
export async function providerLastErrors(redis: Redis, service: ServiceName | string): Promise<Record<string, ProviderLastError>> {
  const raw = await redis.hgetall(providerLastErrorKey(redis, service));
  const since = Date.now() - HOUR_MS;
  const out: Record<string, ProviderLastError> = {};
  for (const [provider, v] of Object.entries(raw)) {
    try {
      const o = JSON.parse(v) as { message?: unknown; at?: unknown };
      const at = Number(o.at);
      if (!Number.isFinite(at) || at < since) continue;
      out[provider] = { message: typeof o.message === 'string' ? o.message : null, at: new Date(at).toISOString() };
    } catch {
      // ignore a corrupt entry
    }
  }
  return out;
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
  /** Last scrubbed error per provider in the last hour (GW-1); null if Redis is down. */
  lastProviderErrors: Record<string, ProviderLastError> | null;
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

  const [mongo, redisPing, pending, oldest, dead, providers, lastErrors, ...lags] = await Promise.all([
    probe(async () => {
      if (!conn.db) throw new Error('not connected');
      await conn.db.admin().ping();
    }, timeoutMs),
    probe(() => redis.ping(), timeoutMs),
    probe(() => Outbox.countDocuments({ publishedAt: null }).maxTimeMS(timeoutMs), timeoutMs),
    probe(() => Outbox.findOne({ publishedAt: null }).sort({ createdAt: 1 }).select({ createdAt: 1 }).maxTimeMS(timeoutMs).lean(), timeoutMs),
    probe(() => deadLetterModel(conn).countDocuments({ replayedAt: null }).maxTimeMS(timeoutMs), timeoutMs),
    probe(() => providerErrorStats(redis, service), timeoutMs),
    probe(() => providerLastErrors(redis, service), timeoutMs),
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
    lastProviderErrors: lastErrors.ok ? (lastErrors.value as Record<string, ProviderLastError>) : null,
    checkedAt: new Date().toISOString(),
  };
}
