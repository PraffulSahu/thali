/**
 * Orders event consumption: one consumer (group `cg.orders`) over the union of every module's
 * streams with the merged handler map. Task 12: append `deliveryEventsModule`,
 * `refundEventsModule`, `restaurantEventsModule` to `eventModules`.
 */
import { startConsumer, type ConsumerHandle, type EventHandlers, type StartConsumerOptions } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';
import { paymentEventsModule } from './payment-handlers.js';
import { deliveryEventsModule } from './delivery-handlers.js';
import { refundEventsModule } from './refund-handlers.js';
import { restaurantEventsModule } from './restaurant-handlers.js';
import type { EventModule } from './types.js';

export const eventModules: EventModule[] = [paymentEventsModule, deliveryEventsModule, refundEventsModule, restaurantEventsModule];

export function consumedStreams(modules: EventModule[] = eventModules): string[] {
  return [...new Set(modules.flatMap((m) => m.streams))];
}

export function buildEventHandlers(ctx: OrdersContext, modules: EventModule[] = eventModules): EventHandlers {
  const merged: Record<string, unknown> = {};
  for (const m of modules) {
    for (const [type, handler] of Object.entries(m.handlers(ctx))) {
      if (merged[type]) throw new Error(`orders: two event modules handle ${type}`);
      merged[type] = handler;
    }
  }
  return merged as EventHandlers;
}

type Tuning = Partial<Pick<StartConsumerOptions, 'maxAttempts' | 'claimIdleMs' | 'backoffBaseMs' | 'maxBackoffMs' | 'blockMs' | 'batch'>>;

export function startOrdersConsumers(ctx: OrdersContext, tuning: Tuning = {}, modules: EventModule[] = eventModules): ConsumerHandle[] {
  return [
    startConsumer({
      conn: ctx.conn,
      redis: ctx.redis,
      logger: ctx.logger,
      service: 'orders',
      streamPrefix: ctx.config.EVENT_STREAM_PREFIX,
      streams: consumedStreams(modules),
      handlers: buildEventHandlers(ctx, modules),
      ...tuning,
    }),
  ];
}

export type { EventModule };
