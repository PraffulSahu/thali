/**
 * Fixed-window rate limiting in Redis (LLD 5.4). One atomic Lua script per hit:
 * `INCR key` → on first hit `PEXPIRE key window` → if the limit was just exceeded and `blockSec`
 * is set, extend the TTL to the block duration. Keys: `<REDIS_KEY_PREFIX>rl:<name>:<key>`.
 *
 * On 429 the response carries `Retry-After` (integer seconds) and a `RATE_LIMITED` envelope with
 * `details.retryAfterSec`. Successful responses carry `RateLimit-Limit` / `RateLimit-Remaining`.
 * If Redis is unavailable the limiter fails CLOSED (503 SERVICE_UNAVAILABLE) by default — required for
 * OTP / admin-login limits (LLD 5.4). Opt in to `failOpen: true` only for coarse limits (gateway global,
 * search), where availability matters more than strictness.
 */
import type { Request, RequestHandler } from 'express';
import { DomainError } from '@thali/contracts';
import { redisKey, type Redis } from './redis.js';

const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], window)
end
if count == limit + 1 and block > 0 then
  redis.call('PEXPIRE', KEYS[1], block)
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], window)
  ttl = window
end
return { count, ttl }
`;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window (or block) resets; integer ≥ 1. */
  retryAfterSec: number;
}

export interface ConsumeRateLimitOptions {
  redis: Redis;
  /** Unprefixed key, e.g. `otp:phone:+9190...`. Stored as `<prefix>rl:<key>`. */
  key: string;
  points: number;
  durationSec: number;
  blockSec?: number;
  keyPrefix?: string;
}

/** Count one hit against `key`. */
export async function consumeRateLimit(opts: ConsumeRateLimitOptions): Promise<RateLimitResult> {
  const fullKey = redisKey(opts.redis, `rl:${opts.key}`, opts.keyPrefix);
  const [count, ttlMs] = (await opts.redis.eval(
    SCRIPT,
    1,
    fullKey,
    String(opts.durationSec * 1000),
    String(opts.points),
    String((opts.blockSec ?? 0) * 1000),
  )) as [number, number];
  return {
    allowed: count <= opts.points,
    limit: opts.points,
    remaining: Math.max(0, opts.points - count),
    retryAfterSec: Math.max(1, Math.ceil(ttlMs / 1000)),
  };
}

export interface RateLimitOptions {
  redis: Redis;
  /** Returns the subject key (e.g. `req.ip`, userId); `null`/`undefined` skips limiting. */
  keyFn: (req: Request) => string | null | undefined | Promise<string | null | undefined>;
  points: number;
  durationSec: number;
  /** Lock the key out for this long once the limit is exceeded. */
  blockSec?: number;
  /** Namespace for this limiter (strongly recommended, e.g. `checkout-create`). Default `default`. */
  name?: string;
  keyPrefix?: string;
  /** Default false (503 when Redis errors). `true` lets traffic through and logs a warning. */
  failOpen?: boolean;
  message?: string;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const name = opts.name ?? 'default';
  return async (req, res, next) => {
    const subject = await opts.keyFn(req);
    if (subject === null || subject === undefined || subject === '') return next();
    let result: RateLimitResult;
    try {
      result = await consumeRateLimit({
        redis: opts.redis,
        key: `${name}:${subject}`,
        points: opts.points,
        durationSec: opts.durationSec,
        blockSec: opts.blockSec,
        keyPrefix: opts.keyPrefix,
      });
    } catch (err) {
      if (opts.failOpen !== true) {
        req.log?.error({ err, limiter: name }, 'rate limiter unavailable; failing closed');
        throw new DomainError('SERVICE_UNAVAILABLE', 'Rate limiter unavailable');
      }
      req.log?.warn({ err, limiter: name }, 'rate limiter unavailable; failing open');
      return next();
    }
    res.setHeader('RateLimit-Limit', String(result.limit));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      throw new DomainError('RATE_LIMITED', opts.message ?? 'Too many requests, please try again later', undefined, {
        retryAfterSec: result.retryAfterSec,
      });
    }
    next();
  };
}
