/** Event modules: each area contributes the streams it reads and its handlers (merged by `events/index.ts`). */
import type { EventHandlers } from '@thali/service-kit';
import type { OrdersContext } from '../context.js';

export interface EventModule {
  name: string;
  /** Logical stream names, e.g. `events.payments`. */
  streams: string[];
  handlers(ctx: OrdersContext): EventHandlers;
}
