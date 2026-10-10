/**
 * Realtime fan-out over Redis pub/sub (HLD 3.3, LLD 11). Ephemeral: not durable, never call inside a
 * Mongo transaction — publish after commit (or from an event handler after its transaction).
 *
 * Channel names (unprefixed): `user:<userId>`, `owner:<ownerUserId>`, `partner:<partnerUserId>`, `admin`.
 * Redis channel: `<REDIS_KEY_PREFIX>rt:<channel>`; message JSON `{ event, data }` where `event` is the
 * SSE event name (`order.updated`, `owner.order`, `delivery.location`, `partner.offer`, `notification`).
 */
import type { Redis } from 'ioredis';
import { redisKey } from './redis.js';

export const realtimeChannel = {
  user: (userId: string) => `user:${userId}`,
  owner: (ownerUserId: string) => `owner:${ownerUserId}`,
  partner: (partnerUserId: string) => `partner:${partnerUserId}`,
  admin: () => 'admin',
} as const;

export interface RealtimeMessage<D = unknown> {
  event: string;
  data: D;
}

/** `PUBLISH <prefix>rt:<channel> {"event","data"}`; resolves to the number of receiving subscribers. */
export async function publishRealtime(redis: Redis, channel: string, event: string, data: unknown, opts: { keyPrefix?: string } = {}): Promise<number> {
  return redis.publish(redisKey(redis, `rt:${channel}`, opts.keyPrefix), JSON.stringify({ event, data }));
}

export interface RealtimeSubscription {
  close(): Promise<void>;
}

const escapeGlob = (s: string) => s.replace(/[*?[\]\\]/g, (c) => `\\${c}`);

/**
 * PSUBSCRIBE `<prefix>rt:<pattern>` for each pattern (glob: `user:*`, `owner:*`, `partner:*`, `admin`)
 * on a dedicated connection. `onMessage(channel, msg)` gets the unprefixed channel (`user:u1`).
 * Malformed messages are dropped; errors thrown by `onMessage` are swallowed.
 */
export async function subscribeRealtime(
  redis: Redis,
  patterns: string[],
  onMessage: (channel: string, msg: RealtimeMessage) => void,
  opts: { keyPrefix?: string; onError?: (err: unknown) => void } = {},
): Promise<RealtimeSubscription> {
  const prefix = redisKey(redis, 'rt:', opts.keyPrefix);
  const sub = redis.duplicate();
  sub.on('error', (err) => opts.onError?.(err));
  sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    if (!channel.startsWith(prefix)) return;
    let msg: RealtimeMessage;
    try {
      msg = JSON.parse(message) as RealtimeMessage;
      if (!msg || typeof msg.event !== 'string') return;
    } catch {
      return;
    }
    try {
      onMessage(channel.slice(prefix.length), msg);
    } catch (err) {
      opts.onError?.(err);
    }
  });
  await sub.psubscribe(...patterns.map((p) => escapeGlob(prefix) + p));
  return {
    async close() {
      try {
        await sub.quit();
      } catch {
        sub.disconnect();
      }
    },
  };
}
