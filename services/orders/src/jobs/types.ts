/** Leader-elected periodic jobs (service-kit `startScheduler`); `jobs/index.ts` lists them. */
import type { SchedulerRunContext } from '@thali/service-kit';
import type { OrdersConfig } from '../config.js';
import type { OrdersContext } from '../context.js';

export interface JobModule {
  /** Scheduler lock name, e.g. `orders:checkout-expiry`. */
  name: string;
  intervalMs(config: OrdersConfig): number;
  run(ctx: OrdersContext, run: SchedulerRunContext): Promise<void>;
}
