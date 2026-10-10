/**
 * Event consumer registry. Task 8 consumes no events; Task 9 adds a module (e.g.
 * `commerce-handlers.ts` for checkout.confirmed / checkout.released / order.rejected / order.cancelled
 * / payment.captured|failed) to `handlerModules`. `index.ts` starts a consumer only when at least one
 * handler is registered.
 */
import type { EventHandlers } from '@thali/service-kit';
import type { AppContext } from '../context.js';
import { commerceHandlerModule } from './commerce-handlers.js';

export interface EventHandlerModule {
  name: string;
  /** Logical streams consumed, e.g. `events.orders`. */
  streams: string[];
  handlers(ctx: AppContext): EventHandlers;
}

export const handlerModules: EventHandlerModule[] = [commerceHandlerModule];

export function buildEventHandlers(ctx: AppContext, modules: EventHandlerModule[] = handlerModules) {
  const handlers: EventHandlers = {};
  const streams = new Set<string>();
  for (const m of modules) {
    for (const s of m.streams) streams.add(s);
    for (const [type, fn] of Object.entries(m.handlers(ctx))) {
      if ((handlers as Record<string, unknown>)[type]) throw new Error(`duplicate handler for ${type} (${m.name})`);
      (handlers as Record<string, unknown>)[type] = fn;
    }
  }
  return { handlers, streams: [...streams] };
}
