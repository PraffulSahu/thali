/** Outbox helper: every orders event goes to `events.orders` inside the caller's transaction. */
import type { ClientSession } from 'mongoose';
import type { EventPayloads, EventType } from '@thali/contracts';
import { emitEvent } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';

export function emitOrdersEvent<T extends EventType>(
  ctx: Pick<OrdersContext, 'conn'>,
  session: ClientSession,
  type: T,
  payload: EventPayloads[T],
  aggregateId: string,
  correlationId?: string,
) {
  return emitEvent(ctx.conn, session, type, payload, {
    producer: 'orders',
    aggregateId,
    ...(correlationId ? { correlationId } : {}),
  });
}
