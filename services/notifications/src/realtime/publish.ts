/** Notification-side realtime publisher: ephemeral pushes to the SSE hub via Redis pub/sub (LLD §11). */
import type { Logger } from 'pino';
import { publishRealtime, realtimeChannel, type Redis } from '@thali/service-kit';

export interface NotificationPush {
  id: string;
  title: string;
  body: string;
}

export interface RealtimePublisher {
  toUser(userId: string, event: string, data: unknown): Promise<void>;
  toAdmin(event: string, data: unknown): Promise<void>;
}

/** Failures are logged, never thrown: realtime is best-effort, clients fall back to polling. */
export function createRealtimePublisher(redis: Redis, logger: Logger): RealtimePublisher {
  const safe = async (channel: string, event: string, data: unknown) => {
    try {
      await publishRealtime(redis, channel, event, data);
    } catch (err) {
      logger.warn({ err, channel: channel.split(':')[0], event }, 'realtime publish failed');
    }
  };
  return {
    toUser: (userId, event, data) => safe(realtimeChannel.user(userId), event, data),
    toAdmin: (event, data) => safe(realtimeChannel.admin(), event, data),
  };
}
