/**
 * Post-commit realtime publishing. Realtime is ephemeral and must never be sent for a transaction
 * that aborts, so domain functions that run inside a session (route transactions, event handlers,
 * sweepers) queue messages with `queueRealtime(session, …)`; they are published when the session
 * ends with a committed transaction. Each transaction attempt resets the queue, so a retried
 * callback never double-publishes.
 */
import type { ClientSession } from 'mongoose';
import { publishRealtime, realtimeChannel, type Redis } from '@thali/service-kit';
import type { Logger } from 'pino';

interface Pending {
  channel: string;
  event: string;
  data: unknown;
}
interface SessionQueue {
  attemptKey: unknown;
  items: Pending[];
}

const queues = new WeakMap<ClientSession, SessionQueue>();

function txnNumber(session: ClientSession): unknown {
  // the driver creates a new Transaction object on every startTransaction (i.e. every attempt)
  return (session as unknown as { transaction?: unknown }).transaction;
}

/** Queue a realtime message to publish once `session`'s transaction has committed. */
export function queueRealtime(
  session: ClientSession,
  redis: Redis,
  logger: Logger,
  channel: string,
  event: string,
  data: unknown,
): void {
  let q = queues.get(session);
  const attemptKey = txnNumber(session);
  if (!q) {
    q = { attemptKey, items: [] };
    queues.set(session, q);
    session.once('ended', () => {
      const queue = queues.get(session);
      queues.delete(session);
      const committed = (session as unknown as { transaction?: { isCommitted?: boolean } }).transaction?.isCommitted;
      if (!queue || !committed) return;
      for (const m of queue.items) {
        publishRealtime(redis, m.channel, m.event, m.data).catch((err) =>
          logger.warn({ err, channel: m.channel, event: m.event }, 'realtime publish failed'),
        );
      }
    });
  } else if (q.attemptKey !== attemptKey) {
    // a new transaction attempt on the same session: drop messages from the aborted attempt
    q.attemptKey = attemptKey;
    q.items = [];
  }
  q.items.push({ channel, event, data });
}

export interface OrderUpdatedData {
  checkoutId: string;
  childOrderId: string | null;
  status: string;
  checkoutStatus: string;
  refundStatus: string | null;
  deliveryStatus: string | null;
}

/** LLD §11 `order.updated` → `user:<userId>`. */
export function queueOrderUpdated(session: ClientSession, redis: Redis, logger: Logger, userId: string, data: OrderUpdatedData): void {
  queueRealtime(session, redis, logger, realtimeChannel.user(userId), 'order.updated', data);
}
